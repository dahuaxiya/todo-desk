const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('todoDesk', {
  loadData: () => ipcRenderer.invoke('data:load'),
  saveData: (data) => ipcRenderer.invoke('data:save', data),
  importImages: () => ipcRenderer.invoke('attachment:import'),
  pasteImages: () => ipcRenderer.invoke('attachment:paste'),
  savePastedImage: (payload) => ipcRenderer.invoke('attachment:save-data-url', payload),
  revealStorage: () => ipcRenderer.invoke('storage:reveal'),
  revealLogs: () => ipcRenderer.invoke('logs:reveal'),
  openTaskInCalendar: (task) => ipcRenderer.invoke('calendar:open-task', task),
  openAgentSession: (task) => ipcRenderer.invoke('agent:open-session', task),
  restoreDock: () => ipcRenderer.invoke('dock:restore'),
  dockToEdge: (edge) => ipcRenderer.invoke('dock:to-edge', edge),
  setDockDetailOpen: (open) => ipcRenderer.invoke('dock:detail-open', open),
  setDockPassthrough: (enabled) => ipcRenderer.invoke('dock:set-passthrough', enabled),
  applyWindowMode: (mode) => ipcRenderer.invoke('window:apply-mode', mode),
  parseTask: (payload) => ipcRenderer.invoke('ai:parse-task', payload),
  mergeTasks: (payload) => ipcRenderer.invoke('ai:merge-tasks', payload),
  syncToLark: (payload) => ipcRenderer.invoke('lark:sync', payload),
  onDataUpdated: (callback) => {
    const listener = (_event, data) => callback(data)
    ipcRenderer.on('data:updated', listener)
    return () => ipcRenderer.removeListener('data:updated', listener)
  },
  onDockStateChanged: (callback) => {
    const listener = (_event, state) => callback(state)
    ipcRenderer.on('dock:changed', listener)
    return () => ipcRenderer.removeListener('dock:changed', listener)
  },
})
