const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('todoDesk', {
  loadData: () => ipcRenderer.invoke('data:load'),
  saveData: (data) => ipcRenderer.invoke('data:save', data),
  importImages: () => ipcRenderer.invoke('attachment:import'),
  revealStorage: () => ipcRenderer.invoke('storage:reveal'),
  syncToLark: (payload) => ipcRenderer.invoke('lark:sync', payload),
  onDataUpdated: (callback) => {
    const listener = (_event, data) => callback(data)
    ipcRenderer.on('data:updated', listener)
    return () => ipcRenderer.removeListener('data:updated', listener)
  },
})
