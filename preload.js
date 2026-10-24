const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  leagues: () => ipcRenderer.invoke('leagues'),
  defaults: () => ipcRenderer.invoke('defaults'),
  teams: (key) => ipcRenderer.invoke('teams', key),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  getGames: () => ipcRenderer.invoke('games:get'),
  schedule: (start, end) => ipcRenderer.invoke('schedule', { start, end }),
  standings: (key) => ipcRenderer.invoke('standings', key),
  playoffStatus: () => ipcRenderer.invoke('playoffs:status'),
  version: () => ipcRenderer.invoke('app:version'),
  seasonStatus: () => ipcRenderer.invoke('seasons:status'),
  playoffs: () => ipcRenderer.invoke('playoffs'),
  roster: (key, teamId) => ipcRenderer.invoke('roster', { key, teamId }),
  injuries: (key) => ipcRenderer.invoke('injuries', key),
  getActivity: () => ipcRenderer.invoke('activity:get'),
  openLink: (url) => ipcRenderer.invoke('open:link', url),
  resetApp: () => ipcRenderer.invoke('app:reset'),
  testNotification: () => ipcRenderer.invoke('notify:test'),
  onGames: (cb) => ipcRenderer.on('games:update', (_, g) => cb(g)),
  onActivity: (cb) => ipcRenderer.on('activity', (_, a) => cb(a))
});
