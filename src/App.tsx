import { useCallback, useEffect, useMemo, useState } from 'react'
import './App.css'
import type { ClipboardEvent, DragEvent, FormEvent, KeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import type { AddMode, AppData, AppMode, AppSettings, Task, TaskImage, TaskOrigin, TaskPriority, TaskSortMode, TaskStatus } from './types'

const storageKey = 'todo-desk-data'

const statusConfig: Record<TaskStatus, { label: string; shortLabel: string }> = {
  doing: { label: '正在做', shortLabel: '做' },
  todo: { label: 'Todo', shortLabel: '办' },
  done: { label: '已完成', shortLabel: '完' },
}

const priorityConfig: Record<TaskPriority, { label: string }> = {
  high: { label: '高' },
  medium: { label: '中' },
  low: { label: '低' },
}

const taskStatuses = ['doing', 'todo', 'done'] as const
type TaskOriginFilter = 'all' | 'ai' | 'human'

const originFilterOptions: Array<{ value: TaskOriginFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'ai', label: 'AI' },
  { value: 'human', label: '人工' },
]

const defaultColumnSorts: Record<TaskStatus, TaskSortMode> = {
  doing: 'manual',
  todo: 'manual',
  done: 'completed-desc',
}

const sortModeConfig: Record<TaskSortMode, { label: string; shortLabel: string; menuLabel: string }> = {
  manual: { label: '默认顺序', shortLabel: '默认', menuLabel: '默认' },
  'priority-desc': { label: '优先级 高到低', shortLabel: '优先级', menuLabel: '高到低' },
  'priority-asc': { label: '优先级 低到高', shortLabel: '优先级', menuLabel: '低到高' },
  'created-desc': { label: '创建时间 新到旧', shortLabel: '创建', menuLabel: '新到旧' },
  'created-asc': { label: '创建时间 旧到新', shortLabel: '创建', menuLabel: '旧到新' },
  'due-asc': { label: '截止时间 近到远', shortLabel: '截止', menuLabel: '近到远' },
  'due-desc': { label: '截止时间 远到近', shortLabel: '截止', menuLabel: '远到近' },
  'updated-desc': { label: '更新时间 新到旧', shortLabel: '更新', menuLabel: '新到旧' },
  'updated-asc': { label: '更新时间 旧到新', shortLabel: '更新', menuLabel: '旧到新' },
  'completed-desc': { label: '完成时间 新到旧', shortLabel: '完成', menuLabel: '新到旧' },
  'completed-asc': { label: '完成时间 旧到新', shortLabel: '完成', menuLabel: '旧到新' },
}

const sortModeGroups: Array<{ title: string; modes: TaskSortMode[] }> = [
  { title: '默认', modes: ['manual'] },
  { title: '优先级', modes: ['priority-desc', 'priority-asc'] },
  { title: '创建', modes: ['created-desc', 'created-asc'] },
  { title: '截止', modes: ['due-asc', 'due-desc'] },
  { title: '更新', modes: ['updated-desc', 'updated-asc'] },
  { title: '完成', modes: ['completed-desc', 'completed-asc'] },
]

function getSortGroupsForStatus(status: TaskStatus) {
  if (status === 'done') return sortModeGroups
  return sortModeGroups.filter((group) => !group.modes.some((mode) => mode.startsWith('completed-')))
}

function normalizeSortModeForStatus(status: TaskStatus, mode: TaskSortMode) {
  if (status !== 'done' && mode.startsWith('completed-')) return defaultColumnSorts[status]
  return mode
}

const codexThreadIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const originKinds = new Set<TaskOrigin['kind']>(['human', 'agent', 'integration', 'system', 'legacy'])
const originChannels = new Set<TaskOrigin['channel']>(['ui', 'local-api', 'todo-desk-skill', 'import', 'automation'])
const originConfidences = new Set<TaskOrigin['confidence']>(['explicit', 'legacy-inferred'])
const legacyAgentSources = new Set(['codex', 'claude', 'cursor', 'kimi', 'forceclaw'])
const uiDerivedSources = new Set(['merge', 'ai-merge'])

function canOpenAgentSession(task: Task) {
  const agent = `${task.origin?.agent?.name || ''} ${task.origin?.agent?.tool || ''} ${task.agent || ''} ${task.source || ''}`.toLowerCase()
  const sessionId = task.origin?.agent?.sessionId?.trim() || task.agentSessionId?.trim() || ''
  return agent.includes('codex') && codexThreadIdPattern.test(sessionId)
}

function isAgentCreatedTask(task: Task) {
  return task.origin?.kind === 'agent'
}

function matchesOriginFilter(task: Task, filter: TaskOriginFilter) {
  if (filter === 'all') return true
  const isAgentTask = isAgentCreatedTask(task)
  return filter === 'ai' ? isAgentTask : !isAgentTask
}

function createHumanTaskOrigin(createdVia: string): TaskOrigin {
  return {
    kind: 'human',
    channel: 'ui',
    createdVia,
    confidence: 'explicit',
  }
}

function hasValidOrigin(task: Task) {
  const origin = task.origin
  return Boolean(
    origin
    && originKinds.has(origin.kind)
    && originChannels.has(origin.channel)
    && originConfidences.has(origin.confidence)
    && origin.createdVia?.trim(),
  )
}

function normalizeTaskOrigin(task: Task): Task {
  if (hasValidOrigin(task)) return task

  const source = (task.source || '').trim().toLowerCase()
  if (task.agent?.trim() || task.agentSessionId?.trim() || legacyAgentSources.has(source)) {
    return {
      ...task,
      origin: {
        kind: 'agent',
        channel: 'local-api',
        createdVia: source || 'legacy-api',
        confidence: 'legacy-inferred',
        agent: {
          name: task.agent?.trim() || source || 'unknown',
          sessionId: task.agentSessionId?.trim() || undefined,
          tool: task.agent?.trim() || source || undefined,
        },
        repository: {
          name: task.repository?.trim() || undefined,
          path: task.repositoryPath?.trim() || undefined,
        },
      },
    }
  }

  if (uiDerivedSources.has(source)) {
    return {
      ...task,
      origin: {
        kind: 'human',
        channel: 'ui',
        createdVia: source,
        confidence: 'legacy-inferred',
      },
    }
  }

  if (source) {
    return {
      ...task,
      origin: {
        kind: source === 'api' ? 'integration' : 'legacy',
        channel: 'local-api',
        createdVia: source,
        confidence: 'legacy-inferred',
      },
    }
  }

  return {
    ...task,
    origin: {
      kind: 'human',
      channel: 'ui',
      createdVia: 'legacy-ui',
      confidence: 'legacy-inferred',
    },
  }
}

const appModeOptions: Array<{ value: AppMode; label: string }> = [
  { value: 'normal', label: '正常' },
  { value: 'mini', label: '小卡' },
]

const addModeOptions: Array<{ value: AddMode; label: string }> = [
  { value: 'quick', label: '文本' },
  { value: 'detail', label: '详细' },
]

const emptyTaskDraft = {
  title: '',
  detail: '',
  status: 'todo' as TaskStatus,
  priority: 'medium' as TaskPriority,
  project: '',
  tags: '',
  dueAt: '',
  reminderAt: '',
}

interface ImagePreviewState {
  images: TaskImage[]
  index: number
  title: string
}

interface OriginFilterControlProps {
  value: TaskOriginFilter
  counts: Record<TaskOriginFilter, number>
  onChange: (value: TaskOriginFilter) => void
  compact?: boolean
}

function OriginFilterControl({ value, counts, onChange, compact = false }: OriginFilterControlProps) {
  return (
    <div className={`origin-filter ${compact ? 'compact-origin-filter' : ''}`} role="group" aria-label="任务来源分类">
      {originFilterOptions.map((option) => (
        <button
          key={option.value}
          className={value === option.value ? 'active' : ''}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          <span>{option.label}</span>
          <small>{counts[option.value]}</small>
        </button>
      ))}
    </div>
  )
}

function createDefaultData(): AppData {
  const now = new Date().toISOString()
  return {
    version: 2,
    settings: {
      larkDoc: '',
      syncOnComplete: true,
      keepOnTop: false,
      snapToEdge: true,
      apiEnabled: true,
      apiPort: 47731,
      desktopReminders: true,
      aiEnabled: false,
      aiBaseUrl: 'https://api.openai.com/v1',
      aiModel: 'gpt-4o-mini',
      aiApiKey: '',
      appMode: 'normal',
      miniColumn: 'doing',
      addMode: 'quick',
      columnSorts: defaultColumnSorts,
      edgeDocked: false,
    },
    tasks: [
      {
        id: crypto.randomUUID(),
        title: '配置飞书文档链接',
        detail: '填入文档 URL 后，勾选完成任务会自动同步当前看板。',
        status: 'doing',
        priority: 'high',
        project: 'Todo Desk',
        tags: ['飞书'],
        dueAt: '',
        reminderAt: '',
        imagePaths: [],
        createdAt: now,
        updatedAt: now,
        completedAt: '',
        origin: createHumanTaskOrigin('seed-data'),
      },
      {
        id: crypto.randomUUID(),
        title: '把今天的待办整理进看板',
        detail: '支持当前工作、Todo、已完成三个区域，也可以用模糊搜索快速定位。',
        status: 'todo',
        priority: 'medium',
        project: '日常',
        tags: ['整理'],
        dueAt: '',
        reminderAt: '',
        imagePaths: [],
        createdAt: now,
        updatedAt: now,
        completedAt: '',
        origin: createHumanTaskOrigin('seed-data'),
      },
    ],
    trash: [],
    syncLog: [],
  }
}

function mergeWithDefaults(value: AppData): AppData {
  const defaults = createDefaultData()
  return {
    ...defaults,
    ...value,
    settings: {
      ...defaults.settings,
      ...value.settings,
      columnSorts: {
        ...defaultColumnSorts,
        ...value.settings?.columnSorts,
      },
      edgeDocked: false,
    },
    tasks: Array.isArray(value.tasks) ? value.tasks.map(normalizeTaskOrigin) : [],
    trash: Array.isArray(value.trash) ? value.trash.map(normalizeTaskOrigin) : [],
    syncLog: Array.isArray(value.syncLog) ? value.syncLog : [],
  }
}

async function loadData(): Promise<AppData> {
  if (window.todoDesk) {
    return mergeWithDefaults(await window.todoDesk.loadData())
  }

  const cached = localStorage.getItem(storageKey)
  if (!cached) return createDefaultData()
  return mergeWithDefaults(JSON.parse(cached))
}

async function saveData(data: AppData): Promise<AppData> {
  if (window.todoDesk) {
    return window.todoDesk.saveData(data)
  }

  localStorage.setItem(storageKey, JSON.stringify(data))
  return data
}

function toLocalInputValue(value: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

function fromLocalInputValue(value: string) {
  if (!value) return ''
  return new Date(value).toISOString()
}

function formatDateTime(value: string) {
  if (!value) return ''
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function getTaskTimeLabel(task: Task) {
  if (task.completedAt) return `创建 ${formatDateTime(task.createdAt)} · 完成 ${formatDateTime(task.completedAt)}`
  if (task.dueAt) return `截止 ${formatDateTime(task.dueAt)}`
  if (task.reminderAt) return `提醒 ${formatDateTime(task.reminderAt)}`
  return `创建 ${formatDateTime(task.createdAt)}`
}

function normalizeKeywords(value: string) {
  return value.trim().toLowerCase()
}

function fuzzyIncludes(source: string, keyword: string) {
  if (!keyword) return true
  const normalizedSource = source.toLowerCase()
  let index = 0
  for (const char of keyword) {
    index = normalizedSource.indexOf(char, index)
    if (index === -1) return false
    index += 1
  }
  return true
}

function compareText(left: string, right: string) {
  return left.localeCompare(right, 'zh-CN')
}

function getTimeValue(value: string) {
  if (!value) return null
  const time = new Date(value).getTime()
  if (Number.isNaN(time)) return null
  return time
}

function compareByTime(left: Task, right: Task, field: keyof Pick<Task, 'createdAt' | 'dueAt' | 'updatedAt' | 'completedAt'>, direction: 'asc' | 'desc') {
  const leftTime = getTimeValue(String(left[field] || ''))
  const rightTime = getTimeValue(String(right[field] || ''))
  if (leftTime === null && rightTime === null) return compareText(left.title, right.title)
  if (leftTime === null) return 1
  if (rightTime === null) return -1
  const result = leftTime - rightTime
  if (result !== 0) return direction === 'asc' ? result : -result
  return compareText(left.title, right.title)
}

function sortTasksForColumn(tasks: Task[], mode: TaskSortMode) {
  const priorityRank: Record<TaskPriority, number> = {
    high: 3,
    medium: 2,
    low: 1,
  }
  const sorted = [...tasks]

  switch (mode) {
    case 'priority-desc':
      return sorted.sort((left, right) => priorityRank[right.priority] - priorityRank[left.priority] || compareByTime(left, right, 'createdAt', 'desc'))
    case 'priority-asc':
      return sorted.sort((left, right) => priorityRank[left.priority] - priorityRank[right.priority] || compareByTime(left, right, 'createdAt', 'desc'))
    case 'created-desc':
      return sorted.sort((left, right) => compareByTime(left, right, 'createdAt', 'desc'))
    case 'created-asc':
      return sorted.sort((left, right) => compareByTime(left, right, 'createdAt', 'asc'))
    case 'due-asc':
      return sorted.sort((left, right) => compareByTime(left, right, 'dueAt', 'asc'))
    case 'due-desc':
      return sorted.sort((left, right) => compareByTime(left, right, 'dueAt', 'desc'))
    case 'updated-desc':
      return sorted.sort((left, right) => compareByTime(left, right, 'updatedAt', 'desc'))
    case 'updated-asc':
      return sorted.sort((left, right) => compareByTime(left, right, 'updatedAt', 'asc'))
    case 'completed-desc':
      return sorted.sort((left, right) => compareByTime(left, right, 'completedAt', 'desc'))
    case 'completed-asc':
      return sorted.sort((left, right) => compareByTime(left, right, 'completedAt', 'asc'))
    default:
      return sorted
  }
}

function taskSearchText(task: Task) {
  return [
    task.title,
    task.detail,
    task.project,
    task.priority,
    task.status,
    task.tags.join(' '),
    task.dueAt ? formatDateTime(task.dueAt) : '',
  ].join(' ')
}

function formatTaskForClipboard(task: Task) {
  const lines = [
    task.title,
    task.detail,
    `状态：${statusConfig[task.status].label}`,
    `优先级：${priorityConfig[task.priority].label}`,
    task.project ? `项目：${task.project}` : '',
    task.dueAt ? `截止：${formatDateTime(task.dueAt)}` : '',
    task.reminderAt ? `提醒：${formatDateTime(task.reminderAt)}` : '',
    task.completedAt ? `完成：${formatDateTime(task.completedAt)}` : '',
    task.tags.length ? `标签：${task.tags.map((tag) => `#${tag}`).join(' ')}` : '',
  ]

  return lines.filter(Boolean).join('\n')
}

function mergeUniqueStrings(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
}

function pickMergedStatus(tasks: Task[]): TaskStatus {
  if (tasks.some((task) => task.status === 'doing')) return 'doing'
  if (tasks.some((task) => task.status === 'todo')) return 'todo'
  return 'done'
}

function pickMergedPriority(tasks: Task[]): TaskPriority {
  if (tasks.some((task) => task.priority === 'high')) return 'high'
  if (tasks.some((task) => task.priority === 'medium')) return 'medium'
  return 'low'
}

function pickEarliestDate(values: string[]) {
  return values.filter(Boolean).sort((left, right) => new Date(left).getTime() - new Date(right).getTime())[0] || ''
}

async function copyTextToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()
  document.execCommand('copy')
  textarea.remove()
}

function parseTags(value: string) {
  return value
    .split(/[,\s，、]+/)
    .map((tag) => tag.trim())
    .filter(Boolean)
}

function buildDraftFromTask(task: Task) {
  return {
    title: task.title,
    detail: task.detail,
    status: task.status,
    priority: task.priority,
    project: task.project,
    tags: task.tags.join(' '),
    dueAt: toLocalInputValue(task.dueAt),
    reminderAt: toLocalInputValue(task.reminderAt),
  }
}

function applyParsedTaskToDraft(parsed: Partial<Task>, fallbackText: string, status: TaskStatus) {
  const parsedStatus = taskStatuses.includes(parsed.status as TaskStatus) ? (parsed.status as TaskStatus) : status
  const parsedPriority = ['high', 'medium', 'low'].includes(parsed.priority as TaskPriority)
    ? (parsed.priority as TaskPriority)
    : 'medium'

  return {
    title: parsed.title || fallbackText,
    detail: parsed.detail || '',
    status: parsedStatus,
    priority: parsedPriority,
    project: parsed.project || '',
    tags: parsed.tags?.join(' ') || '',
    dueAt: toLocalInputValue(parsed.dueAt || ''),
    reminderAt: toLocalInputValue(parsed.reminderAt || ''),
  }
}

function createTaskFromDraft(
  draftValue: ReturnType<typeof applyParsedTaskToDraft>,
  fallbackTitle: string,
  images: TaskImage[] = [],
  createdVia = 'ui-quick-add',
): Task {
  const now = new Date().toISOString()
  const status = draftValue.status
  return {
    id: crypto.randomUUID(),
    title: draftValue.title.trim() || fallbackTitle,
    detail: draftValue.detail.trim(),
    status,
    priority: draftValue.priority,
    project: draftValue.project.trim(),
    tags: parseTags(draftValue.tags),
    dueAt: fromLocalInputValue(draftValue.dueAt),
    reminderAt: fromLocalInputValue(draftValue.reminderAt),
    imagePaths: images,
    createdAt: now,
    updatedAt: now,
    completedAt: status === 'done' ? now : '',
    origin: createHumanTaskOrigin(createdVia),
    remindedAt: '',
  }
}

function App() {
  const [data, setData] = useState<AppData>(() => createDefaultData())
  const [isLoaded, setIsLoaded] = useState(false)
  const [search, setSearch] = useState('')
  const [originFilter, setOriginFilter] = useState<TaskOriginFilter>('all')
  const [selectedTaskId, setSelectedTaskId] = useState<string>('')
  const [editingTaskId, setEditingTaskId] = useState<string>('')
  const [draft, setDraft] = useState(emptyTaskDraft)
  const [attachedImages, setAttachedImages] = useState<TaskImage[]>([])
  const [syncState, setSyncState] = useState('尚未同步')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [trashOpen, setTrashOpen] = useState(false)
  const [quickText, setQuickText] = useState('')
  const [aiState, setAiState] = useState('AI 元数据识别未启用')
  const [submitState, setSubmitState] = useState('')
  const [mergingMode, setMergingMode] = useState<'' | 'plain' | 'ai'>('')
  const [draggingTaskId, setDraggingTaskId] = useState('')
  const [dockState, setDockState] = useState({ docked: false, edge: '' })
  const [dockDetailOpen, setDockDetailOpenState] = useState(false)
  const [imagePreview, setImagePreview] = useState<ImagePreviewState | null>(null)
  const [multiSelectedTaskIds, setMultiSelectedTaskIds] = useState<string[]>([])
  const [openSortColumn, setOpenSortColumn] = useState<TaskStatus | ''>('')

  useEffect(() => {
    loadData()
      .then((nextData) => {
        setData(nextData)
        setSelectedTaskId('')
        setSyncState(nextData.settings.larkDoc ? '飞书同步已配置' : '先配置飞书文档')
      })
      .catch((error) => {
        console.error(error)
        setSyncState('读取本地数据失败')
      })
      .finally(() => setIsLoaded(true))
  }, [])

  useEffect(() => {
    if (!window.todoDesk?.onDataUpdated) return undefined
    return window.todoDesk.onDataUpdated((nextData) => {
      setData(mergeWithDefaults(nextData))
      setSyncState(nextData.settings.larkDoc ? '飞书同步已配置' : '先配置飞书文档')
    })
  }, [])

  useEffect(() => {
    if (!window.todoDesk?.onDockStateChanged) return undefined
    return window.todoDesk.onDockStateChanged((state) => {
      setDockState({ docked: state.docked, edge: state.edge || '' })
    })
  }, [])

  const searchedTasks = useMemo(() => {
    const keyword = normalizeKeywords(search)
    return data.tasks.filter((task) => fuzzyIncludes(taskSearchText(task), keyword))
  }, [data.tasks, search])

  const originFilterCounts = useMemo(() => {
    const ai = searchedTasks.filter(isAgentCreatedTask).length
    return {
      all: searchedTasks.length,
      ai,
      human: searchedTasks.length - ai,
    }
  }, [searchedTasks])

  const filteredTasks = useMemo(
    () => searchedTasks.filter((task) => matchesOriginFilter(task, originFilter)),
    [originFilter, searchedTasks],
  )

  const groupedTasks = useMemo(
    () => ({
      doing: sortTasksForColumn(filteredTasks.filter((task) => task.status === 'doing'), data.settings.columnSorts.doing),
      todo: sortTasksForColumn(filteredTasks.filter((task) => task.status === 'todo'), data.settings.columnSorts.todo),
      done: sortTasksForColumn(filteredTasks.filter((task) => task.status === 'done'), data.settings.columnSorts.done),
    }),
    [data.settings.columnSorts, filteredTasks],
  )

  const doingCount = data.tasks.filter((task) => task.status === 'doing').length
  const activeCount = data.tasks.filter((task) => task.status !== 'done').length
  const overdueCount = data.tasks.filter(
    (task) => task.status !== 'done' && task.dueAt && new Date(task.dueAt).getTime() < Date.now(),
  ).length
  const miniTasks = groupedTasks[data.settings.miniColumn]
  const selectedDockTask = dockState.docked ? miniTasks.find((task) => task.id === selectedTaskId) : undefined
  const selectedDockTaskId = selectedDockTask?.id || ''
  const expandedDockTask = dockDetailOpen ? selectedDockTask : undefined
  const multiSelectedTasks = useMemo(
    () => multiSelectedTaskIds
      .map((taskId) => data.tasks.find((task) => task.id === taskId))
      .filter((task): task is Task => Boolean(task)),
    [data.tasks, multiSelectedTaskIds],
  )

  function updateOriginFilter(nextFilter: TaskOriginFilter) {
    setOriginFilter(nextFilter)
    setSelectedTaskId('')
    setMultiSelectedTaskIds([])
    closeDockDetailWindow()
  }

  const openDockDetailWindow = useCallback(async () => {
    if (!dockState.docked || dockDetailOpen) return
    await window.todoDesk?.setDockDetailOpen?.(true)
  }, [dockDetailOpen, dockState.docked])

  const closeDockDetailWindow = useCallback(() => {
    setDockDetailOpenState(false)
    if (dockState.docked) {
      void window.todoDesk?.setDockDetailOpen?.(false)
    }
  }, [dockState.docked])

  useEffect(() => {
    if (dockDetailOpen && !selectedDockTaskId) {
      closeDockDetailWindow()
    }
  }, [closeDockDetailWindow, dockDetailOpen, selectedDockTaskId])

  const persist = useCallback(async (nextData: AppData) => {
    const saved = await saveData(nextData)
    setData(saved)
    return saved
  }, [])

  useEffect(() => {
    const taskIds = new Set(data.tasks.map((task) => task.id))
    setMultiSelectedTaskIds((current) => current.filter((taskId) => taskIds.has(taskId)))
    setSelectedTaskId((current) => (current && !taskIds.has(current) ? '' : current))
  }, [data.tasks])

  function selectTask(taskId: string, event?: { metaKey?: boolean; ctrlKey?: boolean }) {
    const isMultiSelect = Boolean(event?.metaKey || event?.ctrlKey)
    if (isMultiSelect) {
      setMultiSelectedTaskIds((current) => {
        const base = current.length || !selectedTaskId || selectedTaskId === taskId ? current : [selectedTaskId, ...current]
        const exists = base.includes(taskId)
        const next = exists ? base.filter((id) => id !== taskId) : [...base, taskId]
        setSelectedTaskId(next[next.length - 1] ?? '')
        return next
      })
      return
    }

    setMultiSelectedTaskIds([])
    setSelectedTaskId((current) => (current === taskId ? '' : taskId))
  }

  async function selectDockTask(taskId: string, event?: { metaKey?: boolean; ctrlKey?: boolean }) {
    const isMultiSelect = Boolean(event?.metaKey || event?.ctrlKey)
    if (isMultiSelect) {
      closeDockDetailWindow()
      selectTask(taskId, event)
      return
    }

    setMultiSelectedTaskIds([])
    const isSameTask = selectedTaskId === taskId
    const shouldOpenDetail = isSameTask ? !dockDetailOpen : true

    if (shouldOpenDetail) {
      // Expand the native window before mounting the detail pane to avoid a one-frame flash.
      await openDockDetailWindow()
      setSelectedTaskId(taskId)
      setDockDetailOpenState(true)
      return
    }

    setSelectedTaskId(taskId)
    closeDockDetailWindow()
  }

  function buildPlainMergedTask(tasks: Task[]): Pick<Task, 'title' | 'detail'> {
    return {
      title: tasks.map((task) => task.title).join(' / '),
      detail: tasks.map((task) => [task.title, task.detail].filter(Boolean).join('\n')).join('\n\n'),
    }
  }

  async function mergeSelectedTasks(mode: 'plain' | 'ai') {
    if (mergingMode) return
    if (multiSelectedTasks.length < 2) {
      setSyncState('至少按 Command 选择两个任务')
      return
    }

    const sourceTasks = multiSelectedTasks
    let mergedContent = buildPlainMergedTask(sourceTasks)

    setMergingMode(mode)
    setSyncState(mode === 'ai' ? `正在 AI 合并 ${sourceTasks.length} 个任务...` : `正在合并 ${sourceTasks.length} 个任务...`)
    setAiState(mode === 'ai' ? 'AI 合并中...' : '普通合并中...')

    if (mode === 'ai') {
      if (!window.todoDesk?.mergeTasks) {
        setSyncState('AI 合并需要桌面 App 运行')
        setAiState('AI 合并需要桌面 App 运行')
        setMergingMode('')
        return
      }
      try {
        const result = await window.todoDesk.mergeTasks({ tasks: sourceTasks, settings: data.settings })
        if (!result.ok || !result.task) {
          const message = result.message || 'AI 合并失败'
          setSyncState(message)
          setAiState(message)
          setMergingMode('')
          return
        }
        mergedContent = {
          title: result.task.title?.trim() || mergedContent.title,
          detail: result.task.detail?.trim() || mergedContent.detail,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'AI 合并失败'
        setSyncState(message)
        setAiState(message)
        setMergingMode('')
        return
      }
    }

    const now = new Date().toISOString()
    const sourceIdSet = new Set(sourceTasks.map((task) => task.id))
    const firstSourceIndex = data.tasks.findIndex((task) => task.id === sourceTasks[0].id)
    const mergedTask: Task = {
      id: crypto.randomUUID(),
      title: mergedContent.title,
      detail: mergedContent.detail,
      status: pickMergedStatus(sourceTasks),
      priority: pickMergedPriority(sourceTasks),
      project: mergeUniqueStrings(sourceTasks.map((task) => task.project)).join(' / '),
      tags: mergeUniqueStrings(sourceTasks.flatMap((task) => task.tags)),
      dueAt: pickEarliestDate(sourceTasks.map((task) => task.dueAt)),
      reminderAt: pickEarliestDate(sourceTasks.map((task) => task.reminderAt)),
      imagePaths: sourceTasks.flatMap((task) => task.imagePaths),
      createdAt: now,
      updatedAt: now,
      completedAt: sourceTasks.every((task) => task.status === 'done') ? now : '',
      origin: createHumanTaskOrigin(mode === 'ai' ? 'ui-ai-merge' : 'ui-merge'),
      remindedAt: '',
      source: mode === 'ai' ? 'ai-merge' : 'merge',
      agent: mergeUniqueStrings(sourceTasks.map((task) => task.agent || '')).join(' / '),
      agentSessionId: mergeUniqueStrings(sourceTasks.map((task) => task.agentSessionId || '')).join(' / '),
      repository: mergeUniqueStrings(sourceTasks.map((task) => task.repository || '')).join(' / '),
      repositoryPath: mergeUniqueStrings(sourceTasks.map((task) => task.repositoryPath || '')).join(' / '),
    }
    const deletedAt = now
    const nextTasks = data.tasks.filter((task) => !sourceIdSet.has(task.id))
    nextTasks.splice(Math.max(0, firstSourceIndex), 0, mergedTask)
    const trashedTasks = sourceTasks.map((task) => ({
      ...task,
      deletedAt,
      updatedAt: deletedAt,
    }))
    try {
      await persist({
        ...data,
        tasks: nextTasks,
        trash: [...trashedTasks, ...(data.trash ?? [])],
      })
      setSelectedTaskId(mergedTask.id)
      setMultiSelectedTaskIds([])
      const doneMessage = mode === 'ai' ? 'AI 合并完成，原任务已放入回收箱' : '普通合并完成，原任务已放入回收箱'
      setSyncState(doneMessage)
      setAiState(doneMessage)
      if (sourceIdSet.has(editingTaskId)) {
        setEditingTaskId('')
        setDraft(emptyTaskDraft)
        setAttachedImages([])
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '合并保存失败'
      setSyncState(message)
      setAiState(message)
    } finally {
      setMergingMode('')
    }
  }

  function buildTaskFromDraft(existing?: Task): Task {
    const now = new Date().toISOString()
    const status = draft.status
    const wasDone = existing?.status === 'done'
    const willBeDone = status === 'done'
    return {
      id: existing?.id ?? crypto.randomUUID(),
      title: draft.title.trim(),
      detail: draft.detail.trim(),
      status,
      priority: draft.priority,
      project: draft.project.trim(),
      tags: parseTags(draft.tags),
      dueAt: fromLocalInputValue(draft.dueAt),
      reminderAt: fromLocalInputValue(draft.reminderAt),
      imagePaths: attachedImages,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      completedAt: willBeDone ? existing?.completedAt || now : wasDone ? '' : existing?.completedAt || '',
      origin: existing?.origin ?? createHumanTaskOrigin('ui-form'),
      remindedAt: existing?.remindedAt ?? '',
      source: existing?.source,
      agent: existing?.agent,
      agentSessionId: existing?.agentSessionId,
      repository: existing?.repository,
      repositoryPath: existing?.repositoryPath,
    }
  }

  function startCreate(status: TaskStatus) {
    setEditingTaskId('')
    setDraft({ ...emptyTaskDraft, status })
    setAttachedImages([])
    setSelectedTaskId('')
  }

  function startEdit(task: Task) {
    setEditingTaskId(task.id)
    setDraft(buildDraftFromTask(task))
    setAttachedImages(task.imagePaths ?? [])
    setSelectedTaskId(task.id)
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!draft.title.trim()) return

    const existing = data.tasks.find((task) => task.id === editingTaskId)
    const nextTask = buildTaskFromDraft(existing)
    const nextTasks = existing
      ? data.tasks.map((task) => (task.id === existing.id ? nextTask : task))
      : [nextTask, ...data.tasks]
    const saved = await persist({ ...data, tasks: nextTasks })
    setSelectedTaskId(nextTask.id)
    setEditingTaskId(nextTask.id)
    setData(saved)

    if (!existing) {
      setDraft(buildDraftFromTask(nextTask))
    }
  }

  async function parseTextToDrafts(text: string, status: TaskStatus, images: TaskImage[] = []) {
    const trimmed = text.trim()
    if (!trimmed && images.length === 0) return [{ ...emptyTaskDraft, status }]
    if (!data.settings.aiEnabled) {
      setAiState('AI 元数据识别未启用')
      return [{ ...emptyTaskDraft, title: trimmed, status }]
    }
    if (!window.todoDesk?.parseTask) {
      setAiState('AI 解析需要桌面 App 运行')
      return [{ ...emptyTaskDraft, title: trimmed, status }]
    }

    setAiState(images.length ? '正在识别图片、任务和时间...' : '正在识别任务、时间和标签...')
    try {
      const result = await window.todoDesk.parseTask({ text: trimmed, settings: data.settings, images })
      const parsedTasks = result.tasks?.length ? result.tasks : result.task ? [result.task] : []
      if (result.ok && parsedTasks.length) {
        const imageSource = result.imageMode === 'ocr' ? 'OCR' : images.length ? '图片' : '文本'
        setAiState(parsedTasks.length > 1 ? `AI 已从${imageSource}识别 ${parsedTasks.length} 个任务` : 'AI 已填充元数据')
        return parsedTasks.map((task) => applyParsedTaskToDraft(task, trimmed, status))
      }
      setAiState(result.message || 'AI 解析失败，已按普通文本添加')
    } catch (error) {
      setAiState(error instanceof Error ? error.message : 'AI 解析失败，已按普通文本添加')
    }
    return [{ ...emptyTaskDraft, title: trimmed, status }]
  }

  async function parseTextToDraft(text: string, status: TaskStatus, images: TaskImage[] = []) {
    const drafts = await parseTextToDrafts(text, status, images)
    return drafts[0] ?? { ...emptyTaskDraft, title: text.trim(), status }
  }

  async function handleQuickSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmed = quickText.trim()
    // Mini mode does not show an attachment tray, so never apply hidden stale images there.
    const quickImages = data.settings.appMode === 'mini' ? [] : attachedImages
    if (!trimmed && quickImages.length === 0) return
    if (submitState) return
    const targetStatus =
      (dockState.docked || data.settings.appMode === 'mini') && data.settings.miniColumn !== 'done'
        ? data.settings.miniColumn
        : 'todo'
    setSubmitState('正在添加...')
    setAiState(data.settings.aiEnabled ? '正在解析并添加任务...' : '正在添加任务...')
    try {
      const parsedDrafts = await parseTextToDrafts(trimmed, targetStatus, quickImages)
      const nextTasks = parsedDrafts.map((parsedDraft) => createTaskFromDraft(parsedDraft, trimmed || '图片中的任务', quickImages, 'ui-quick-add'))
      const saved = await persist({ ...data, tasks: [...nextTasks, ...data.tasks] })
      setData(saved)
      setSelectedTaskId(nextTasks[0]?.id ?? '')
      setQuickText('')
      setAttachedImages([])
      const message = nextTasks.length > 1 ? `已添加 ${nextTasks.length} 个任务` : `已添加：${nextTasks[0]?.title || '任务'}`
      setSubmitState(message)
      setAiState(message)
      window.setTimeout(() => setSubmitState(''), 1800)
    } catch (error) {
      const message = error instanceof Error ? error.message : '添加任务失败'
      setSubmitState(message)
      setAiState(message)
    }
  }

  async function fillDraftWithAi() {
    const source = [draft.title, draft.detail].filter(Boolean).join('\n')
    if (!source.trim() && attachedImages.length === 0) {
      setAiState('先输入标题、详情或附加图片')
      return
    }
    const parsedDraft = await parseTextToDraft(source, draft.status, attachedImages)
    setDraft(parsedDraft)
  }

  const updateTask = useCallback(
    async (taskId: string, patch: Partial<Task>) => {
      const now = new Date().toISOString()
      const nextData = {
        ...data,
        tasks: data.tasks.map((task) =>
          task.id === taskId
            ? {
                ...task,
                ...patch,
                updatedAt: now,
              }
            : task,
        ),
      }
      return persist(nextData)
    },
    [data, persist],
  )

  const syncToLark = useCallback(
    async (nextData = data, completedTaskId?: string) => {
      if (!window.todoDesk) {
        setSyncState('飞书同步需要桌面 App 运行')
        return
      }
      setSyncState('正在同步飞书...')
      try {
        const result = await window.todoDesk.syncToLark({ data: nextData, completedTaskId })
        if (result.ok && result.data) {
          setData(result.data)
          setSyncState(`同步成功 ${formatDateTime(new Date().toISOString())}`)
          return
        }
        setSyncState(result.message ?? '同步已跳过')
      } catch (error) {
        setSyncState(error instanceof Error ? error.message : '飞书同步失败')
      }
    },
    [data],
  )

  const completeTask = useCallback(
    async (taskId: string) => {
      const currentTask = data.tasks.find((task) => task.id === taskId)
      if (!currentTask || currentTask.status === 'done') return

      const completedAt = new Date().toISOString()
      const nextData = {
        ...data,
        tasks: data.tasks.map((task) =>
          task.id === taskId
            ? {
                ...task,
                status: 'done' as TaskStatus,
                completedAt,
                updatedAt: completedAt,
              }
            : task,
        ),
      }
      const saved = await persist(nextData)
      setSelectedTaskId(taskId)

      if (saved.settings.syncOnComplete) {
        syncToLark(saved, taskId)
      }
    },
    [data, persist, syncToLark],
  )

  async function toggleDone(taskId: string) {
    const currentTask = data.tasks.find((task) => task.id === taskId)
    if (!currentTask) return
    if (currentTask.status === 'done') {
      await reopenTask(taskId, 'todo')
      return
    }
    await completeTask(taskId)
  }

  async function reopenTask(taskId: string, status: TaskStatus = 'todo') {
    await updateTask(taskId, { status, completedAt: '' })
  }

  async function moveTask(taskId: string, status: TaskStatus) {
    const currentTask = data.tasks.find((task) => task.id === taskId)
    if (!currentTask || currentTask.status === status) {
      setDraggingTaskId('')
      return
    }

    const completedAt = status === 'done' ? currentTask.completedAt || new Date().toISOString() : ''
    const saved = await updateTask(taskId, { status, completedAt })
    setSelectedTaskId(taskId)
    setDraggingTaskId('')

    if (status === 'done' && currentTask.status !== 'done' && saved.settings.syncOnComplete) {
      syncToLark(saved, taskId)
    }
  }

  useEffect(() => {
    function handleKeyDown(event: globalThis.KeyboardEvent) {
      const isCommand = event.metaKey || event.ctrlKey
      if (!isCommand) return
      if (event.key.toLowerCase() === 'n') {
        event.preventDefault()
        startCreate('todo')
      }
      if (event.key.toLowerCase() === 'f') {
        event.preventDefault()
        document.querySelector<HTMLInputElement>('#search')?.focus()
      }
      if (event.key === 'Enter' && selectedTaskId) {
        event.preventDefault()
        completeTask(selectedTaskId)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedTaskId, completeTask])

  useEffect(() => {
    if (!imagePreview) return undefined

    function handlePreviewKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        setImagePreview(null)
        return
      }
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      event.preventDefault()
      setImagePreview((current) => {
        if (!current || current.images.length <= 1) return current
        const direction = event.key === 'ArrowRight' ? 1 : -1
        const nextIndex = (current.index + direction + current.images.length) % current.images.length
        return { ...current, index: nextIndex }
      })
    }

    window.addEventListener('keydown', handlePreviewKeyDown)
    return () => window.removeEventListener('keydown', handlePreviewKeyDown)
  }, [imagePreview])

  useEffect(() => {
    if (!('Notification' in window)) return
    if (!data.settings.desktopReminders) return

    const timer = window.setInterval(() => {
      const dueReminder = data.tasks.find(
        (task) =>
          task.status !== 'done' &&
          task.reminderAt &&
          !task.remindedAt &&
          new Date(task.reminderAt).getTime() <= Date.now(),
      )
      if (!dueReminder) return

      const notify = () => {
        new Notification('Todo Desk 提醒', {
          body: dueReminder.title,
        })
      }

      if (Notification.permission === 'granted') {
        notify()
      } else if (Notification.permission === 'default') {
        Notification.requestPermission().then((permission) => {
          if (permission === 'granted') notify()
        })
      }

      updateTask(dueReminder.id, { remindedAt: new Date().toISOString() })
    }, 30_000)

    return () => window.clearInterval(timer)
  }, [data.settings.desktopReminders, data.tasks, updateTask])

  async function deleteTask(taskId: string) {
    const taskToDelete = data.tasks.find((task) => task.id === taskId)
    if (!taskToDelete) return

    const deletedAt = new Date().toISOString()
    const nextTasks = data.tasks.filter((task) => task.id !== taskId)
    const trashedTask = {
      ...taskToDelete,
      deletedAt,
      updatedAt: deletedAt,
    }
    await persist({ ...data, tasks: nextTasks, trash: [trashedTask, ...(data.trash ?? [])] })
    if (selectedTaskId === taskId) {
      setSelectedTaskId(nextTasks[0]?.id ?? '')
    }
    if (editingTaskId === taskId) {
      startCreate('todo')
    }
  }

  async function restoreTask(taskId: string) {
    const taskToRestore = data.trash.find((task) => task.id === taskId)
    if (!taskToRestore) return

    const restoredAt = new Date().toISOString()
    const { deletedAt: _deletedAt, ...restoredTask } = taskToRestore
    const nextData = await persist({
      ...data,
      tasks: [{ ...restoredTask, updatedAt: restoredAt }, ...data.tasks],
      trash: data.trash.filter((task) => task.id !== taskId),
    })
    setData(nextData)
    setSelectedTaskId(taskId)
  }

  async function purgeTask(taskId: string) {
    await persist({ ...data, trash: data.trash.filter((task) => task.id !== taskId) })
  }

  async function emptyTrash() {
    await persist({ ...data, trash: [] })
  }

  async function updateSettings(patch: Partial<AppSettings>) {
    if (patch.appMode && patch.appMode !== data.settings.appMode) {
      await window.todoDesk?.applyWindowMode?.(patch.appMode)
      setEditingTaskId('')
      setAttachedImages([])
    }
    const nextData = {
      ...data,
      settings: {
        ...data.settings,
        ...patch,
      },
    }
    await persist(nextData)
  }

  async function updateColumnSort(status: TaskStatus, sortMode: TaskSortMode) {
    setOpenSortColumn('')
    await updateSettings({
      columnSorts: {
        ...data.settings.columnSorts,
        [status]: sortMode,
      },
    })
  }

  async function importImages() {
    if (!window.todoDesk) {
      setSyncState('图片导入需要桌面 App 运行')
      return
    }
    const images = await window.todoDesk.importImages()
    if (images.length) {
      setAttachedImages((current) => [...current, ...images])
    }
  }

  async function pasteImagesFromClipboard() {
    if (!window.todoDesk?.pasteImages) {
      setSyncState('粘贴图片需要桌面 App 运行')
      return
    }
    const images = await window.todoDesk.pasteImages()
    if (images.length) {
      setAttachedImages((current) => [...current, ...images])
      setAiState(`已从剪贴板附加 ${images.length} 张图片`)
      return
    }
    setAiState('剪贴板里没有可用图片')
  }

  async function handlePasteImages(event: ClipboardEvent<HTMLElement>) {
    const imageItems = Array.from(event.clipboardData?.items || []).filter((item) => item.type.startsWith('image/'))
    if (imageItems.length === 0) return
    event.preventDefault()

    if (!window.todoDesk?.savePastedImage) {
      setSyncState('粘贴图片需要桌面 App 运行')
      return
    }

    const savedImages: TaskImage[] = []
    for (const item of imageItems) {
      const file = item.getAsFile()
      if (!file) continue
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result || ''))
        reader.onerror = () => reject(new Error('读取剪贴板图片失败'))
        reader.readAsDataURL(file)
      })
      const images = await window.todoDesk.savePastedImage({
        name: file.name || `粘贴图片 ${new Date().toLocaleString('zh-CN')}.png`,
        dataUrl,
      })
      savedImages.push(...images)
    }

    if (savedImages.length) {
      setAttachedImages((current) => [...current, ...savedImages])
      setAiState(`已粘贴 ${savedImages.length} 张图片`)
    }
  }

  function removeImage(path: string) {
    setAttachedImages((current) => current.filter((image) => image.path !== path))
  }

  function renderAttachedImages() {
    return (
      <div className="image-row">
        {attachedImages.map((image) => (
          <button
            key={image.path}
            className="image-chip"
            type="button"
            title="移除图片"
            onClick={() => removeImage(image.path)}
          >
            <img src={image.url} alt="" />
          </button>
        ))}
        <button className="ghost-button" type="button" onClick={importImages}>
          附加图片
        </button>
        <button className="ghost-button" type="button" onClick={pasteImagesFromClipboard}>
          粘贴图片
        </button>
      </div>
    )
  }

  async function revealStorage() {
    if (!window.todoDesk) {
      setSyncState('浏览器模式数据保存在 localStorage')
      return
    }
    await window.todoDesk.revealStorage()
  }

  async function revealLogs() {
    if (!window.todoDesk?.revealLogs) {
      setSyncState('日志文件需要桌面 App 运行')
      return
    }
    await window.todoDesk.revealLogs()
  }

  function handleDraftKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.currentTarget.form?.requestSubmit()
    }
  }

  function openImagePreview(images: TaskImage[], index: number, title: string) {
    if (!images.length) return
    setImagePreview({ images, index, title })
  }

  async function copyTask(task: Task) {
    try {
      await copyTextToClipboard(formatTaskForClipboard(task))
      setSyncState(`已复制：${task.title}`)
      setAiState(`已复制：${task.title}`)
    } catch (error) {
      setSyncState(error instanceof Error ? error.message : '复制失败')
    }
  }

  async function openCalendar(task: Task) {
    if (!task.reminderAt && !task.dueAt) {
      setSyncState('这个任务没有提醒时间或截止时间')
      setAiState('先给任务设置提醒时间或截止时间')
      return
    }
    if (!window.todoDesk?.openTaskInCalendar) {
      setSyncState('加入日历需要桌面 App 运行')
      return
    }
    const result = await window.todoDesk.openTaskInCalendar(task)
    const message = result.ok ? '已生成日历事件并打开系统日历' : result.message || '加入日历失败'
    setSyncState(message)
    setAiState(message)
  }

  async function openAgentSession(task: Task) {
    if (!window.todoDesk?.openAgentSession) {
      setSyncState('跳转 session 需要桌面 App 运行')
      return
    }
    const result = await window.todoDesk.openAgentSession(task)
    const message = result.ok ? '已打开关联 Codex session' : result.message || '打开 agent session 失败'
    setSyncState(message)
    setAiState(message)
  }

  async function dockToEdge(edge: 'left' | 'right') {
    if (!window.todoDesk?.dockToEdge) {
      setSyncState('贴附需要桌面 App 运行')
      return
    }
    setSelectedTaskId('')
    setDockDetailOpenState(false)
    await window.todoDesk.dockToEdge(edge)
  }

  if (!isLoaded) {
    return (
      <main className="loading-shell">
        <div className="loading-mark">TD</div>
        <p>正在读取本地看板</p>
      </main>
    )
  }

  const isQuickComposer = !editingTaskId && data.settings.addMode === 'quick'
  const hasExpandedTask = dockState.docked ? Boolean(expandedDockTask) : Boolean(selectedTaskId)

  if (dockState.docked) {
    return (
      <main className={`app-shell dock-shell dock-${dockState.edge || 'right'} ${expandedDockTask ? 'dock-has-popover' : ''}`}>
        <section className="dock-card">
          <div className="dock-top-actions">
            <button className="dock-restore" type="button" title="恢复窗口" onClick={() => window.todoDesk?.restoreDock()}>
              ↔
            </button>
            <button className="dock-collapse" type="button" title="收起详情" disabled={!hasExpandedTask} onClick={closeDockDetailWindow}>
              ⌃
            </button>
          </div>
          <h1>{statusConfig[data.settings.miniColumn].label}</h1>
          <div className={`dock-body ${multiSelectedTasks.length > 1 ? 'has-merge' : ''}`}>
            {multiSelectedTasks.length > 1 && (
              <div className="dock-merge-bar">
                <span>{multiSelectedTasks.length} 项</span>
                <button type="button" disabled={Boolean(mergingMode)} onClick={() => mergeSelectedTasks('plain')}>
                  {mergingMode === 'plain' ? '合并中' : '合并'}
                </button>
                <button type="button" disabled={Boolean(mergingMode)} onClick={() => mergeSelectedTasks('ai')}>
                  {mergingMode === 'ai' ? 'AI 中' : 'AI'}
                </button>
              </div>
            )}
            <div className="dock-list">
              {miniTasks.map((task) => (
                <article
                  key={task.id}
                  className={`dock-task-item ${isAgentCreatedTask(task) ? 'agent-task' : ''} ${task.id === selectedTaskId ? 'selected' : ''} ${multiSelectedTaskIds.includes(task.id) ? 'multi-selected' : ''}`}
                >
                  <button
                    className="dock-task-head"
                    type="button"
                    onClick={(event) => selectDockTask(task.id, event)}
                  >
                    <strong>{task.title}</strong>
                    <small>{getTaskTimeLabel(task)}</small>
                  </button>
                </article>
              ))}
              {miniTasks.length === 0 && <span className="dock-empty">暂无任务</span>}
            </div>
          </div>
          <form className="dock-add-form" onSubmit={handleQuickSubmit}>
            <input
              value={quickText}
              onChange={(event) => setQuickText(event.target.value)}
              placeholder="添加任务"
            />
            <button className="primary-button" type="submit" title="添加任务" disabled={submitState === '正在添加...'}>
              {submitState === '正在添加...' ? '...' : '+'}
            </button>
          </form>
        </section>
        {expandedDockTask && (
          <aside className="dock-popover" aria-label="任务详情">
            <header>
              <span className={`priority priority-${expandedDockTask.priority}`}>{priorityConfig[expandedDockTask.priority].label}</span>
              <button type="button" title="收起详情" onClick={closeDockDetailWindow}>
                ×
              </button>
            </header>
            <div className="dock-popover-scroll">
              <strong>{expandedDockTask.title}</strong>
              {expandedDockTask.detail && <p>{expandedDockTask.detail}</p>}
              <dl>
                <div>
                  <dt>创建</dt>
                  <dd>{formatDateTime(expandedDockTask.createdAt)}</dd>
                </div>
                <div>
                  <dt>状态</dt>
                  <dd>{statusConfig[expandedDockTask.status].label}</dd>
                </div>
                {expandedDockTask.project && (
                  <div>
                    <dt>项目</dt>
                    <dd>{expandedDockTask.project}</dd>
                  </div>
                )}
                {expandedDockTask.dueAt && (
                  <div>
                    <dt>截止</dt>
                    <dd>{formatDateTime(expandedDockTask.dueAt)}</dd>
                  </div>
                )}
                {expandedDockTask.reminderAt && (
                  <div>
                    <dt>提醒</dt>
                    <dd>{formatDateTime(expandedDockTask.reminderAt)}</dd>
                  </div>
                )}
              </dl>
              {expandedDockTask.tags.length > 0 && (
                <div className="dock-detail-meta">
                  {expandedDockTask.tags.map((tag) => (
                    <span key={tag}>#{tag}</span>
                  ))}
                </div>
              )}
              {expandedDockTask.imagePaths.length > 0 && (
                <div className="preview-grid inline-preview-grid">
                  {expandedDockTask.imagePaths.map((image, index) => (
                    <button
                      key={image.path}
                      className="preview-thumb"
                      type="button"
                      title="查看大图"
                      onClick={() => openImagePreview(expandedDockTask.imagePaths, index, expandedDockTask.title)}
                    >
                      <img src={image.url} alt={image.name} />
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="dock-detail-actions">
              {expandedDockTask.status !== 'done' && (
                <button type="button" onClick={() => moveTask(expandedDockTask.id, 'done')}>
                  完成
                </button>
              )}
              {expandedDockTask.status !== 'doing' && (
                <button type="button" onClick={() => moveTask(expandedDockTask.id, 'doing')}>
                  做
                </button>
              )}
              <button type="button" onClick={() => copyTask(expandedDockTask)}>
                复制
              </button>
              {canOpenAgentSession(expandedDockTask) && (
                <button type="button" onClick={() => openAgentSession(expandedDockTask)}>
                  会话
                </button>
              )}
              {(expandedDockTask.reminderAt || expandedDockTask.dueAt) && (
                <button type="button" onClick={() => openCalendar(expandedDockTask)}>
                  日历
                </button>
              )}
              <button type="button" onClick={() => startEdit(expandedDockTask)}>
                编辑
              </button>
            </div>
          </aside>
        )}
      </main>
    )
  }

  if (data.settings.appMode === 'mini') {
    return (
      <main className="app-shell mini-shell">
        <header className="mini-titlebar">
          <div className="brand mini-brand">
            <div className="brand-mark">TD</div>
            <div>
              <h1>Todo Desk</h1>
              <p>{statusConfig[data.settings.miniColumn].label} · {miniTasks.length}</p>
            </div>
          </div>
          <div className="title-actions">
            <button
              className="ghost-icon-button"
              type="button"
              title="全部任务收起"
              disabled={!hasExpandedTask}
              onClick={() => setSelectedTaskId('')}
            >
              ⌃
            </button>
            <button className="ghost-icon-button" type="button" title="返回正常模式" onClick={() => updateSettings({ appMode: 'normal' })}>
              ↗
            </button>
            <button className="ghost-icon-button" type="button" title={`回收箱 ${data.trash.length}`} onClick={() => setTrashOpen(true)}>
              🗑
            </button>
            <button className="icon-button" type="button" title="设置" onClick={() => setSettingsOpen(true)}>
              ⚙
            </button>
          </div>
        </header>

        <section className="mini-panel">
          <div className="mini-tabs" role="group" aria-label="小卡列表">
            {taskStatuses.map((status) => (
              <button
                key={status}
                className={data.settings.miniColumn === status ? 'active' : ''}
                type="button"
                onClick={() => updateSettings({ miniColumn: status })}
              >
                {statusConfig[status].label}
                <small>{groupedTasks[status].length}</small>
              </button>
            ))}
          </div>
          <OriginFilterControl
            value={originFilter}
            counts={originFilterCounts}
            onChange={updateOriginFilter}
            compact
          />

          <div className="mini-list">
            {multiSelectedTasks.length > 1 && (
              <SelectionMergeBar
                count={multiSelectedTasks.length}
                onPlainMerge={() => mergeSelectedTasks('plain')}
                onAiMerge={() => mergeSelectedTasks('ai')}
                onClear={() => setMultiSelectedTaskIds([])}
                mergingMode={mergingMode}
              />
            )}
            {miniTasks.length === 0 && <p className="empty-state">这里暂时没有事项</p>}
            {miniTasks.map((task) => (
              <MiniTaskRow
                key={task.id}
                task={task}
                selected={task.id === selectedTaskId}
                multiSelected={multiSelectedTaskIds.includes(task.id)}
                onSelect={selectTask}
                onToggleExpand={(taskId) => setSelectedTaskId((current) => (current === taskId ? '' : taskId))}
                onEdit={startEdit}
                onToggleDone={toggleDone}
                onMove={moveTask}
                onDelete={deleteTask}
                onPreviewImages={openImagePreview}
                onCopy={copyTask}
                onOpenCalendar={openCalendar}
                onOpenAgentSession={openAgentSession}
              />
            ))}
          </div>

          <form className="mini-quick-add" onSubmit={handleQuickSubmit} onPaste={handlePasteImages}>
            <input
              value={quickText}
              onChange={(event) => setQuickText(event.target.value)}
              placeholder="添加任务"
            />
            <button className="primary-button" type="submit" disabled={submitState === '正在添加...'}>
              {submitState === '正在添加...' ? '...' : 'AI'}
            </button>
          </form>
        </section>

        {settingsOpen && (
          <div className="settings-backdrop" role="presentation" onMouseDown={() => setSettingsOpen(false)}>
            <aside
              className="settings-panel"
              role="dialog"
              aria-modal="true"
              aria-label="Todo Desk 设置"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <header className="settings-head">
                <div>
                  <h2>后台设置</h2>
                  <p>同步、窗口和 AI 接口都在这里配置</p>
                </div>
                <button className="icon-button" type="button" title="关闭设置" onClick={() => setSettingsOpen(false)}>
                  ×
                </button>
              </header>
              <button type="button" onClick={() => updateSettings({ appMode: 'normal' })}>
                返回正常模式
              </button>
              <button type="button" onClick={revealLogs}>
                打开日志文件
              </button>
              <p className="settings-status">{syncState}</p>
            </aside>
          </div>
        )}

        {trashOpen && (
          <TrashDialog
            tasks={data.trash}
            onClose={() => setTrashOpen(false)}
            onRestore={restoreTask}
            onPurge={purgeTask}
            onEmpty={emptyTrash}
          />
        )}

        {imagePreview && (
          <ImagePreviewDialog
            preview={imagePreview}
            onClose={() => setImagePreview(null)}
            onMove={(direction) =>
              setImagePreview((current) => {
                if (!current || current.images.length <= 1) return current
                const nextIndex = (current.index + direction + current.images.length) % current.images.length
                return { ...current, index: nextIndex }
              })
            }
          />
        )}
      </main>
    )
  }

  return (
    <main className={`app-shell mode-${data.settings.appMode}`}>
      <header className="titlebar">
        <div className="brand">
          <div className="brand-mark">TD</div>
          <div>
            <h1>Todo Desk</h1>
            <p>
              进行中 {doingCount} · 待处理 {activeCount} · 逾期 {overdueCount}
            </p>
          </div>
        </div>
        <div className="title-actions">
          <div className="mode-switch" role="group" aria-label="显示模式">
            {appModeOptions.map((option) => (
              <button
                key={option.value}
                className={data.settings.appMode === option.value ? 'active' : ''}
                type="button"
                onClick={() => updateSettings({ appMode: option.value })}
              >
                {option.label}
              </button>
            ))}
          </div>
          <button
            className={`ghost-icon-button pin-button ${data.settings.keepOnTop ? 'active' : ''}`}
            type="button"
            title={data.settings.keepOnTop ? '取消置顶' : '窗口置顶'}
            onClick={() => updateSettings({ keepOnTop: !data.settings.keepOnTop })}
          >
            ⌃
          </button>
          <button
            className="ghost-icon-button"
            type="button"
            title="全部任务收起"
            disabled={!hasExpandedTask}
            onClick={() => setSelectedTaskId('')}
          >
            ▴
          </button>
          <button className="ghost-icon-button" type="button" title={`回收箱 ${data.trash.length}`} onClick={() => setTrashOpen(true)}>
            🗑
          </button>
          <button className="ghost-icon-button" type="button" title="贴附到左侧" onClick={() => dockToEdge('left')}>
            ⇤
          </button>
          <button className="ghost-icon-button" type="button" title="贴附到右侧" onClick={() => dockToEdge('right')}>
            ⇥
          </button>
          <span className={`sync-dot ${data.settings.larkDoc ? 'ready' : ''}`} title={syncState} />
          <button className="icon-button" type="button" title="设置" onClick={() => setSettingsOpen(true)}>
            ⚙
          </button>
        </div>
      </header>

      <section className="control-strip">
        <label className="search-box" htmlFor="search">
          <span aria-hidden="true">⌕</span>
          <input
            id="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="模糊搜索标题、详情、标签"
          />
        </label>
        <OriginFilterControl
          value={originFilter}
          counts={originFilterCounts}
          onChange={updateOriginFilter}
        />
        <button className="primary-button" type="button" onClick={() => startCreate('todo')}>
          新建任务 +
        </button>
      </section>

      <div className="quiet-status">
        <span>{data.settings.larkDoc ? '完成后自动同步飞书' : '未配置飞书文档'}</span>
        <span>本地 JSON 自动保存</span>
        <span>API {data.settings.apiEnabled ? `127.0.0.1:${data.settings.apiPort}` : '已关闭'}</span>
      </div>

      {multiSelectedTasks.length > 1 && (
        <SelectionMergeBar
          count={multiSelectedTasks.length}
          onPlainMerge={() => mergeSelectedTasks('plain')}
          onAiMerge={() => mergeSelectedTasks('ai')}
          onClear={() => setMultiSelectedTaskIds([])}
          mergingMode={mergingMode}
        />
      )}

      <section className="board board-three">
        {taskStatuses.map((status) => (
          <TaskColumn
            key={status}
            status={status}
            tasks={groupedTasks[status]}
            sortMode={data.settings.columnSorts[status]}
            sortOpen={openSortColumn === status}
            selectedTaskId={selectedTaskId}
            multiSelectedTaskIds={multiSelectedTaskIds}
            onAdd={() => startCreate(status === 'done' ? 'todo' : status)}
            onToggleSort={() => setOpenSortColumn((current) => (current === status ? '' : status))}
            onSortChange={(sortMode) => updateColumnSort(status, sortMode)}
            onSelect={selectTask}
            onEdit={startEdit}
            onComplete={completeTask}
            onToggleDone={toggleDone}
            draggingTaskId={draggingTaskId}
            onDragStart={setDraggingTaskId}
            onDropTask={moveTask}
            onMove={moveTask}
            onDelete={deleteTask}
            onPreviewImages={openImagePreview}
            onCopy={copyTask}
            onOpenCalendar={openCalendar}
            onOpenAgentSession={openAgentSession}
          />
        ))}
      </section>

      <section className="composer">
        <header className="section-head">
          <div>
            <h2>{editingTaskId ? '编辑任务' : '添加任务'}</h2>
            <p>{isQuickComposer ? '输入一句话或粘贴截图，AI 自动识别任务' : '手动维护完整任务信息，也可以粘贴截图'}</p>
          </div>
          {!editingTaskId && (
            <div className="mode-switch" role="group" aria-label="添加任务模式">
              {addModeOptions.map((option) => (
                <button
                  key={option.value}
                  className={data.settings.addMode === option.value ? 'active' : ''}
                  type="button"
                  onClick={() => updateSettings({ addMode: option.value })}
                >
                  {option.label}
                </button>
              ))}
            </div>
          )}
        </header>

        {isQuickComposer ? (
          <form className="quick-form" onSubmit={handleQuickSubmit} onPaste={handlePasteImages}>
            <textarea
              value={quickText}
              onChange={(event) => setQuickText(event.target.value)}
              placeholder="输入文字，或附加截图后让 AI 从图片里识别任务"
              disabled={submitState === '正在添加...'}
            />
            {renderAttachedImages()}
            <div className="form-actions">
              <span>{submitState || aiState}</span>
              <button className="primary-button" type="submit" disabled={submitState === '正在添加...'}>
                {submitState === '正在添加...' ? '添加中...' : '智能添加'}
              </button>
            </div>
          </form>
        ) : (
          <form onSubmit={handleSubmit} onPaste={handlePasteImages}>
          <div className="form-grid">
            <input
              className="title-input"
              value={draft.title}
              onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
              placeholder="写下正在做或要做的事"
            />
            <select
              value={draft.status}
              onChange={(event) =>
                setDraft((current) => ({ ...current, status: event.target.value as TaskStatus }))
              }
            >
              {Object.entries(statusConfig).map(([value, config]) => (
                <option key={value} value={value}>
                  {config.label}
                </option>
              ))}
            </select>
            <select
              value={draft.priority}
              onChange={(event) =>
                setDraft((current) => ({ ...current, priority: event.target.value as TaskPriority }))
              }
            >
              {Object.entries(priorityConfig).map(([value, config]) => (
                <option key={value} value={value}>
                  {config.label}优先级
                </option>
              ))}
            </select>
            <input
              value={draft.project}
              onChange={(event) => setDraft((current) => ({ ...current, project: event.target.value }))}
              placeholder="项目/分组"
            />
            <input
              value={draft.tags}
              onChange={(event) => setDraft((current) => ({ ...current, tags: event.target.value }))}
              placeholder="标签，用空格分隔"
            />
            <label className="time-field">
              <span>截止</span>
              <input
                type="datetime-local"
                value={draft.dueAt}
                onChange={(event) => setDraft((current) => ({ ...current, dueAt: event.target.value }))}
              />
            </label>
            <label className="time-field">
              <span>提醒</span>
              <input
                type="datetime-local"
                value={draft.reminderAt}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, reminderAt: event.target.value }))
                }
              />
            </label>
          </div>
          <textarea
            value={draft.detail}
            onKeyDown={handleDraftKeyDown}
            onChange={(event) => setDraft((current) => ({ ...current, detail: event.target.value }))}
            placeholder="补充细节、下一步动作或上下文"
          />
          {renderAttachedImages()}
          <div className="form-actions">
            <span>{aiState}</span>
            <button type="button" onClick={fillDraftWithAi}>
              AI 填充
            </button>
            <button type="button" onClick={() => startCreate('todo')}>
              清空
            </button>
            <button className="primary-button" type="submit">
              {editingTaskId ? '保存' : '加入看板'}
            </button>
          </div>
        </form>
        )}
      </section>

      {settingsOpen && (
        <div className="settings-backdrop" role="presentation" onMouseDown={() => setSettingsOpen(false)}>
          <aside
            className="settings-panel"
            role="dialog"
            aria-modal="true"
            aria-label="Todo Desk 设置"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="settings-head">
              <div>
                <h2>后台设置</h2>
                <p>同步、窗口和 AI 接口都在这里配置</p>
              </div>
              <button className="icon-button" type="button" title="关闭设置" onClick={() => setSettingsOpen(false)}>
                ×
              </button>
            </header>

            <label className="settings-field">
              <span>飞书文档 URL / Token</span>
              <input
                value={data.settings.larkDoc}
                onChange={(event) => updateSettings({ larkDoc: event.target.value })}
                placeholder="粘贴飞书文档 URL 或 token"
              />
            </label>

            <div className="settings-group">
              <label>
                <input
                  type="checkbox"
                  checked={data.settings.syncOnComplete}
                  onChange={(event) => updateSettings({ syncOnComplete: event.target.checked })}
                />
                完成后同步飞书
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={data.settings.desktopReminders}
                  onChange={(event) => updateSettings({ desktopReminders: event.target.checked })}
                />
                到点弹出 macOS 提醒
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={data.settings.keepOnTop}
                  onChange={(event) => updateSettings({ keepOnTop: event.target.checked })}
                />
                窗口置顶
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={data.settings.snapToEdge}
                  onChange={(event) => updateSettings({ snapToEdge: event.target.checked })}
                />
                拖到屏幕边缘自动吸附
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={data.settings.apiEnabled}
                  onChange={(event) => updateSettings({ apiEnabled: event.target.checked })}
                />
                开启本机 AI 写入接口
              </label>
            </div>

            <label className="settings-field">
              <span>本机写入接口端口</span>
              <input
                type="number"
                min="1024"
                max="65535"
                value={data.settings.apiPort}
                onChange={(event) => updateSettings({ apiPort: Number(event.target.value) || 47731 })}
              />
            </label>

            <div className="settings-section">
              <h3>AI 元数据识别</h3>
              <p>添加任务时调用兼容 OpenAI Chat Completions 的接口，自动识别时间、优先级、项目和标签。</p>
              <label>
                <input
                  type="checkbox"
                  checked={data.settings.aiEnabled}
                  onChange={(event) => updateSettings({ aiEnabled: event.target.checked })}
                />
                添加任务时启用 AI 解析
              </label>
              <label className="settings-field">
                <span>Base URL</span>
                <input
                  value={data.settings.aiBaseUrl}
                  onChange={(event) => updateSettings({ aiBaseUrl: event.target.value })}
                  placeholder="https://api.openai.com/v1"
                />
              </label>
              <label className="settings-field">
                <span>Model</span>
                <input
                  value={data.settings.aiModel}
                  onChange={(event) => updateSettings({ aiModel: event.target.value })}
                  placeholder="gpt-4o-mini"
                />
              </label>
              <label className="settings-field">
                <span>API Key</span>
                <input
                  type="password"
                  value={data.settings.aiApiKey}
                  onChange={(event) => updateSettings({ aiApiKey: event.target.value })}
                  placeholder="可选，本地保存"
                />
              </label>
            </div>

            <div className="settings-section">
              <h3>小卡模式</h3>
              <p>正常模式展示三列，小卡模式只展示一个列表；拖到左右屏幕边缘会自动变成贴边长条。</p>
              <label className="settings-field">
                <span>小卡展示列表</span>
                <select
                  value={data.settings.miniColumn}
                  onChange={(event) => updateSettings({ miniColumn: event.target.value as TaskStatus })}
                >
                  {taskStatuses.map((status) => (
                    <option key={status} value={status}>
                      {statusConfig[status].label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="api-example">
              <span>添加工作接口</span>
              <code>POST http://127.0.0.1:{data.settings.apiPort}/tasks</code>
            </div>

            <div className="api-example">
              <span>AI 报错日志</span>
              <code>~/Library/Application Support/todo-desk/todo-desk.log</code>
            </div>

            <div className="settings-actions">
              <button type="button" onClick={revealStorage}>
                打开本地数据
              </button>
              <button type="button" onClick={revealLogs}>
                打开日志文件
              </button>
              <button type="button" onClick={() => syncToLark()}>
                立即同步飞书
              </button>
            </div>
            <p className="settings-status">{syncState}</p>
          </aside>
        </div>
      )}

      {trashOpen && (
        <TrashDialog
          tasks={data.trash}
          onClose={() => setTrashOpen(false)}
          onRestore={restoreTask}
          onPurge={purgeTask}
          onEmpty={emptyTrash}
        />
      )}

      {imagePreview && (
        <ImagePreviewDialog
          preview={imagePreview}
          onClose={() => setImagePreview(null)}
          onMove={(direction) =>
            setImagePreview((current) => {
              if (!current || current.images.length <= 1) return current
              const nextIndex = (current.index + direction + current.images.length) % current.images.length
              return { ...current, index: nextIndex }
            })
          }
        />
      )}
    </main>
  )
}

interface TaskColumnProps {
  status: TaskStatus
  tasks: Task[]
  sortMode: TaskSortMode
  sortOpen: boolean
  selectedTaskId: string
  multiSelectedTaskIds: string[]
  onAdd: () => void
  onToggleSort: () => void
  onSortChange: (sortMode: TaskSortMode) => void
  onSelect: (taskId: string, event?: { metaKey?: boolean; ctrlKey?: boolean }) => void
  onEdit: (task: Task) => void
  onComplete: (taskId: string) => void
  onToggleDone: (taskId: string) => void
  draggingTaskId: string
  onDragStart: (taskId: string) => void
  onDropTask: (taskId: string, status: TaskStatus) => void
  onMove: (taskId: string, status: TaskStatus) => void
  onDelete: (taskId: string) => void
  onPreviewImages: (images: TaskImage[], index: number, title: string) => void
  onCopy: (task: Task) => void
  onOpenCalendar: (task: Task) => void
  onOpenAgentSession: (task: Task) => void
}

interface MiniTaskRowProps {
  task: Task
  selected: boolean
  multiSelected: boolean
  onSelect: (taskId: string, event?: { metaKey?: boolean; ctrlKey?: boolean }) => void
  onToggleExpand: (taskId: string) => void
  onEdit: (task: Task) => void
  onToggleDone: (taskId: string) => void
  onMove: (taskId: string, status: TaskStatus) => void
  onDelete: (taskId: string) => void
  onPreviewImages: (images: TaskImage[], index: number, title: string) => void
  onCopy: (task: Task) => void
  onOpenCalendar: (task: Task) => void
  onOpenAgentSession: (task: Task) => void
}

interface SelectionMergeBarProps {
  count: number
  onPlainMerge: () => void
  onAiMerge: () => void
  onClear: () => void
  mergingMode: '' | 'plain' | 'ai'
}

function SelectionMergeBar({ count, onPlainMerge, onAiMerge, onClear, mergingMode }: SelectionMergeBarProps) {
  return (
    <div className="selection-merge-bar">
      <span>{mergingMode ? (mergingMode === 'ai' ? 'AI 合并中...' : '普通合并中...') : `已选择 ${count} 个任务`}</span>
      <button type="button" disabled={Boolean(mergingMode)} onClick={onPlainMerge}>
        {mergingMode === 'plain' ? '合并中...' : '普通合并'}
      </button>
      <button type="button" disabled={Boolean(mergingMode)} onClick={onAiMerge}>
        {mergingMode === 'ai' ? 'AI 合并中...' : 'AI 合并'}
      </button>
      <button type="button" disabled={Boolean(mergingMode)} onClick={onClear}>
        取消
      </button>
    </div>
  )
}

function MiniTaskRow({ task, selected, multiSelected, onSelect, onToggleExpand, onEdit, onToggleDone, onMove, onDelete, onPreviewImages, onCopy, onOpenCalendar, onOpenAgentSession }: MiniTaskRowProps) {
  const isDone = task.status === 'done'

  return (
    <article
      className={`mini-task-row ${isAgentCreatedTask(task) ? 'agent-task' : ''} ${selected ? 'expanded' : ''} ${multiSelected ? 'multi-selected' : ''}`}
      onClick={(event) => onSelect(task.id, event)}
      onDoubleClick={() => onEdit(task)}
    >
      <div className="mini-task-main">
        <button
          className={`check ${isDone ? 'checked' : ''}`}
          type="button"
          aria-label={isDone ? '取消完成' : '完成任务'}
          onClick={(event) => {
            event.stopPropagation()
            onToggleDone(task.id)
          }}
        >
          ✓
        </button>
        <div className="mini-task-copy">
          <strong>{task.title}</strong>
          <small>{getTaskTimeLabel(task)}</small>
        </div>
        <span className={`priority priority-${task.priority}`}>{priorityConfig[task.priority].label}</span>
        <button
          className="mini-expand"
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            onToggleExpand(task.id)
          }}
        >
          {selected ? '⌃' : '⌄'}
        </button>
      </div>
      {selected && (
        <div className="mini-task-detail">
          <div className="mini-task-detail-scroll">
            {task.detail && <p>{task.detail}</p>}
            <div className="tag-list">
              <span>{statusConfig[task.status].label}</span>
              {task.project && <span>{task.project}</span>}
              {task.tags.map((tag) => (
                <span key={tag}>#{tag}</span>
              ))}
            </div>
            {task.imagePaths.length > 0 && (
              <div className="preview-grid inline-preview-grid">
                {task.imagePaths.map((image, index) => (
                  <button
                    key={image.path}
                    className="preview-thumb"
                    type="button"
                    title="查看大图"
                    onClick={(event) => {
                      event.stopPropagation()
                      onPreviewImages(task.imagePaths, index, task.title)
                    }}
                  >
                    <img src={image.url} alt={image.name} />
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="card-actions mini-task-actions">
            {!isDone && (
              <button type="button" onClick={(event) => {
                event.stopPropagation()
                onMove(task.id, 'done')
              }}>
                完成
              </button>
            )}
            {task.status !== 'doing' && (
              <button type="button" onClick={(event) => {
                event.stopPropagation()
                onMove(task.id, 'doing')
              }}>
                正在做
              </button>
            )}
            {task.status !== 'todo' && (
              <button type="button" onClick={(event) => {
                event.stopPropagation()
                onMove(task.id, 'todo')
              }}>
                Todo
              </button>
            )}
            <button type="button" onClick={(event) => {
              event.stopPropagation()
              onCopy(task)
            }}>
              复制
            </button>
            {canOpenAgentSession(task) && (
              <button type="button" onClick={(event) => {
                event.stopPropagation()
                onOpenAgentSession(task)
              }}>
                会话
              </button>
            )}
            {(task.reminderAt || task.dueAt) && (
              <button type="button" onClick={(event) => {
                event.stopPropagation()
                onOpenCalendar(task)
              }}>
                日历
              </button>
            )}
            <button type="button" onClick={(event) => {
              event.stopPropagation()
              onEdit(task)
            }}>
              编辑
            </button>
            <button className="danger-button" type="button" onClick={(event) => {
              event.stopPropagation()
              onDelete(task.id)
            }}>
              删除
            </button>
          </div>
        </div>
      )}
    </article>
  )
}

interface TrashDialogProps {
  tasks: Task[]
  onClose: () => void
  onRestore: (taskId: string) => void
  onPurge: (taskId: string) => void
  onEmpty: () => void
}

function TrashDialog({ tasks, onClose, onRestore, onPurge, onEmpty }: TrashDialogProps) {
  const sortedTasks = [...tasks].sort((left, right) => String(right.deletedAt).localeCompare(String(left.deletedAt)))

  return (
    <div className="settings-backdrop" role="presentation" onMouseDown={onClose}>
      <aside
        className="settings-panel trash-panel"
        role="dialog"
        aria-modal="true"
        aria-label="回收箱"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="settings-head">
          <div>
            <h2>回收箱</h2>
            <p>删除过的任务会先放在这里，可以恢复或永久删除。</p>
          </div>
          <button className="icon-button" type="button" title="关闭回收箱" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="trash-actions">
          <span>{tasks.length} 个已删除任务</span>
          <button type="button" disabled={tasks.length === 0} onClick={onEmpty}>
            清空回收箱
          </button>
        </div>

        <div className="trash-list">
          {sortedTasks.length === 0 && <p className="empty-state">回收箱是空的</p>}
          {sortedTasks.map((task) => (
            <article className="trash-item" key={task.id}>
              <div>
                <strong>{task.title}</strong>
                <small>
                  删除 {task.deletedAt ? formatDateTime(task.deletedAt) : '未知'} · {statusConfig[task.status].label}
                </small>
              </div>
              <div className="trash-item-actions">
                <button type="button" onClick={() => onRestore(task.id)}>
                  恢复
                </button>
                <button className="danger-button" type="button" onClick={() => onPurge(task.id)}>
                  永久删除
                </button>
              </div>
            </article>
          ))}
        </div>
      </aside>
    </div>
  )
}

interface ImagePreviewDialogProps {
  preview: ImagePreviewState
  onClose: () => void
  onMove: (direction: number) => void
}

function ImagePreviewDialog({ preview, onClose, onMove }: ImagePreviewDialogProps) {
  const image = preview.images[preview.index]
  const hasMultiple = preview.images.length > 1

  if (!image) return null

  return (
    <div className="image-preview-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="image-preview-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="图片预览"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="image-preview-head">
          <div>
            <h2>{preview.title}</h2>
            <p>
              {image.name}
              {hasMultiple ? ` · ${preview.index + 1}/${preview.images.length}` : ''}
            </p>
          </div>
          <button className="icon-button" type="button" title="关闭预览" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="image-preview-stage">
          {hasMultiple && (
            <button className="image-preview-nav nav-left" type="button" title="上一张" onClick={() => onMove(-1)}>
              ‹
            </button>
          )}
          <img src={image.url} alt={image.name} />
          {hasMultiple && (
            <button className="image-preview-nav nav-right" type="button" title="下一张" onClick={() => onMove(1)}>
              ›
            </button>
          )}
        </div>
      </section>
    </div>
  )
}

function TaskColumn({
  status,
  tasks,
  sortMode,
  sortOpen,
  selectedTaskId,
  multiSelectedTaskIds,
  onAdd,
  onToggleSort,
  onSortChange,
  onSelect,
  onEdit,
  onComplete,
  onToggleDone,
  draggingTaskId,
  onDragStart,
  onDropTask,
  onMove,
  onDelete,
  onPreviewImages,
  onCopy,
  onOpenCalendar,
  onOpenAgentSession,
}: TaskColumnProps) {
  const isDragTarget = Boolean(draggingTaskId)
  const visibleSortMode = normalizeSortModeForStatus(status, sortMode)
  const visibleSortGroups = getSortGroupsForStatus(status)

  function handleDragOver(event: DragEvent<HTMLElement>) {
    if (!draggingTaskId) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault()
    const taskId = event.dataTransfer.getData('text/plain') || draggingTaskId
    if (!taskId) return
    onDropTask(taskId, status)
  }

  return (
    <section
      className={`column column-${status} ${sortOpen ? 'sort-open' : ''} ${isDragTarget ? 'drop-ready' : ''}`}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <header>
        <div>
          <span className="column-mark">{statusConfig[status].shortLabel}</span>
          <h2>
            {statusConfig[status].label}
            <small>{tasks.length}</small>
          </h2>
        </div>
        <div className="column-actions">
          <button
            className={`sort-button ${sortOpen ? 'active' : ''}`}
            type="button"
            title={`排序：${sortModeConfig[visibleSortMode].label}`}
            aria-label={`排序：${sortModeConfig[visibleSortMode].label}`}
            aria-expanded={sortOpen}
            onClick={onToggleSort}
          >
            <span className="sort-icon" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          </button>
          {status !== 'done' && (
            <button type="button" title="新增任务" onClick={onAdd}>
              +
            </button>
          )}
        </div>
      </header>
      {sortOpen && (
        <div className="sort-panel">
          <div className="sort-panel-head">
            <strong>排序方式</strong>
            <span>{sortModeConfig[visibleSortMode].shortLabel}</span>
          </div>
          {visibleSortGroups.map((group) => (
            <div className={`sort-group ${group.modes.length === 1 ? 'single-option' : ''}`} key={group.title}>
              <span>{group.title}</span>
              {group.modes.map((mode) => (
                <button
                  key={mode}
                  className={mode === visibleSortMode ? 'active' : ''}
                  type="button"
                  onClick={() => onSortChange(mode)}
                >
                  {sortModeConfig[mode].menuLabel}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
      <div className="task-list">
        {tasks.length === 0 && <p className="empty-state">这里暂时没有事项</p>}
        {tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            selected={task.id === selectedTaskId}
            multiSelected={multiSelectedTaskIds.includes(task.id)}
            compact={task.id !== selectedTaskId}
            onSelect={onSelect}
            onSelectWithEvent={onSelect}
            onEdit={onEdit}
            onComplete={onComplete}
            onToggleDone={onToggleDone}
            onDragStart={onDragStart}
            onMove={onMove}
            onDelete={onDelete}
            onPreviewImages={onPreviewImages}
            onCopy={onCopy}
            onOpenCalendar={onOpenCalendar}
            onOpenAgentSession={onOpenAgentSession}
          />
        ))}
      </div>
    </section>
  )
}

interface TaskCardProps {
  task: Task
  selected: boolean
  multiSelected: boolean
  compact?: boolean
  onSelect: (taskId: string) => void
  onSelectWithEvent: (taskId: string, event?: { metaKey?: boolean; ctrlKey?: boolean }) => void
  onEdit: (task: Task) => void
  onComplete: (taskId: string) => void
  onToggleDone: (taskId: string) => void
  onDragStart: (taskId: string) => void
  onMove: (taskId: string, status: TaskStatus) => void
  onDelete: (taskId: string) => void
  onPreviewImages: (images: TaskImage[], index: number, title: string) => void
  onCopy: (task: Task) => void
  onOpenCalendar: (task: Task) => void
  onOpenAgentSession: (task: Task) => void
}

function TaskCard({
  task,
  selected,
  multiSelected,
  compact = false,
  onSelect,
  onSelectWithEvent,
  onEdit,
  onComplete,
  onToggleDone,
  onDragStart,
  onMove,
  onDelete,
  onPreviewImages,
  onCopy,
  onOpenCalendar,
  onOpenAgentSession,
}: TaskCardProps) {
  const isDone = task.status === 'done'
  const isOverdue = !isDone && task.dueAt && new Date(task.dueAt).getTime() < Date.now()

  return (
    <article
      className={`task-card ${isAgentCreatedTask(task) ? 'agent-task' : ''} ${selected ? 'selected' : ''} ${multiSelected ? 'multi-selected' : ''} ${compact ? 'compact' : ''}`}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('text/plain', task.id)
        onDragStart(task.id)
      }}
      onDragEnd={() => onDragStart('')}
      onClick={(event: ReactMouseEvent<HTMLElement>) => {
        if (event.metaKey || event.ctrlKey) {
          onSelectWithEvent(task.id, event)
          return
        }
        onSelect(task.id)
      }}
      onDoubleClick={() => onEdit(task)}
    >
      <div className="task-main">
        <button
          className={`check ${isDone ? 'checked' : ''}`}
          type="button"
          aria-label={isDone ? '取消完成' : '完成任务'}
          onClick={(event) => {
            event.stopPropagation()
            onToggleDone(task.id)
          }}
        >
          ✓
        </button>
        <div className="task-copy">
          <strong>{task.title}</strong>
          {!compact && task.detail && <small>{task.detail}</small>}
        </div>
      </div>
      <div className="meta-row">
        <span className={`priority priority-${task.priority}`}>{priorityConfig[task.priority].label}</span>
        <span className="status-pill">{statusConfig[task.status].label}</span>
        <span>{getTaskTimeLabel(task)}</span>
        {task.project && <span>{task.project}</span>}
        {task.dueAt && isOverdue && <span className="danger">已逾期</span>}
        {task.imagePaths.length > 0 && <span>{task.imagePaths.length}图</span>}
      </div>
      {selected && !compact && (
        <div className="task-detail-inline">
          {task.detail && <p>{task.detail}</p>}
          <dl>
            <div>
              <dt>创建</dt>
              <dd>{formatDateTime(task.createdAt)}</dd>
            </div>
            {task.project && (
              <div>
                <dt>项目</dt>
                <dd>{task.project}</dd>
              </div>
            )}
            {task.dueAt && (
              <div>
                <dt>截止</dt>
                <dd>{formatDateTime(task.dueAt)}</dd>
              </div>
            )}
            {task.reminderAt && (
              <div>
                <dt>提醒</dt>
                <dd>{formatDateTime(task.reminderAt)}</dd>
              </div>
            )}
            {task.completedAt && (
              <div>
                <dt>完成</dt>
                <dd>{formatDateTime(task.completedAt)}</dd>
              </div>
            )}
          </dl>
          {task.imagePaths.length > 0 && (
            <div className="preview-grid inline-preview-grid">
              {task.imagePaths.map((image, index) => (
                <button
                  key={image.path}
                  className="preview-thumb"
                  type="button"
                  title="查看大图"
                  onClick={(event) => {
                    event.stopPropagation()
                    onPreviewImages(task.imagePaths, index, task.title)
                  }}
                >
                  <img src={image.url} alt={image.name} />
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {task.tags.length > 0 && !compact && (
        <div className="tag-list">
          {task.tags.map((tag) => (
            <span key={tag}>#{tag}</span>
          ))}
        </div>
      )}
      {!compact && (
        <div className="card-actions">
          {!isDone ? (
            <button type="button" onClick={(event) => {
              event.stopPropagation()
              onComplete(task.id)
            }}>
              完成
            </button>
          ) : (
            <>
              <button type="button" onClick={(event) => {
                event.stopPropagation()
                onMove(task.id, 'todo')
              }}>
                转待办
              </button>
              <button type="button" onClick={(event) => {
                event.stopPropagation()
                onMove(task.id, 'doing')
              }}>
                继续做
              </button>
            </>
          )}
          {!isDone && task.status !== 'doing' && (
            <button type="button" onClick={(event) => {
              event.stopPropagation()
              onMove(task.id, 'doing')
            }}>
              开始
            </button>
          )}
          {!isDone && task.status !== 'todo' && (
            <button type="button" onClick={(event) => {
              event.stopPropagation()
              onMove(task.id, 'todo')
            }}>
              待办
            </button>
          )}
          <button type="button" onClick={(event) => {
            event.stopPropagation()
            onCopy(task)
          }}>
            复制
          </button>
          {canOpenAgentSession(task) && (
            <button type="button" onClick={(event) => {
              event.stopPropagation()
              onOpenAgentSession(task)
            }}>
              会话
            </button>
          )}
          {(task.reminderAt || task.dueAt) && (
            <button type="button" onClick={(event) => {
              event.stopPropagation()
              onOpenCalendar(task)
            }}>
              日历
            </button>
          )}
          <button type="button" onClick={(event) => {
            event.stopPropagation()
            onEdit(task)
          }}>
            编辑
          </button>
          <button type="button" onClick={(event) => {
            event.stopPropagation()
            onDelete(task.id)
          }}>
            删除
          </button>
        </div>
      )}
    </article>
  )
}

export default App
