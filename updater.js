// Update checker for the installed (packaged, Windows) app.
// Asks GitHub for the latest release, compares it with app.getVersion(), and on request downloads
// SportsChud-Setup.exe from that release and runs it. No dependencies: Node's built-in fetch and
// Electron's shell. Does nothing when run from source (npm start / Start-SportsChud.bat).
const { app, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
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

// The installer replaces SportsChud's files, so SportsChud must be completely gone before it starts (its own
// "is the app still running?" check fires the moment it launches). Starting it from inside the app is therefore a race.
// Instead a small helper script runs OUTSIDE the app: it waits until every SportsChud process has exited (force-closing
// any that hang), then starts the installer through Windows' normal launcher so it can ask for administrator permission.
// - A start that fails for another reason than "permission declined" is retried (antivirus often holds a fresh download).
// - Everything it does goes to update.log, and its verdict to update-result.json, which the app reads on its next start.
// - If the installer can't be started, it opens SportsChud again so the user isn't left with nothing running.
// PowerShell is tried first; if it can't be started, an equivalent .cmd script is used.
// Resolves with the helper's name once it is running; rejects if neither could be started.
const PS_SCRIPT = [
  "$ErrorActionPreference = 'Continue'",
  '$name = $env:SC_NAME; $inst = $env:SC_INSTALLER; $exe = $env:SC_EXE; $log = $env:SC_LOG; $res = $env:SC_RESULT',
  'function L($m) { try { Add-Content -LiteralPath $log -Value ((Get-Date -Format s) + " " + $m) } catch {} }',
  'function R($ok, $m) { try { Set-Content -LiteralPath $res -Value (@{ ok = $ok; message = $m; at = (Get-Date -Format s) } | ConvertTo-Json -Compress) } catch {} }',
  'L ("helper (powershell) started, waiting for " + $name + " to exit")',
  '$deadline = (Get-Date).AddSeconds(45)',
  'while ((Get-Process -Name $name -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }',
  'if (Get-Process -Name $name -ErrorAction SilentlyContinue) { L "still running after 45 s, stopping it"; Get-Process -Name $name -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2 }',
  'Start-Sleep -Seconds 1',
  '$started = $false; $why = ""',
  'for ($i = 1; $i -le 5 -and -not $started; $i++) {',
  '  try { Start-Process -FilePath $inst -ErrorAction Stop; $started = $true; L ("installer started (attempt " + $i + ")") }',
  '  catch { $why = $_.Exception.Message; L ("attempt " + $i + " failed: " + $why); if ($why -match "cancel") { break }; Start-Sleep -Seconds 2 }',
  '}',
  'if ($started) { R $true "started" } else { R $false $why; L "installer did not start, reopening SportsChud"; try { Start-Process -FilePath $exe } catch { L ("reopen failed: " + $_.Exception.Message) } }'
].join('\n');

const CMD_SCRIPT = [
  '@echo off',
  'setlocal',
  'set /a n=0',
  'echo %date% %time% helper (cmd) started >> "%SC_LOG%"',
  ':wait',
  'tasklist /FI "IMAGENAME eq %SC_IMAGE%" 2>nul | find /I "%SC_IMAGE%" >nul',
  'if errorlevel 1 goto run',
  'set /a n+=1',
  'if %n% GTR 45 goto kill',
  'ping -n 2 127.0.0.1 >nul',
  'goto wait',
  ':kill',
  'echo %date% %time% still running after 45 s, stopping it >> "%SC_LOG%"',
  'taskkill /F /IM "%SC_IMAGE%" >nul 2>&1',
  'ping -n 3 127.0.0.1 >nul',
  ':run',
  'ping -n 2 127.0.0.1 >nul',
  'start "" "%SC_INSTALLER%"',
  'if errorlevel 1 goto failed',
  'echo %date% %time% installer started >> "%SC_LOG%"',
  'echo {"ok":true,"message":"started"} > "%SC_RESULT%"',
  'goto :eof',
  ':failed',
  'echo %date% %time% installer did not start, reopening SportsChud >> "%SC_LOG%"',
  'echo {"ok":false,"message":"The installer could not be started"} > "%SC_RESULT%"',
  'start "" "%SC_EXE%"'
].join('\r\n') + '\r\n';

function helperPaths() {
  const dir = app.getPath('userData');
  return { dir, log: path.join(dir, 'update.log'), result: path.join(dir, 'update-result.json') };
}

function spawnHelper(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ...env } });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

async function launchInstallerAfterExit(installer) {
  const exe = process.execPath;
  const base = path.basename(exe, path.extname(exe));
  const { dir, log, result } = helperPaths();
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  try { fs.unlinkSync(result); } catch (_) {}
  // paths travel in the environment so spaces and quotes in them can't break a command line
  const env = { SC_NAME: base, SC_IMAGE: base + '.exe', SC_INSTALLER: installer, SC_EXE: exe, SC_LOG: log, SC_RESULT: result };
  try { fs.appendFileSync(log, `${new Date().toISOString()} handing over to the helper: ${installer}\n`); } catch (_) {}
  try {
    const ps = path.join(dir, 'update-helper.ps1');
    fs.writeFileSync(ps, '﻿' + PS_SCRIPT + '\n'); // BOM so Windows PowerShell reads it as UTF-8
    await spawnHelper('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ps], env);
    return 'powershell';
  } catch (_) {
    const cmd = path.join(dir, 'update-helper.cmd');
    fs.writeFileSync(cmd, CMD_SCRIPT);
    await spawnHelper(process.env.ComSpec || 'cmd.exe', ['/d', '/c', cmd], env);
    return 'cmd';
  }
}

// On the next start: what did the last hand-over do? Returns an error message if the installer never started.
function takeUpdateResult() {
  const { result } = helperPaths();
  try {
    const r = JSON.parse(fs.readFileSync(result, 'utf8'));
    try { fs.unlinkSync(result); } catch (_) {}
    return r && r.ok === false ? String(r.message || 'The installer could not be started') : null;
  } catch (_) { return null; }
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
  // beforeQuit(): called once the installer is downloaded and checked; the app must shut down completely
  // (windows, tray icon, timers) so the installer can replace its files
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
      installing: false, // download is done and SportsChud is closing so the installer can run
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
    // Did the last hand-over fail to start the installer? Tell the user instead of failing silently.
    const failed = takeUpdateResult();
    if (failed) { this.state.error = `The last update didn't start: ${failed}. Try Install update again.`; this.emit(); }
    const auto = () => { if (this.getSettings().checkForUpdates !== false) this.check(); };
    this.timers.push(setTimeout(auto, FIRST_CHECK_MS));
    this.timers.push(setInterval(auto, CHECK_EVERY_MS));
  }

  stop() {
    this.timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
    this.timers = [];
  }

  async check({ manual = false } = {}) {
    if (!this.state.supported || this.state.checking || this.state.downloading || this.state.installing) return this.state;
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
    // One install at a time, and never again once the hand-over has started (a second download would overwrite
    // the installer the helper is about to run)
    if (!this.state.available || !this.asset || this.state.downloading || this.state.installing) return this.state;
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
      this.state.installing = true;
      this.emit();
      // Hand over to a helper that starts the installer only after SportsChud has fully exited, then shut down.
      try {
        await launchInstallerAfterExit(dest);
      } catch (_) {
        // Neither helper could be started: start the installer directly. shell.openPath goes through Windows'
        // normal launcher, so the installer can ask for administrator permission.
        const err = await shell.openPath(dest);
        if (err) throw new Error(`Couldn't start the installer: ${err}`);
      }
      handedOver = true; // from here on the installer file must stay where it is
      try { this.beforeQuit(); } catch (_) { /* the helper force-closes whatever is left */ }
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

module.exports = { Updater, parseVer, isNewer, looksLikeInstaller, launchInstallerAfterExit, takeUpdateResult };
