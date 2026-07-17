export type TaskStatus = 'doing' | 'todo' | 'pending_acceptance' | 'done'
export type TaskColumnStatus = 'doing' | 'todo' | 'done'
export type TaskPriority = 'low' | 'medium' | 'high'
export type TaskRelationshipState = 'linked' | 'unresolved' | 'independent_root'
export type AppMode = 'normal' | 'mini'
export type AddMode = 'quick' | 'detail'
export type ShortcutAction = 'toggleDock' | 'dockLeft' | 'dockRight' | 'toggleMini' | 'toggleKeepOnTop'
export type ShortcutSettings = Record<ShortcutAction, string>
export type TaskSortMode =
  | 'manual'
  | 'priority-desc'
  | 'priority-asc'
  | 'created-desc'
  | 'created-asc'
  | 'due-asc'
  | 'due-desc'
  | 'updated-desc'
  | 'updated-asc'
  | 'completed-desc'
  | 'completed-asc'

export interface TaskImage {
  name: string
  path: string
  url: string
}

export type TaskOriginKind = 'human' | 'agent' | 'integration' | 'system' | 'legacy'
export type TaskOriginChannel = 'ui' | 'local-api' | 'todo-desk-skill' | 'import' | 'automation'
export type TaskOriginConfidence = 'explicit' | 'legacy-inferred'

export interface TaskOrigin {
  kind: TaskOriginKind
  channel: TaskOriginChannel
  createdVia: string
  confidence: TaskOriginConfidence
  agent?: {
    name: string
    sessionId?: string
    tool?: string
  }
  repository?: {
    name?: string
    path?: string
    remote?: string
    branch?: string
  }
  client?: {
    name: string
    version?: string
  }
}

export interface CompletionAcceptance {
  requestedAt: string
  requestedBy: string
  message: string
  resolvedAt?: string
  resolution?: 'accepted' | 'rework' | 'dismissed'
}

export interface SessionReview {
  requestedAt: string
  requestedBy: string
  message: string
  resolvedAt?: string
  resolution?: 'reviewed' | 'rework' | 'dismissed'
}

export interface TaskParentLink {
  type: 'subtask_of' | 'discovered_from'
  reason?: string
  affectsParentCompletion: boolean
  createdBy: 'human' | 'agent'
  createdAt: string
  confidence: 'explicit' | 'inferred'
}

export interface ParentCompletionReview {
  requestedAt: string
  requestedBy: string
  message: string
  reason: 'all_agent_children_done' | 'agent_child_done'
  childTaskIds: string[]
  resolvedAt?: string
  resolution?: 'accepted' | 'kept'
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
  completionAcceptance?: CompletionAcceptance
  sessionReview?: SessionReview
  parentTaskId?: string
  parentLink?: TaskParentLink
  relationshipState?: TaskRelationshipState
  parentCompletionReview?: ParentCompletionReview
  origin: TaskOrigin
  remindedAt?: string
  deletedAt?: string
  source?: string
  agent?: string
  agentSessionId?: string
  repository?: string
  repositoryPath?: string
  calendarSync?: TaskCalendarSync
}

export interface TopologyPosition {
  x: number
  y: number
}

export type AppFontSize = 'small' | 'standard' | 'large'

export interface AppSettings {
  larkDoc: string
  larkCalendarId: string
  calendarSyncEnabled: boolean
  larkCalendarSync: boolean
  syncOnComplete: boolean
  keepOnTop: boolean
  snapToEdge: boolean
  apiEnabled: boolean
  apiPort: number
  desktopReminders: boolean
  aiEnabled: boolean
  aiBaseUrl: string
  aiModel: string
  aiApiKey: string
  fontSize: AppFontSize
  appMode: AppMode
  miniColumn: TaskColumnStatus
  addMode: AddMode
  columnSorts: Record<TaskColumnStatus, TaskSortMode>
  globalShortcuts: ShortcutSettings
  edgeDocked: boolean
  topologyPositions: Record<string, TopologyPosition>
}

export interface TaskCalendarSyncTarget {
  status: 'ok' | 'failed' | 'skipped' | 'deleted'
  signature: string
  syncedAt: string
  message?: string
  eventId?: string
  calendarId?: string
  filePath?: string
  appLink?: string
}

export interface TaskCalendarSync {
  local?: TaskCalendarSyncTarget
  lark?: TaskCalendarSyncTarget
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
  trash: Task[]
  syncLog: SyncLogItem[]
}

export interface TodoDeskBridge {
  loadData: () => Promise<AppData>
  saveData: (data: AppData) => Promise<AppData>
  importImages: () => Promise<TaskImage[]>
  pasteImages: () => Promise<TaskImage[]>
  savePastedImage: (payload: { name: string; dataUrl: string }) => Promise<TaskImage[]>
  revealStorage: () => Promise<unknown>
  revealLogs: () => Promise<unknown>
  openTaskInCalendar: (task: Task) => Promise<{ ok: boolean; message?: string; filePath?: string; eventId?: string }>
  openAgentSession: (task: Task) => Promise<{ ok: boolean; message?: string; url?: string }>
  restoreDock: () => Promise<{ ok: boolean }>
  dockToEdge: (edge: 'left' | 'right') => Promise<{ ok: boolean }>
  setDockDetailOpen: (open: boolean) => Promise<{ ok: boolean; bounds?: { x: number; y: number; width: number; height: number } }>
  setDockTopologyOpen: (open: boolean) => Promise<{ ok: boolean; bounds?: { x: number; y: number; width: number; height: number } }>
  setDockPassthrough: (enabled: boolean) => Promise<{ ok: boolean }>
  setShortcutRecording: (recording: boolean) => Promise<{ ok: boolean }>
  applyWindowMode: (mode: AppMode) => Promise<{ ok: boolean }>
  parseTask: (payload: { text: string; settings: AppSettings; images?: TaskImage[] }) => Promise<{
    ok: boolean
    skipped?: boolean
    message?: string
    task?: Partial<Task>
    tasks?: Partial<Task>[]
    imageMode?: 'none' | 'vision' | 'ocr' | 'local'
    usedLocalFallback?: boolean
  }>
  editTask: (payload: {
    originalTask?: Partial<Task>
    draftTask: Partial<Task>
    instruction: string
    settings: AppSettings
    images?: TaskImage[]
  }) => Promise<{
    ok: boolean
    skipped?: boolean
    message?: string
    task?: Partial<Task>
    imageMode?: 'none' | 'vision' | 'ocr'
  }>
  mergeTasks: (payload: { tasks: Task[]; settings: AppSettings }) => Promise<{
    ok: boolean
    skipped?: boolean
    message?: string
    task?: Partial<Task>
  }>
  testAiConnection: (payload: { settings: AppSettings }) => Promise<{
    ok: boolean
    skipped?: boolean
    message?: string
    endpoint?: string
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
