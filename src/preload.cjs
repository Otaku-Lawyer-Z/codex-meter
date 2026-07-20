const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("codexMeter", {
  getInitial: () => ipcRenderer.invoke("dashboard:initial"),
  refresh: () => ipcRenderer.invoke("dashboard:refresh"),
  setAlwaysOnTop: (enabled) => ipcRenderer.invoke("dashboard:set-always-on-top", enabled),
  setLaunchAtLogin: (enabled) => ipcRenderer.invoke("dashboard:set-launch-at-login", enabled),
  setRefreshInterval: (seconds) => ipcRenderer.invoke("dashboard:set-refresh-interval", seconds),
  onState: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on("dashboard:state", handler);
    return () => ipcRenderer.removeListener("dashboard:state", handler);
  },
});
