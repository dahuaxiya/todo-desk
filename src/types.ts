export type TaskStatus = 'doing' | 'todo' | 'done'
export type TaskPriority = 'low' | 'medium' | 'high'

export interface TaskImage {
  name: string
  path: string
  url: string
}

export interface Task {
  id: string
  title: string
  detail: string
  status: TaskStatus
  priority: TaskPriority
  project: string
  tags: string[]
  dueAt: string
  reminderAt: string
  imagePaths: TaskImage[]
  createdAt: string
  updatedAt: string
  completedAt: string
  remindedAt?: string
}

export interface AppSettings {
  larkDoc: string
  syncOnComplete: boolean
  keepOnTop: boolean
  snapToEdge: boolean
  apiEnabled: boolean
  apiPort: number
}

export interface SyncLogItem {
  id: string
  at: string
  taskId: string
  title: string
  status: 'ok' | 'failed'
  message?: string
}

export interface AppData {
  version: number
  settings: AppSettings
  tasks: Task[]
  syncLog: SyncLogItem[]
}

export interface TodoDeskBridge {
  loadData: () => Promise<AppData>
  saveData: (data: AppData) => Promise<AppData>
  importImages: () => Promise<TaskImage[]>
  revealStorage: () => Promise<unknown>
  syncToLark: (payload: { data: AppData; completedTaskId?: string }) => Promise<{
    ok: boolean
    skipped?: boolean
    message?: string
    data?: AppData
  }>
  onDataUpdated: (callback: (data: AppData) => void) => () => void
}

declare global {
  interface Window {
    todoDesk?: TodoDeskBridge
  }
}
