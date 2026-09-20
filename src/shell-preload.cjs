const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  invoke: (action, payload) => ipcRenderer.invoke('desktop:invoke', action, payload),
  filePaths: files => Array.from(files || []).map(file => webUtils.getPathForFile(file)).filter(Boolean),
  onState: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('desktop:state', listener);
    return () => ipcRenderer.removeListener('desktop:state', listener);
  },
  onBrowser: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('desktop:browser', listener);
    return () => ipcRenderer.removeListener('desktop:browser', listener);
  },
});
