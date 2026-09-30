'use strict';
// Exposes a tiny, explicit API to Crew's own pages (not to previewed sites, which run in iframes).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('crewDesktop', {
  isDesktop: true,
  show: () => ipcRenderer.send('vc:show'),
  retry: () => ipcRenderer.send('vc:retry'),
  openLogs: () => ipcRenderer.send('vc:open-logs'),
  info: () => ipcRenderer.invoke('vc:info'),
  setAutostart: (on) => ipcRenderer.invoke('vc:set-autostart', !!on),
});
