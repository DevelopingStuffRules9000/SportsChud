const { app, BrowserWindow, ipcMain, Notification, shell, Tray, Menu, nativeImage, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { LEAGUES, teamsUrl, dayStr } = require('./leagues');
const { Engine, parseEvent, fetchDays, fetchStandings, isPostseason, fetchPlayoffs, followedAlive, isInSeason, fetchRoster, fetchInjuries } = require('./engine');

const DEFAULT_ALERTS = { reminder: true, start: true, period: true, score: true, close: true, overtime: true, final: true };
const ICON = path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
let win;
let tray = null;
let quitting = false;
let resetting = false;
const startHidden = process.argv.includes('--hidden');
let settings = { follows: [], reminderMinutes: 15, launchAtStartup: false, startSilently: false, keepInTray: true, playoffsAutoHide: true, hideOffSeason: false, activityAutoHide: true, groupBy: 'team', navOrder: null, navLocked: true };
const activity = [];
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

// Small log in the user-data folder (SportsChud.log) so tray/taskbar problems can be diagnosed
function logLine(msg) {
  try {
    const file = path.join(app.getPath('userData'), 'SportsChud.log');
    try { if (fs.statSync(file).size > 100000) fs.unlinkSync(file); } catch (_) {}
    fs.appendFileSync(file, `${new Date().toISOString()} ${msg}\n`);
  } catch (_) {}
}

function loadSettings() {
  // Also look in the folder used before the app was renamed, so saved teams carry over
  const legacy = path.join(app.getPath('appData'), 'Gametime', 'settings.json');
  for (const file of [settingsFile(), legacy]) {
    try {
      settings = { ...settings, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
      // Teams saved before an alert type existed get its default
      for (const f of settings.follows || []) f.alerts = { ...DEFAULT_ALERTS, ...f.alerts };
      return;
    } catch (_) {}
  }
}

function saveSettings() {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
}

// Windows groups taskbar windows by AppUserModelID and takes the pinned icon from the
// process (electron.exe when run from source). To make pinning show the SportsChud icon and
// relaunch SportsChud, the window gets explicit details and the shortcut gets the same ID.
const APP_ID = 'com.sportschud.app';

// Explorer can't read icons out of app.asar, so keep a plain copy on disk
function stableIcon() {
  const dest = path.join(app.getPath('userData'), 'icon.ico');
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'assets', 'icon.ico'), dest);
  return dest;
}

function shortcutOptions(iconPath) {
  return {
    target: process.execPath,
    args: app.isPackaged ? '' : `"${app.getAppPath()}"`,
    cwd: app.isPackaged ? path.dirname(process.execPath) : app.getAppPath(),
    icon: iconPath,
    iconIndex: 0,
    appUserModelId: APP_ID,
    description: 'SportsChud'
  };
}

// Tells the taskbar what to show and run when the open window is pinned
function applyTaskbarDetails() {
  if (process.platform !== 'win32' || !win) return;
  try {
    const q = (x) => `"${x}"`;
    win.setAppDetails({
      appId: APP_ID,
      appIconPath: stableIcon(),
      appIconIndex: 0,
      relaunchCommand: app.isPackaged ? q(process.execPath) : `${q(process.execPath)} ${q(app.getAppPath())}`,
      relaunchDisplayName: 'SportsChud'
    });
  } catch (err) {
    console.error('[taskbar] could not set app details:', err.message);
  }
}

// Creates a SportsChud shortcut on the Windows desktop the first time the app starts.
// A flag file in the user-data folder makes sure it only happens once, so a shortcut
// the user deletes later is not brought back. An existing shortcut is refreshed each start
// so it carries the app ID and correct icon (older versions made it without them).
function ensureDesktopShortcut() {
  if (process.platform !== 'win32') return;
  const flag = path.join(app.getPath('userData'), '.desktop-shortcut');
  try {
    const desktop = app.getPath('desktop');
    const link = path.join(desktop, 'SportsChud.lnk');
    const icon = stableIcon();
    try { fs.unlinkSync(path.join(desktop, 'Gametime.lnk')); } catch (_) {} // pre-rename shortcut
    if (fs.existsSync(link)) {
      shell.writeShortcutLink(link, 'replace', shortcutOptions(icon));
      if (!fs.existsSync(flag)) fs.writeFileSync(flag, new Date().toISOString());
      return;
    }
    if (fs.existsSync(flag)) return; // user deleted it; leave it gone
    if (shell.writeShortcutLink(link, 'create', shortcutOptions(icon))) fs.writeFileSync(flag, new Date().toISOString());
  } catch (err) {
    console.error('[shortcut] could not create desktop shortcut:', err.message);
  }
}

// Launch at login. "Start silently" adds a --hidden flag so the window stays hidden (tray only).
function applyStartup() {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  try {
    // Electron quotes `path` but not `args`, so quote the app folder or a space in it
    // (e.g. C:\Program Files\...) splits the startup command at "C:\Program".
    const args = app.isPackaged ? [] : [`"${app.getAppPath()}"`];
    if (settings.startSilently) args.push('--hidden');
    app.setLoginItemSettings({ openAtLogin: !!settings.launchAtStartup, path: process.execPath, args });
  } catch (err) {
    console.error('[startup] could not update login item:', err.message);
  }
}

// Brings the window back from the tray or the background. Safe to call from the tray icon,
// the tray menu, a notification click, or a second launch (pinned taskbar icon / shortcut).
function showWindow() {
  if (!win || win.isDestroyed()) return createWindow(true);
  if (win.isMinimized()) win.restore();
  win.show();
  // Windows can refuse to focus a window that was hidden in the background, so it only
  // flashes in the taskbar. Pinning it on top for a moment forces it to the front.
  if (process.platform === 'win32') {
    win.setAlwaysOnTop(true);
    win.focus();
    win.setAlwaysOnTop(false);
  } else {
    win.focus();
  }
}

function ensureTray() {
  if (tray) return;
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')).resize({ width: 16, height: 16 });
    tray = new Tray(img);
    tray.setToolTip('SportsChud');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open SportsChud', click: () => showWindow() },
      { type: 'separator' },
      { label: 'Quit', click: () => { quitting = true; app.quit(); } }
    ]));
    tray.on('click', () => showWindow());
    tray.on('double-click', () => showWindow());
  } catch (err) {
    console.error('[tray] could not create tray icon:', err.message);
  }
}

// Schedule for followed teams over any date range. ESPN only answers one day per request,
// so this asks for each day (cached 10 minutes) and one failing day or league never hides the rest.
const DAY = 86400000;

async function getSchedule(startMs, endMs) {
  // one extra day on each side so timezone differences never drop a game
  const days = [];
  for (let t = startMs - DAY; t <= endMs + DAY; t += DAY) days.push(dayStr(new Date(t)));
  const uniqueDays = [...new Set(days)];
  const leagueKeys = [...new Set(settings.follows.map((f) => f.league))];
  const games = [];
  const errors = [];
  const seen = new Set();
  await Promise.all(
    leagueKeys.map(async (key) => {
      const l = LEAGUES.find((x) => x.key === key);
      if (!l) return;
      const r = await fetchDays(l, uniqueDays, 600000);
      errors.push(...r.errors);
      for (const ev of r.events) {
        const g = parseEvent(l, ev);
        if (!g || seen.has(g.id) || !engine.followedIn(settings, g).length) continue;
        seen.add(g.id);
        games.push(g);
      }
    })
  );
  if (!games.length && errors.length) throw new Error([...new Set(errors)].join('; '));
  games.sort((a, b) => new Date(a.date) - new Date(b.date));
  return { games, errors: [...new Set(errors)] };
}

function notify({ title, body, gameId }) {
  const n = new Notification({ title, body, icon: ICON });
  n.on('click', () => showWindow());
  n.show();
  const entry = { title, body, gameId, at: Date.now() };
  activity.unshift(entry);
  activity.length = Math.min(activity.length, 100);
  if (win && !win.isDestroyed()) win.webContents.send('activity', entry);
}

const engine = new Engine({
  getSettings: () => settings,
  notify,
  onUpdate: (games) => {
    if (win && !win.isDestroyed()) win.webContents.send('games:update', games);
  }
});

function createWindow(forceShow = false) {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    show: forceShow || !(startHidden && settings.startSilently),
    backgroundColor: '#1c1c1c',
    icon: ICON,
    title: 'SportsChud',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#e8eaf6', height: 40 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true
    }
  });
  win.removeMenu();
  win.on('close', (e) => {
    if (!quitting && settings.keepInTray) {
      e.preventDefault();
      win.hide();
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  applyTaskbarDetails();
}

app.setAppUserModelId(APP_ID); // needed for Windows toast notifications

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  logLine(`launch ignored: another SportsChud is already running (exec: ${process.execPath}, argv: ${JSON.stringify(process.argv.slice(1))})`);
  app.quit();
} else {
  // Launching again (pinned taskbar icon, desktop shortcut) reveals the hidden window
  app.on('second-instance', (_e, argv) => {
    logLine(`second-instance received (argv: ${JSON.stringify(argv.slice(1))}); window ${win && !win.isDestroyed() ? (win.isVisible() ? 'visible' : 'hidden') : 'missing'}`);
    showWindow();
  });
}

app.whenReady().then(() => {
  if (!gotLock) return;
  loadSettings();
  ensureTray();
  applyStartup();
  ensureDesktopShortcut();
  createWindow();
  engine.start();

  ipcMain.handle('leagues', () => LEAGUES);
  ipcMain.handle('defaults', () => DEFAULT_ALERTS);
  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('settings:save', (_, next) => {
    if (resetting) return settings;
    settings = next;
    saveSettings();
    applyStartup();
    engine.tick();
    return settings;
  });
  ipcMain.handle('open:link', (_, url) => {
    if (typeof url === 'string' && /^https:\/\//.test(url)) shell.openExternal(url);
  });
  // Wipes everything the app has stored (teams, alerts, layout, startup entry, web cache)
  // and quits, so the next launch is a first run.
  ipcMain.handle('app:reset', async () => {
    resetting = true;
    engine.stop();
    settings = { follows: [], reminderMinutes: 15, launchAtStartup: false, startSilently: false, keepInTray: true, playoffsAutoHide: true, hideOffSeason: false, activityAutoHide: true, groupBy: 'team', navOrder: null, navLocked: true };
    applyStartup(); // removes the start-at-login entry
    try { await session.defaultSession.clearStorageData(); await session.defaultSession.clearCache(); } catch (_) {}
    const legacy = path.join(app.getPath('appData'), 'Gametime', 'settings.json');
    for (const f of [settingsFile(), legacy]) { try { fs.unlinkSync(f); } catch (_) {} }
    activity.length = 0;
    quitting = true;
    setTimeout(() => app.quit(), 400);
    return true;
  });
  ipcMain.handle('games:get', () => engine.games);
  ipcMain.handle('schedule', async (_, { start, end }) => {
    try { return await getSchedule(start, end); }
    catch (err) { return { games: [], errors: [err.message], failed: true }; }
  });
  ipcMain.handle('standings', async (_, key) => {
    const l = LEAGUES.find((x) => x.key === key);
    if (!l) return { ok: false, error: 'Unknown league', groups: [] };
    try { return { ok: true, ...(await fetchStandings(l)) }; }
    catch (err) { return { ok: false, error: err.message, groups: [] }; }
  });
  const followedIds = (key) => new Set(settings.follows.filter((f) => f.league === key).map((f) => f.teamId));
  // Leagues in their postseason where a followed team is still alive (drives the Playoffs tab and its autohide)
  ipcMain.handle('playoffs:status', async () => {
    const on = [];
    await Promise.all(LEAGUES.map(async (l) => {
      try {
        const mine = followedIds(l.key);
        if (!mine.size || !(await isPostseason(l))) return;
        if (followedAlive((await fetchPlayoffs(l)).series, mine)) on.push(l.key);
      } catch (_) {}
    }));
    return LEAGUES.map((l) => l.key).filter((k) => on.includes(k));
  });
  ipcMain.handle('app:version', () => app.getVersion());
  // Keys of the leagues that are in season right now (drives the Autohide out of season sports setting)
  ipcMain.handle('seasons:status', async () => {
    const on = [];
    await Promise.all(LEAGUES.map(async (l) => { if (await isInSeason(l)) on.push(l.key); }));
    return LEAGUES.map((l) => l.key).filter((k) => on.includes(k));
  });
  ipcMain.handle('playoffs', async () => {
    const leagues = [];
    const errors = [];
    await Promise.all(LEAGUES.map(async (l) => {
      try {
        if (!(await isPostseason(l))) return;
        const r = await fetchPlayoffs(l);
        errors.push(...r.errors);
        leagues.push({ key: l.key, name: l.name, icon: l.icon, series: r.series, alive: followedAlive(r.series, followedIds(l.key)) });
      } catch (err) { errors.push(`${l.name}: ${err.message}`); }
    }));
    leagues.sort((a, b) => LEAGUES.findIndex((x) => x.key === a.key) - LEAGUES.findIndex((x) => x.key === b.key));
    return { leagues, errors: [...new Set(errors)] };
  });
  ipcMain.handle('roster', async (_, { key, teamId }) => {
    const l = LEAGUES.find((x) => x.key === key);
    if (!l || !/^\d+$/.test(String(teamId))) return { ok: false, error: 'Unknown team', groups: [] };
    try { return { ok: true, ...(await fetchRoster(l, String(teamId))) }; }
    catch (err) { return { ok: false, error: err.message, groups: [] }; }
  });
  ipcMain.handle('injuries', async (_, key) => {
    const l = LEAGUES.find((x) => x.key === key);
    if (!l) return { ok: false, error: 'Unknown league', teams: [] };
    try { return { ok: true, ...(await fetchInjuries(l)) }; }
    catch (err) { return { ok: false, error: err.message, teams: [] }; }
  });
  ipcMain.handle('activity:get', () => activity);
  ipcMain.handle('notify:test', () =>
    notify({ title: '🏒 SportsChud', body: 'Notifications are working.' })
  );
  ipcMain.handle('teams', async (_, key) => {
    const l = LEAGUES.find((x) => x.key === key);
    const res = await fetch(teamsUrl(l));
    const data = await res.json();
    const teams = data.sports[0].leagues[0].teams.map(({ team: t }) => ({
      teamId: String(t.id),
      league: key,
      name: t.displayName,
      abbr: t.abbreviation,
      logo: (t.logos && t.logos[0] && t.logos[0].href) || '',
      color: t.color ? '#' + t.color : null
    }));
    return teams.sort((a, b) => a.name.localeCompare(b.name));
  });

  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => {
  if (settings.keepInTray && !quitting) return; // stay alive in the tray
  engine.stop();
  app.quit();
});
