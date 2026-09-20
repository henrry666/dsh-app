const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', {
  state: () => ipcRenderer.invoke('desktop:action', 'state'),
  retry: () => ipcRenderer.invoke('desktop:action', 'retry'),
  logs: () => ipcRenderer.invoke('desktop:action', 'logs'),
  onState: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('desktop:state', listener);
    return () => ipcRenderer.removeListener('desktop:state', listener);
  },
});
