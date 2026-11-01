const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('captureBridge', {
  stop: () => ipcRenderer.send('yuri:capture:stop'),
  forget: () => ipcRenderer.send('yuri:capture:forget'),
  loaded: () => ipcRenderer.send('yuri:capture:loaded'),
  send: (message) => ipcRenderer.send('yuri:capture:message', message),
  frame: (bytes) => ipcRenderer.send('yuri:capture:frame', bytes),
  onMessage: (callback) => ipcRenderer.on('yuri:capture:command', (_event, message) => callback(message)),
});
