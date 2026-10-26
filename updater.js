// Update checker for the installed (packaged, Windows) app.
// Asks GitHub for the latest release, compares it with app.getVersion(), and on request downloads
// SportsChud-Setup.exe from that release and opens it. SportsChud keeps running while the installer opens;
// once it has been opened, quitting SportsChud shuts everything down (see main.js). No dependencies: Node's built-in fetch and
// Electron's shell. Does nothing when run from source (npm start / Start-SportsChud.bat).
const { app, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const REPO = 'Vibeology/SportsChud'; // GitHub "owner/repo" that publishes the releases
const ASSET = 'SportsChud-Setup.exe';

// Only ever download the installer from a GitHub release asset URL (works even if the account or repo is renamed)
const isReleaseUrl = (u) => {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && url.hostname === 'github.com' && url.pathname.includes('/releases/download/') && url.pathname.endsWith('/' + ASSET);
  } catch (_) { return false; }
};
const FIRST_CHECK_MS = 20 * 1000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

const parseVer = (v) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
const isNewer = (a, b) => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
};

// A downloaded installer must be a real Windows executable of a sensible size ("MZ" header), not an error page
function looksLikeInstaller(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(2);
    fs.readSync(fd, head, 0, 2, 0);
    return head.toString('latin1') === 'MZ' && fs.fstatSync(fd).size > 1024 * 1024;
  } finally {
    fs.closeSync(fd);
  }
}

// Old downloads pile up in the temp folder; keep only the one in use
function cleanOldInstallers(keep) {
  try {
    const dir = app.getPath('temp');
    for (const f of fs.readdirSync(dir)) {
      if (/^SportsChud-Setup-.*\.exe(\.part)?$/.test(f) && path.join(dir, f) !== keep) { try { fs.unlinkSync(path.join(dir, f)); } catch (_) {} }
    }
  } catch (_) {}
}

class Updater {
  // getSettings: () => settings; onChange(state): push to the window; onAvailable(version): show a toast;
  // onInstallerOpened(): called once the installer has been downloaded, checked and opened
  constructor({ getSettings, onChange, onAvailable, onInstallerOpened }) {
    this.getSettings = getSettings;
    this.onChange = onChange;
    this.onAvailable = onAvailable;
    this.onInstallerOpened = onInstallerOpened;
    this.asset = null;
    this.notified = null;
    this.timers = [];
    this.lastEmit = 0;
    this.state = {
      supported: app.isPackaged && process.platform === 'win32',
      current: app.getVersion(),
      checking: false,
      available: false,
      version: null,
      downloading: false,
      installing: false, // the installer has been opened (SportsChud stays open until the user quits)
      progress: 0,
      error: null,
      checkedAt: null
    };
  }

  emit(force = true) {
    const now = Date.now();
    if (!force && now - this.lastEmit < 250) return; // throttle download progress
    this.lastEmit = now;
    try { this.onChange({ ...this.state }); } catch (_) {}
  }

  start() {
    if (!this.state.supported) return;
    const auto = () => { if (this.getSettings().checkForUpdates !== false) this.check(); };
    this.timers.push(setTimeout(auto, FIRST_CHECK_MS));
    this.timers.push(setInterval(auto, CHECK_EVERY_MS));
  }

  stop() {
    this.timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
    this.timers = [];
  }

  async check({ manual = false } = {}) {
    if (!this.state.supported || this.state.checking || this.state.downloading || this.state.installing) return this.state; // the installer is open: nothing to look for
    this.state.checking = true;
    this.state.error = null;
    if (manual) this.emit();
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { 'User-Agent': 'SportsChud', Accept: 'application/vnd.github+json' }
      });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const rel = await res.json();
      const latest = parseVer(rel.tag_name);
      const current = parseVer(app.getVersion());
      const asset = (rel.assets || []).find((a) => a.name === ASSET);
      const ok = latest && current && asset && isReleaseUrl(asset.browser_download_url);
      if (ok && isNewer(latest, current)) {
        this.asset = asset;
        this.state.available = true;
        this.state.version = latest.join('.');
        if (this.notified !== this.state.version) {
          this.notified = this.state.version;
          try { this.onAvailable(this.state.version); } catch (_) {}
        }
      } else {
        this.asset = null;
        this.state.available = false;
        this.state.version = null;
      }
      this.state.checkedAt = Date.now();
    } catch (err) {
      this.state.error = err.message;
    }
    this.state.checking = false;
    this.emit();
    return this.state;
  }

  async install() {
    if (this.state.downloading) return this.state;
    // The installer is already downloaded and was opened: clicking again just opens it again (for example after
    // the permission prompt was declined), without downloading a second copy over it
    if (this.state.installing && this.installerPath) {
      if (!fs.existsSync(this.installerPath)) { this.state.installing = false; this.state.error = 'The downloaded installer is gone, click Install update to download it again'; this.emit(); return this.state; }
      const err = await shell.openPath(this.installerPath);
      this.state.error = err ? `Couldn't start the installer: ${err}` : null;
      this.emit();
      return this.state;
    }
    if (!this.state.available || !this.asset) return this.state;
    this.state.downloading = true;
    this.state.progress = 0;
    this.state.error = null;
    this.emit();
    const dest = path.join(app.getPath('temp'), `SportsChud-Setup-${this.state.version}.exe`);
    const part = dest + '.part';
    let handedOver = false;
    try {
      cleanOldInstallers(dest);
      const res = await fetch(this.asset.browser_download_url, { headers: { 'User-Agent': 'SportsChud' } });
      if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
      const total = Number(res.headers.get('content-length')) || this.asset.size || 0;
      let got = 0;
      const hash = crypto.createHash('sha256');
      const src = Readable.fromWeb(res.body);
      src.on('data', (chunk) => {
        got += chunk.length;
        hash.update(chunk);
        if (total) this.state.progress = Math.min(99, Math.floor((got / total) * 100));
        this.emit(false);
      });
      await pipeline(src, fs.createWriteStream(part));
      if (this.asset.size && got !== this.asset.size) throw new Error('Download was incomplete, try again');
      if (!looksLikeInstaller(part)) throw new Error("The download isn't a valid installer, try again");
      // GitHub publishes a SHA-256 for release assets ("sha256:<hex>"); when it's there, the file has to match it
      const m = /^sha256:([0-9a-f]{64})$/i.exec(String(this.asset.digest || ''));
      if (m && hash.digest('hex') !== m[1].toLowerCase()) throw new Error("The download doesn't match GitHub's checksum, try again");
      // Only a complete, checked file gets the real name, so a half-written installer can never be launched
      try { fs.unlinkSync(dest); } catch (_) {}
      fs.renameSync(part, dest);
      this.state.progress = 100;
      this.state.downloading = false;
      // Open the installer through Windows' normal launcher (so it can ask for administrator permission).
      // SportsChud stays open; the installer deals with it, and quitting SportsChud now closes everything.
      const err = await shell.openPath(dest);
      if (err) throw new Error(`Couldn't start the installer: ${err}`);
      handedOver = true; // the installer file must stay where it is
      this.installerPath = dest;
      this.state.installing = true; // installer opened
      this.state.available = true;
      this.emit();
      try { this.onInstallerOpened(); } catch (_) {}
      return this.state;
    } catch (err) {
      this.state.error = err.message;
      if (!handedOver) { try { fs.unlinkSync(part); } catch (_) {} try { fs.unlinkSync(dest); } catch (_) {} }
    }
    this.state.downloading = false;
    this.state.installing = false;
    this.emit();
    return this.state;
  }
}

module.exports = { Updater, parseVer, isNewer, looksLikeInstaller };
