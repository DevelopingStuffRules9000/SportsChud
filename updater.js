// Update checker for the installed (packaged, Windows) app.
// Asks GitHub for the latest release, compares it with app.getVersion(), and on request downloads
// SportsChud-Setup.exe from that release and runs it. No dependencies: Node's built-in fetch and
// Electron's shell. Does nothing when run from source (npm start / Start-SportsChud.bat).
const { app, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const REPO = 'Vibedea/SportsChud'; // GitHub "owner/repo" that publishes the releases
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

class Updater {
  // getSettings: () => settings; onChange(state): push to the window; onAvailable(version): show a toast;
  // beforeQuit(): called once the installer has started, so the app can close and let it replace files
  constructor({ getSettings, onChange, onAvailable, beforeQuit }) {
    this.getSettings = getSettings;
    this.onChange = onChange;
    this.onAvailable = onAvailable;
    this.beforeQuit = beforeQuit;
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
    if (!this.state.supported || this.state.checking || this.state.downloading) return this.state;
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
    if (!this.state.available || !this.asset || this.state.downloading) return this.state;
    this.state.downloading = true;
    this.state.progress = 0;
    this.state.error = null;
    this.emit();
    const dest = path.join(app.getPath('temp'), `SportsChud-Setup-${this.state.version}.exe`);
    try {
      const res = await fetch(this.asset.browser_download_url, { headers: { 'User-Agent': 'SportsChud' } });
      if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
      const total = Number(res.headers.get('content-length')) || this.asset.size || 0;
      let got = 0;
      const src = Readable.fromWeb(res.body);
      src.on('data', (chunk) => {
        got += chunk.length;
        if (total) this.state.progress = Math.min(99, Math.floor((got / total) * 100));
        this.emit(false);
      });
      await pipeline(src, fs.createWriteStream(dest));
      if (this.asset.size && got !== this.asset.size) throw new Error('Download was incomplete, try again');
      this.state.progress = 100;
      this.emit();
      // shell.openPath goes through Windows' normal launcher, so the installer can ask for administrator permission
      const err = await shell.openPath(dest);
      if (err) throw new Error(`Couldn't start the installer: ${err}`);
      this.beforeQuit();
    } catch (err) {
      this.state.error = err.message;
      try { fs.unlinkSync(dest); } catch (_) {}
    }
    this.state.downloading = false;
    this.emit();
    return this.state;
  }
}

module.exports = { Updater, parseVer, isNewer };
