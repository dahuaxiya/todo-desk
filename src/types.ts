export type TaskStatus = 'doing' | 'todo' | 'done'
export type TaskPriority = 'low' | 'medium' | 'high'
export type AppMode = 'normal' | 'mini'
export type AddMode = 'quick' | 'detail'

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
  aiEnabled: boolean
  aiBaseUrl: string
  aiModel: string
  aiApiKey: string
  appMode: AppMode
  miniColumn: TaskStatus
  addMode: AddMode
  edgeDocked: boolean
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
  restoreDock: () => Promise<{ ok: boolean }>
  parseTask: (payload: { text: string; settings: AppSettings }) => Promise<{
    ok: boolean
    skipped?: boolean
    message?: string
    task?: Partial<Task>
  }>
  syncToLark: (payload: { data: AppData; completedTaskId?: string }) => Promise<{
    ok: boolean
    skipped?: boolean
    message?: string
    data?: AppData
  }>
  onDataUpdated: (callback: (data: AppData) => void) => () => void
  onDockStateChanged: (callback: (state: { docked: boolean; edge?: string }) => void) => () => void
}

declare global {
  interface Window {
    todoDesk?: TodoDeskBridge
  }
}
