import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './App.css'
import addTaskIcon from './assets/icons/add-task.png'
import chevronDownIcon from './assets/icons/chevron-down.png'
import chevronUpIcon from './assets/icons/chevron-up.png'
import closeIcon from './assets/icons/close.png'
import collapseOffIcon from './assets/icons/collapse-off.png'
import collapseOnIcon from './assets/icons/collapse-on.png'
import dockLeftIcon from './assets/icons/dock-left.png'
import dockRightIcon from './assets/icons/dock-right.png'
import normalModeIcon from './assets/icons/normal-mode.png'
import pinOffIcon from './assets/icons/pin-off.png'
import searchIcon from './assets/icons/search.png'
import settingsIcon from './assets/icons/settings.png'
import trashIcon from './assets/icons/trash.png'
import type { CSSProperties, ChangeEvent, ClipboardEvent, DragEvent, FormEvent, KeyboardEvent, MouseEvent as ReactMouseEvent, RefObject } from 'react'
import type { AddMode, AppData, AppMode, AppSettings, ShortcutAction, ShortcutSettings, Task, TaskColumnStatus, TaskImage, TaskOrigin, TaskPriority, TaskSortMode, TaskStatus, TopologyPosition } from './types'

const GlobalTopologyView = lazy(() => import('./GlobalTopologyView').then((module) => ({ default: module.GlobalTopologyView })))

const storageKey = 'todo-desk-data'
const compactQuickTextareaBaseHeight = 124
const compactQuickTextareaMaxHeight = 124

const statusConfig: Record<TaskStatus, { label: string; shortLabel: string }> = {
  doing: { label: '正在做', shortLabel: '做' },
  todo: { label: 'Todo', shortLabel: '办' },
  pending_acceptance: { label: '待确认', shortLabel: '审' },
  done: { label: '已完成', shortLabel: '完' },
}

const priorityConfig: Record<TaskPriority, { label: string }> = {
  high: { label: '高' },
  medium: { label: '中' },
  low: { label: '低' },
}

const taskStatuses = ['doing', 'todo', 'done'] as const satisfies readonly TaskColumnStatus[]
const allTaskStatuses = Object.keys(statusConfig) as TaskStatus[]
const completionAcceptanceMessage = '实现已完成，等待用户确认是否标记 done'
const incompleteSessionMessage = '本轮 session 输出完成，但任务尚未完成'
const parentCompletionReviewMessage = '关联 AI 子任务已全部完成，请确认父任务是否也完成。'
type TaskOriginFilter = 'all' | 'ai' | 'human'
type MainView = 'board' | 'calendar' | 'topology'
type AiTestStatus = 'idle' | 'checking' | 'ok' | 'failed'
type CalendarSyncStatus = 'ok' | 'failed' | 'skipped' | 'deleted' | 'pending'
type CalendarTaskState = 'overdue' | 'open' | 'done'
type TaskParentLinkType = NonNullable<Task['parentLink']>['type']

const parentLinkTypeConfig: Record<TaskParentLinkType, { label: string; shortLabel: string }> = {
  subtask_of: { label: '计划子任务', shortLabel: '子任务' },
  discovered_from: { label: '处理中派生', shortLabel: '派生' },
}

const calendarWeekdays = ['一', '二', '三', '四', '五', '六', '日']

const calendarTaskStateConfig: Record<CalendarTaskState, { label: string; rank: number }> = {
  overdue: { label: '已逾期', rank: 0 },
  open: { label: '未完成', rank: 1 },
  done: { label: '已完成', rank: 2 },
}

const originFilterOptions: Array<{ value: TaskOriginFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'ai', label: 'AI' },
  { value: 'human', label: '人工' },
]

const defaultColumnSorts: Record<TaskColumnStatus, TaskSortMode> = {
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

type AppIconName =
  | 'addTask'
  | 'pinOff'
  | 'collapseOff'
  | 'collapseOn'
  | 'normalMode'
  | 'trash'
  | 'settings'
  | 'dockLeft'
  | 'dockRight'
  | 'search'
  | 'close'
  | 'chevronUp'
  | 'chevronDown'

function AppIcon({ name }: { name: AppIconName }) {
  const icons: Record<AppIconName, string> = {
    addTask: addTaskIcon,
    pinOff: pinOffIcon,
    collapseOff: collapseOffIcon,
    collapseOn: collapseOnIcon,
    normalMode: normalModeIcon,
    trash: trashIcon,
    settings: settingsIcon,
    dockLeft: dockLeftIcon,
    dockRight: dockRightIcon,
    search: searchIcon,
    close: closeIcon,
    chevronUp: chevronUpIcon,
    chevronDown: chevronDownIcon,
  }

  const iconClass = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
  return <img className={`app-icon app-icon-${iconClass}`} src={icons[name]} alt="" aria-hidden="true" draggable={false} />
}

function getSortGroupsForStatus(status: TaskColumnStatus) {
  if (status === 'done') return sortModeGroups
  return sortModeGroups.filter((group) => !group.modes.some((mode) => mode.startsWith('completed-')))
}

function normalizeSortModeForStatus(status: TaskColumnStatus, mode: TaskSortMode) {
  if (status !== 'done' && mode.startsWith('completed-')) return defaultColumnSorts[status]
  return mode
}

function getTaskColumnStatus(status: TaskStatus): TaskColumnStatus {
  return status === 'pending_acceptance' ? 'doing' : status
}

function hasActiveCompletionGate(task: Task) {
  return task.status === 'pending_acceptance' && !task.completionAcceptance?.resolvedAt
}

function hasActiveSessionReview(task: Task) {
  return Boolean(task.sessionReview && !task.sessionReview.resolvedAt)
}

function hasActiveParentCompletionReview(task: Task) {
  return Boolean(task.parentCompletionReview && !task.parentCompletionReview.resolvedAt)
}

type TaskDetailVariant = 'card' | 'mini' | 'dock'

function splitLongDetailSegment(segment: string) {
  const trimmed = segment.trim()
  if (!trimmed) return []
  const maxChars = 220
  if (trimmed.length <= maxChars) return [trimmed]

  const sentences = trimmed.match(/[^。！？!?；;]+[。！？!?；;]?/g) ?? [trimmed]
  const chunks: string[] = []
  let current = ''

  for (const sentence of sentences.map((value) => value.trim()).filter(Boolean)) {
    const parts = sentence.match(new RegExp(`.{1,${maxChars}}`, 'g')) ?? [sentence]
    for (const part of parts) {
      if (!current) {
        current = part
        continue
      }
      if (current.length + part.length > maxChars) {
        chunks.push(current)
        current = part
        continue
      }
      current += part
    }
  }

  if (current) chunks.push(current)
  return chunks
}

function splitTaskDetail(detail: string) {
  const normalized = detail
    .trim()
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')

  if (!normalized) return []

  const explicitLines = normalized.split(/\n+/).map((line) => line.trim()).filter(Boolean)

  // 保留 agent/skill 写入时已有的段落边界，再只对过长段落按完整句子切开，避免把“当前 / 验证 / 本地”等词硬拆成碎片。
  return explicitLines.flatMap(splitLongDetailSegment)
}

function TaskDetailText({ detail, variant }: { detail: string; variant: TaskDetailVariant }) {
  const [expanded, setExpanded] = useState(false)
  const blocks = useMemo(() => splitTaskDetail(detail), [detail])
  useEffect(() => {
    setExpanded(false)
  }, [detail, variant])
  if (blocks.length === 0) return null

  const isLong = detail.length > 360 || blocks.length > 2
  const isDockCollapsible = variant === 'dock' && (detail.length > 140 || blocks.length > 1)

  return (
    <section
      className={`task-detail-text detail-${variant} ${isLong ? 'is-long' : ''} ${isDockCollapsible ? 'is-collapsible' : ''} ${isDockCollapsible && !expanded ? 'is-collapsed' : ''}`}
      aria-label="任务详情正文"
    >
      {isDockCollapsible ? (
        <div className="detail-summary-row">
          <span>任务内容</span>
          <button
            className="detail-toggle-button"
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? '收起内容' : '展开内容'}
          </button>
        </div>
      ) : isLong ? (
        <div className="detail-summary-row">
          <span>任务详情</span>
          <span>滚动查看全部</span>
        </div>
      ) : null}
      <div className="detail-block-list">
        {blocks.map((block, index) => (
          <p className="detail-block" key={`${index}-${block.slice(0, 16)}`}>
            {block}
          </p>
        ))}
      </div>
    </section>
  )
}

const codexThreadIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const originKinds = new Set<TaskOrigin['kind']>(['human', 'agent', 'integration', 'system', 'legacy'])
const originChannels = new Set<TaskOrigin['channel']>(['ui', 'local-api', 'todo-desk-skill', 'import', 'automation'])
const originConfidences = new Set<TaskOrigin['confidence']>(['explicit', 'legacy-inferred'])
const legacyAgentSources = new Set(['codex', 'claude', 'cursor', 'kimi', 'forceclaw'])
const uiDerivedSources = new Set(['merge', 'ai-merge'])
const parentCompletionReviewReasons = new Set(['all_agent_children_done', 'agent_child_done'])
const parentCompletionReviewResolutions = new Set(['accepted', 'kept'])

function canOpenAgentSession(task: Task) {
  const agent = `${task.origin?.agent?.name || ''} ${task.origin?.agent?.tool || ''} ${task.agent || ''} ${task.source || ''}`.toLowerCase()
  const sessionId = task.origin?.agent?.sessionId?.trim() || task.agentSessionId?.trim() || ''
  return agent.includes('codex') && codexThreadIdPattern.test(sessionId)
}

function isAgentCreatedTask(task: Task) {
  return task.origin?.kind === 'agent'
}

function getTaskParentLinkLabel(task: Task) {
  if (!task.parentTaskId) return ''
  return parentLinkTypeConfig[task.parentLink?.type === 'discovered_from' ? 'discovered_from' : 'subtask_of'].shortLabel
}

function buildTaskPath(task: Task, taskLookup: Map<string, Task>) {
  const reversedPath: Task[] = [task]
  const visited = new Set([task.id])
  let parentTaskId = task.parentTaskId

  while (parentTaskId && !visited.has(parentTaskId)) {
    const parentTask = taskLookup.get(parentTaskId)
    if (!parentTask) break
    reversedPath.push(parentTask)
    visited.add(parentTask.id)
    parentTaskId = parentTask.parentTaskId
  }

  return reversedPath.reverse()
}

function wouldCreateTaskCycle(taskId: string, parentTaskId: string, tasks: Task[]) {
  if (!parentTaskId) return false
  const taskLookup = new Map(tasks.map((task) => [task.id, task]))
  const visited = new Set<string>()
  let currentTaskId = parentTaskId

  while (currentTaskId && !visited.has(currentTaskId)) {
    if (currentTaskId === taskId) return true
    visited.add(currentTaskId)
    currentTaskId = taskLookup.get(currentTaskId)?.parentTaskId || ''
  }

  return false
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

function normalizeParentCompletionReview(task: Task): Task['parentCompletionReview'] {
  const review = task.parentCompletionReview
  if (!review) return undefined
  const reason = parentCompletionReviewReasons.has(review.reason) ? review.reason : 'all_agent_children_done'
  const resolution = review.resolution && parentCompletionReviewResolutions.has(review.resolution)
    ? review.resolution
    : undefined
  const childTaskIds = Array.isArray(review.childTaskIds)
    ? Array.from(new Set(review.childTaskIds.map((id) => String(id || '').trim()).filter(Boolean)))
    : []
  return {
    requestedAt: String(review.requestedAt || ''),
    requestedBy: String(review.requestedBy || 'agent'),
    message: String(review.message || parentCompletionReviewMessage),
    reason,
    childTaskIds,
    resolvedAt: review.resolvedAt ? String(review.resolvedAt) : undefined,
    resolution,
  }
}

function normalizeParentFields(task: Task): Pick<Task, 'parentTaskId' | 'parentLink' | 'parentCompletionReview'> {
  const parentTaskId = String(task.parentTaskId || '').trim()
  const createdBy: 'human' | 'agent' = task.parentLink?.createdBy === 'human' ? 'human' : 'agent'
  const relationType: TaskParentLinkType = task.parentLink?.type === 'discovered_from' ? 'discovered_from' : 'subtask_of'
  const parentLink: Task['parentLink'] = parentTaskId
    ? {
        type: relationType,
        reason: String(task.parentLink?.reason || '').trim() || undefined,
        // 旧任务默认参与父任务完成复核，保持升级前语义。
        affectsParentCompletion: task.parentLink?.affectsParentCompletion !== false,
        createdBy,
        createdAt: task.parentLink?.createdAt || task.createdAt || new Date().toISOString(),
        confidence: task.parentLink?.confidence === 'inferred' ? 'inferred' as const : 'explicit' as const,
      }
    : undefined
  return {
    parentTaskId: parentTaskId || undefined,
    parentLink,
    parentCompletionReview: normalizeParentCompletionReview(task),
  }
}

function normalizeTaskOrigin(task: Task): Task {
  const parentFields = normalizeParentFields(task)
  if (hasValidOrigin(task)) return { ...task, ...parentFields }

  const source = (task.source || '').trim().toLowerCase()
  if (task.agent?.trim() || task.agentSessionId?.trim() || legacyAgentSources.has(source)) {
    return {
      ...task,
      ...parentFields,
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
      ...parentFields,
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
      ...parentFields,
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
    ...parentFields,
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
  { value: 'quick', label: 'AI' },
  { value: 'detail', label: '普通' },
]

const defaultGlobalShortcuts: ShortcutSettings = {
  toggleDock: 'CommandOrControl+Shift+T',
  dockLeft: 'CommandOrControl+Shift+Left',
  dockRight: 'CommandOrControl+Shift+Right',
  toggleMini: 'CommandOrControl+Shift+M',
  toggleKeepOnTop: 'CommandOrControl+Shift+P',
}

const shortcutActionOptions: Array<{ action: ShortcutAction; label: string; hint: string }> = [
  { action: 'toggleDock', label: '切换贴附 / 恢复', hint: '贴附状态和普通窗口互切' },
  { action: 'dockLeft', label: '贴附到左侧', hint: '直接吸附到屏幕左边缘' },
  { action: 'dockRight', label: '贴附到右侧', hint: '直接吸附到屏幕右边缘' },
  { action: 'toggleMini', label: '小卡模式', hint: '小卡和正常窗口互切' },
  { action: 'toggleKeepOnTop', label: '置顶', hint: '打开或关闭窗口置顶' },
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

type TaskDraft = typeof emptyTaskDraft
type TaskParseSource = 'ai' | 'local-fallback' | 'plain'

interface TaskParseResult {
  drafts: TaskDraft[]
  source: TaskParseSource
  message: string
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

function normalizeGlobalShortcuts(value?: Partial<ShortcutSettings>): ShortcutSettings {
  return {
    ...defaultGlobalShortcuts,
    ...(value || {}),
  }
}

function formatShortcutForDisplay(accelerator: string) {
  if (!accelerator) return '未设置'
  const displayMap: Record<string, string> = {
    CommandOrControl: '⌘',
    Command: '⌘',
    Cmd: '⌘',
    Control: '⌃',
    Ctrl: '⌃',
    Alt: '⌥',
    Option: '⌥',
    Shift: '⇧',
    Left: '←',
    Right: '→',
    Up: '↑',
    Down: '↓',
    Space: 'Space',
    Enter: '↩',
  }
  return accelerator.split('+').map((part) => displayMap[part] || part).join('')
}

function electronKeyFromEventKey(key: string) {
  const keyMap: Record<string, string> = {
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ' ': 'Space',
    Enter: 'Enter',
    Return: 'Enter',
    Tab: 'Tab',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
  }
  if (keyMap[key]) return keyMap[key]
  if (/^F\d{1,2}$/i.test(key)) return key.toUpperCase()
  if (/^[a-z]$/i.test(key)) return key.toUpperCase()
  if (/^\d$/.test(key)) return key
  return ''
}

function shortcutEventToAccelerator(event: KeyboardEvent<HTMLElement>) {
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(event.key)) return ''
  const mainKey = electronKeyFromEventKey(event.key)
  if (!mainKey) return ''

  const modifiers: string[] = []
  if (event.metaKey) modifiers.push('CommandOrControl')
  if (event.ctrlKey && !event.metaKey) modifiers.push('Control')
  if (event.altKey) modifiers.push('Alt')
  if (event.shiftKey) modifiers.push('Shift')
  if (!modifiers.length) return ''

  return [...modifiers, mainKey].join('+')
}

function findShortcutDuplicate(shortcuts: ShortcutSettings, action: ShortcutAction, accelerator: string) {
  const target = accelerator.toLowerCase()
  return shortcutActionOptions.find((option) => (
    option.action !== action && shortcuts[option.action].toLowerCase() === target
  ))
}

function isInteractiveTaskEventTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false

  // 任务卡片本身可点击、可拖拽；内嵌控件必须从卡片级切换/拖拽里排除，
  // 否则父任务选择器会在正常模式中刚打开就被卡片收起。
  return Boolean(target.closest('button, input, textarea, select, a, [role="button"], .task-parent-binder, .parent-picker-popover'))
}

function createDefaultData(): AppData {
  const now = new Date().toISOString()
  return {
    version: 2,
    settings: {
      larkDoc: '',
      larkCalendarId: 'primary',
      calendarSyncEnabled: true,
      larkCalendarSync: true,
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
      globalShortcuts: defaultGlobalShortcuts,
      edgeDocked: false,
      topologyPositions: {},
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
      globalShortcuts: normalizeGlobalShortcuts(value.settings?.globalShortcuts),
      edgeDocked: false,
      topologyPositions: value.settings?.topologyPositions || {},
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
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
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

function formatCalendarMonth(value: Date) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
  }).format(value)
}

function getTaskCalendarAt(task: Task) {
  return task.reminderAt || task.dueAt || ''
}

function getCalendarTaskState(task: Task, now = Date.now()): CalendarTaskState {
  if (task.status === 'done') return 'done'
  if (task.dueAt) {
    const dueTime = new Date(task.dueAt).getTime()
    if (!Number.isNaN(dueTime) && dueTime < now) return 'overdue'
  }
  return 'open'
}

function compareCalendarTasks(left: Task, right: Task, now: number) {
  const leftState = getCalendarTaskState(left, now)
  const rightState = getCalendarTaskState(right, now)
  const stateDifference = calendarTaskStateConfig[leftState].rank - calendarTaskStateConfig[rightState].rank
  if (stateDifference !== 0) return stateDifference

  const timeDifference = String(getTaskCalendarAt(left)).localeCompare(String(getTaskCalendarAt(right)))
  if (timeDifference !== 0) return timeDifference
  return left.title.localeCompare(right.title, 'zh-CN')
}

function addCalendarMonths(value: Date, offset: number) {
  return new Date(value.getFullYear(), value.getMonth() + offset, 1)
}

function toCalendarDateKey(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  // 日历按用户本机看到的日期归档，避免 UTC ISO 字符串把夜间任务挪到前一天或后一天。
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function fromCalendarDateKey(value: string) {
  const [year, month, day] = value.split('-').map(Number)
  if (!year || !month || !day) return new Date()
  return new Date(year, month - 1, day)
}

function getCalendarMonthDays(month: Date) {
  const firstDay = new Date(month.getFullYear(), month.getMonth(), 1)
  const mondayOffset = (firstDay.getDay() + 6) % 7
  const start = new Date(firstDay)
  start.setDate(firstDay.getDate() - mondayOffset)

  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start)
    date.setDate(start.getDate() + index)
    return {
      date,
      key: toCalendarDateKey(date),
      day: date.getDate(),
      inMonth: date.getMonth() === month.getMonth(),
      isToday: toCalendarDateKey(date) === toCalendarDateKey(new Date()),
    }
  })
}

function groupTasksByCalendarDate(tasks: Task[]) {
  const grouped = new Map<string, Task[]>()
  for (const task of tasks) {
    const eventAt = getTaskCalendarAt(task)
    if (!eventAt) continue
    const key = toCalendarDateKey(eventAt)
    if (!key) continue
    const next = grouped.get(key) ?? []
    next.push(task)
    grouped.set(key, next)
  }

  const now = Date.now()
  for (const items of grouped.values()) {
    // 日期格最多显示三条，必须先按状态排序，避免已完成任务挤掉待处理任务。
    items.sort((left, right) => compareCalendarTasks(left, right, now))
  }
  return grouped
}

function getCalendarSyncStatus(task: Task, target: 'local' | 'lark'): CalendarSyncStatus {
  return task.calendarSync?.[target]?.status ?? 'pending'
}

function getCalendarSyncLabel(status: CalendarSyncStatus) {
  switch (status) {
    case 'ok':
      return '已同步'
    case 'failed':
      return '失败'
    case 'skipped':
      return '跳过'
    case 'deleted':
      return '已删除'
    default:
      return '待同步'
  }
}

function getCalendarTaskSyncSummary(localStatus: CalendarSyncStatus, larkStatus: CalendarSyncStatus) {
  const externalStatuses = [localStatus, larkStatus]
  const syncedCount = 1 + externalStatuses.filter((status) => status === 'ok').length
  const detail = `Todo Desk 已保存 · 系统 ${getCalendarSyncLabel(localStatus)} · 飞书 ${getCalendarSyncLabel(larkStatus)}`

  // Todo Desk 自身写入成功后已经完成第一份持久化，因此摘要从 1/3 开始计数；
  // 外部日历只在异常时抢占视觉注意力，正常状态保持为一条低调摘要。
  if (externalStatuses.some((status) => status === 'failed')) {
    return { label: `同步异常 · ${syncedCount}/3`, tone: 'failed', detail }
  }
  if (externalStatuses.some((status) => status === 'pending')) {
    return { label: `等待同步 · ${syncedCount}/3`, tone: 'pending', detail }
  }
  if (syncedCount === 3) {
    return { label: '已同步 3/3', tone: 'ok', detail }
  }
  return { label: `已保存 ${syncedCount}/3`, tone: 'muted', detail }
}

function getTaskTimeLabel(task: Task) {
  if (task.completedAt) return `创建 ${formatDateTime(task.createdAt)} · 完成 ${formatDateTime(task.completedAt)}`
  if (task.dueAt) return `截止 ${formatDateTime(task.dueAt)}`
  if (task.reminderAt) return `提醒 ${formatDateTime(task.reminderAt)}`
  return `创建 ${formatDateTime(task.createdAt)}`
}

function normalizeSearchValue(value: string) {
  return value.normalize('NFKC').trim().toLowerCase()
}

function tokenizeSearchQuery(value: string) {
  return normalizeSearchValue(value)
    .split(/[\s,，、;；|]+/)
    .map((token) => token.replace(/^#+/, '').trim())
    .filter(Boolean)
}

function compactAsciiSearchValue(value: string) {
  return normalizeSearchValue(value).replace(/[^a-z0-9]+/g, '')
}

function getAsciiSearchWords(value: string) {
  return normalizeSearchValue(value).match(/[a-z0-9]+/g) ?? []
}

function isAsciiSearchToken(token: string) {
  return /^[a-z0-9._/-]+$/.test(token)
}

function hasCjkText(token: string) {
  return /[\u3400-\u9fff]/.test(token)
}

function searchTokenMatchesField(token: string, field: string) {
  if (!token || !field) return false
  const normalizedField = normalizeSearchValue(field)
  if (!normalizedField) return false

  // 不再做跨整段文本的散字符匹配。搜索只能命中连续短语、标签词，或 open-api/open api/OpenAPI 这种分隔符差异。
  if (hasCjkText(token) || token.length >= 3) {
    if (normalizedField.includes(token)) return true
  }

  if (!isAsciiSearchToken(token)) return false

  const compactToken = compactAsciiSearchValue(token)
  if (compactToken.length >= 3 && compactAsciiSearchValue(field).includes(compactToken)) return true

  // 1-2 个字符的英文词很容易误伤，只允许匹配完整字段词，例如 AI、UI、cc。
  return compactToken.length > 0 && getAsciiSearchWords(field).some((word) => word === compactToken)
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

function getTaskSearchFields(task: Task) {
  return [
    task.title,
    task.detail,
    task.project,
    task.repository || '',
    task.repositoryPath || '',
    task.parentTaskId || '',
    task.agent || '',
    task.agentSessionId || '',
    task.priority,
    priorityConfig[task.priority].label,
    task.status,
    statusConfig[task.status].label,
    task.tags.join(' '),
    task.imagePaths.map((image) => image.name).join(' '),
    task.createdAt ? formatDateTime(task.createdAt) : '',
    task.dueAt ? formatDateTime(task.dueAt) : '',
    task.reminderAt ? formatDateTime(task.reminderAt) : '',
    task.completedAt ? formatDateTime(task.completedAt) : '',
  ]
}

function taskMatchesSearch(task: Task, searchValue: string) {
  const tokens = tokenizeSearchQuery(searchValue)
  if (tokens.length === 0) return true
  const fields = getTaskSearchFields(task)
  return tokens.every((token) => fields.some((field) => searchTokenMatchesField(token, field)))
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
  if (tasks.some((task) => task.status === 'pending_acceptance')) return 'pending_acceptance'
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

function normalizeChildTaskIds(tasks: Task[]) {
  return Array.from(new Set(tasks.map((task) => task.id).filter(Boolean)))
}

function sameStringSet(left: string[], right: string[]) {
  const leftSet = new Set(left)
  const rightSet = new Set(right)
  if (leftSet.size !== rightSet.size) return false
  for (const item of leftSet) {
    if (!rightSet.has(item)) return false
  }
  return true
}

function shouldSkipResolvedParentReview(task: Task, childTaskIds: string[]) {
  const review = task.parentCompletionReview
  return Boolean(
    review?.resolvedAt
    && review.resolution === 'kept'
    && sameStringSet(review.childTaskIds || [], childTaskIds),
  )
}

function buildParentCompletionReview(parentTask: Task, childTasks: Task[], completedChild: Task, now: string): Task['parentCompletionReview'] {
  const childTaskIds = normalizeChildTaskIds(childTasks)
  const activeReview = hasActiveParentCompletionReview(parentTask) ? parentTask.parentCompletionReview : undefined
  return {
    requestedAt: activeReview?.requestedAt || now,
    requestedBy: activeReview?.requestedBy || completedChild.origin?.agent?.name || completedChild.agent || 'agent',
    message: activeReview?.message || parentCompletionReviewMessage,
    reason: 'all_agent_children_done',
    childTaskIds: Array.from(new Set([...(activeReview?.childTaskIds || []), ...childTaskIds])),
  }
}

function applyParentReviewForCompletedChild(tasks: Task[], childTaskId: string, now: string) {
  const completedChild = tasks.find((task) => task.id === childTaskId)
  if (!completedChild || completedChild.status !== 'done' || !completedChild.parentTaskId) return tasks

  const parentTask = tasks.find((task) => task.id === completedChild.parentTaskId)
  if (!parentTask || parentTask.status === 'done' || isAgentCreatedTask(parentTask)) return tasks

  const linkedAgentChildren = tasks.filter((task) =>
    task.parentTaskId === parentTask.id
    && task.parentLink?.affectsParentCompletion !== false
    && isAgentCreatedTask(task),
  )
  if (linkedAgentChildren.length === 0 || linkedAgentChildren.some((task) => task.status !== 'done')) return tasks

  const childTaskIds = normalizeChildTaskIds(linkedAgentChildren)
  if (shouldSkipResolvedParentReview(parentTask, childTaskIds)) return tasks

  const parentCompletionReview = buildParentCompletionReview(parentTask, linkedAgentChildren, completedChild, now)
  // 子任务完成不代表父任务一定结束，这里只给父任务挂审批提醒，由人类最终确认。
  return tasks.map((task) =>
    task.id === parentTask.id
      ? {
          ...task,
          parentCompletionReview,
          updatedAt: now,
        }
      : task,
  )
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

function toDraftString(value: unknown) {
  return typeof value === 'string' ? value : ''
}

function parseTags(value: string) {
  return toDraftString(value)
    .split(/[,\s，、]+/)
    .map((tag) => tag.trim())
    .filter(Boolean)
}

function buildPlainFallbackMessage(message?: string) {
  const normalized = message?.trim()
  if (!normalized) return 'AI 解析失败，已按普通文本添加'
  if (/普通文本添加|本地时间识别/.test(normalized)) return normalized
  return `${normalized}，已按普通文本添加`
}

function buildDraftFromTask(task: Task) {
  // 很多早期 JSON 任务没有 project/dueAt/reminderAt 等字段；编辑表单必须把它们补成空字符串，否则保存时会在 trim() 处中断。
  return {
    title: toDraftString(task.title),
    detail: toDraftString(task.detail),
    status: allTaskStatuses.includes(task.status) ? task.status : 'todo',
    priority: ['high', 'medium', 'low'].includes(task.priority) ? task.priority : 'medium',
    project: toDraftString(task.project),
    tags: Array.isArray(task.tags) ? task.tags.join(' ') : '',
    dueAt: toLocalInputValue(toDraftString(task.dueAt)),
    reminderAt: toLocalInputValue(toDraftString(task.reminderAt)),
  }
}

function applyParsedTaskToDraft(parsed: Partial<Task>, fallbackText: string, status: TaskStatus) {
  const parsedStatus = allTaskStatuses.includes(parsed.status as TaskStatus) ? (parsed.status as TaskStatus) : status
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

function buildAiEditableTaskFromDraft(draftValue: TaskDraft): Partial<Task> {
  return {
    title: draftValue.title.trim(),
    detail: draftValue.detail.trim(),
    status: draftValue.status,
    priority: draftValue.priority,
    project: draftValue.project.trim(),
    tags: parseTags(draftValue.tags),
    dueAt: fromLocalInputValue(draftValue.dueAt),
    reminderAt: fromLocalInputValue(draftValue.reminderAt),
  }
}

function hasOwnField(value: object, field: string) {
  return Object.prototype.hasOwnProperty.call(value, field)
}

function applyEditedTaskToDraft(current: TaskDraft, edited: Partial<Task>): TaskDraft {
  const status = allTaskStatuses.includes(edited.status as TaskStatus) ? (edited.status as TaskStatus) : current.status
  const priority = ['high', 'medium', 'low'].includes(edited.priority as TaskPriority)
    ? (edited.priority as TaskPriority)
    : current.priority

  return {
    title: typeof edited.title === 'string' ? edited.title : current.title,
    detail: typeof edited.detail === 'string' ? edited.detail : current.detail,
    status,
    priority,
    project: typeof edited.project === 'string' ? edited.project : current.project,
    tags: Array.isArray(edited.tags) ? edited.tags.join(' ') : current.tags,
    dueAt: hasOwnField(edited, 'dueAt') ? toLocalInputValue(edited.dueAt || '') : current.dueAt,
    reminderAt: hasOwnField(edited, 'reminderAt') ? toLocalInputValue(edited.reminderAt || '') : current.reminderAt,
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
  const [draftParentTaskId, setDraftParentTaskId] = useState('')
  const [draftParentLinkType, setDraftParentLinkType] = useState<TaskParentLinkType>('subtask_of')
  const [draftParentLinkReason, setDraftParentLinkReason] = useState('')
  const [draftAffectsParentCompletion, setDraftAffectsParentCompletion] = useState(true)
  const [composerCollapsed, setComposerCollapsed] = useState(false)
  const [aiEditInstruction, setAiEditInstruction] = useState('')
  const [aiEditing, setAiEditing] = useState(false)
  const [attachedImages, setAttachedImages] = useState<TaskImage[]>([])
  const [syncState, setSyncState] = useState('尚未同步')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [recordingShortcutAction, setRecordingShortcutAction] = useState<ShortcutAction | ''>('')
  const [trashOpen, setTrashOpen] = useState(false)
  const [topologyTaskId, setTopologyTaskId] = useState('')
  const [quickText, setQuickText] = useState('')
  const [aiState, setAiState] = useState('')
  const [aiTestResult, setAiTestResult] = useState<{ status: AiTestStatus; message: string }>({
    status: 'idle',
    message: '未测试',
  })
  const [submitState, setSubmitState] = useState('')
  const [mergingMode, setMergingMode] = useState<'' | 'plain' | 'ai'>('')
  const [draggingTaskId, setDraggingTaskId] = useState('')
  const [dockState, setDockState] = useState({ docked: false, edge: '' })
  const [dockDetailOpen, setDockDetailOpenState] = useState(false)
  const dockPassthroughRef = useRef(false)
  // 编辑表单可能开很久；期间 agent/API 会推送新任务，保存时必须合并到最新数据，不能用旧 render 闭包里的任务列表。
  const dataRef = useRef(data)
  const quickTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const [imagePreview, setImagePreview] = useState<ImagePreviewState | null>(null)
  const [multiSelectedTaskIds, setMultiSelectedTaskIds] = useState<string[]>([])
  const [openSortColumn, setOpenSortColumn] = useState<TaskColumnStatus | ''>('')
  const [mainView, setMainView] = useState<MainView>('board')
  const [calendarMonth, setCalendarMonth] = useState(() => new Date())
  const [selectedCalendarDate, setSelectedCalendarDate] = useState(() => toCalendarDateKey(new Date()))

  useEffect(() => {
    dataRef.current = data
  }, [data])

  useEffect(() => {
    if (!settingsOpen && recordingShortcutAction) {
      void stopShortcutRecording()
    }
  }, [recordingShortcutAction, settingsOpen])

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
    return data.tasks.filter((task) => taskMatchesSearch(task, search))
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

  const taskLookup = useMemo(
    () => new Map(data.tasks.map((task) => [task.id, task])),
    [data.tasks],
  )
  const draftParentTask = draftParentTaskId ? taskLookup.get(draftParentTaskId) : undefined
  useEffect(() => {
    if (draftParentTaskId && !taskLookup.has(draftParentTaskId)) {
      setDraftParentTaskId('')
    }
  }, [draftParentTaskId, taskLookup])
  const childTasksByParentId = useMemo(() => {
    const grouped = new Map<string, Task[]>()
    for (const task of data.tasks) {
      if (!task.parentTaskId) continue
      const children = grouped.get(task.parentTaskId) ?? []
      children.push(task)
      grouped.set(task.parentTaskId, children)
    }
    return grouped
  }, [data.tasks])
  const parentTaskCandidates = useMemo(
    () => [...data.tasks]
      .sort((left, right) => String(right.updatedAt || right.createdAt).localeCompare(String(left.updatedAt || left.createdAt))),
    [data.tasks],
  )

  const groupedTasks = useMemo(
    () => ({
      doing: sortTasksForColumn(filteredTasks.filter((task) => getTaskColumnStatus(task.status) === 'doing'), data.settings.columnSorts.doing),
      todo: sortTasksForColumn(filteredTasks.filter((task) => task.status === 'todo'), data.settings.columnSorts.todo),
      done: sortTasksForColumn(filteredTasks.filter((task) => task.status === 'done'), data.settings.columnSorts.done),
    }),
    [data.settings.columnSorts, filteredTasks],
  )
  const calendarTasks = useMemo(
    () => filteredTasks.filter((task) => Boolean(getTaskCalendarAt(task))),
    [filteredTasks],
  )
  const calendarTasksByDate = useMemo(() => groupTasksByCalendarDate(calendarTasks), [calendarTasks])
  const selectedCalendarTasks = calendarTasksByDate.get(selectedCalendarDate) ?? []
  const calendarSyncSummary = useMemo(() => {
    const localOk = calendarTasks.filter((task) => getCalendarSyncStatus(task, 'local') === 'ok').length
    const larkOk = calendarTasks.filter((task) => getCalendarSyncStatus(task, 'lark') === 'ok').length
    const localFailed = calendarTasks.filter((task) => getCalendarSyncStatus(task, 'local') === 'failed').length
    const larkFailed = calendarTasks.filter((task) => getCalendarSyncStatus(task, 'lark') === 'failed').length
    return {
      todoDesk: calendarTasks.length,
      localOk,
      larkOk,
      failed: localFailed + larkFailed,
    }
  }, [calendarTasks])

  const doingCount = data.tasks.filter((task) => getTaskColumnStatus(task.status) === 'doing').length
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

  function selectCalendarDate(dateKey: string) {
    setSelectedCalendarDate(dateKey)
    setCalendarMonth(fromCalendarDateKey(dateKey))
  }

  function startCreateForCalendarDate(dateKey: string) {
    const date = fromCalendarDateKey(dateKey)
    date.setHours(9, 0, 0, 0)
    setMainView('board')
    setEditingTaskId('')
    setDraftParentTaskId('')
    setDraftParentLinkType('subtask_of')
    setDraftParentLinkReason('')
    setDraftAffectsParentCompletion(true)
    setDraft({
      ...emptyTaskDraft,
      status: 'todo',
      reminderAt: toLocalInputValue(date.toISOString()),
    })
    setAttachedImages([])
    setSelectedTaskId('')
    setComposerCollapsed(false)
    if (data.settings.addMode !== 'detail') {
      void updateSettings({ addMode: 'detail' })
    }
  }

  async function syncTaskCalendar(task: Task) {
    if (!task.reminderAt && !task.dueAt) {
      setSyncState('这个任务没有提醒时间或截止时间')
      setAiState('先给任务设置提醒时间或截止时间')
      return
    }

    const now = new Date().toISOString()
    setSyncState(`正在同步日历：${task.title}`)
    const saved = await persist({
      ...data,
      tasks: data.tasks.map((item) =>
        item.id === task.id
          ? {
              ...item,
              updatedAt: now,
              calendarSync: {},
            }
          : item,
      ),
    })
    const syncedTask = saved.tasks.find((item) => item.id === task.id)
    const localStatus = getCalendarSyncLabel(getCalendarSyncStatus(syncedTask || task, 'local'))
    const larkStatus = getCalendarSyncLabel(getCalendarSyncStatus(syncedTask || task, 'lark'))
    setSyncState(`Todo Desk 已记录；系统日历 ${localStatus}；飞书日历 ${larkStatus}`)
  }

  const openDockDetailWindow = useCallback(async () => {
    if (!dockState.docked || dockDetailOpen) return
    await window.todoDesk?.setDockDetailOpen?.(true)
  }, [dockDetailOpen, dockState.docked])

  const setDockPassthrough = useCallback((enabled: boolean) => {
    if (dockPassthroughRef.current === enabled) return
    dockPassthroughRef.current = enabled
    void window.todoDesk?.setDockPassthrough?.(enabled)
  }, [])

  const closeDockDetailWindow = useCallback(() => {
    setDockDetailOpenState(false)
    if (dockState.docked) {
      void window.todoDesk?.setDockDetailOpen?.(false)
    }
  }, [dockState.docked])

  async function openTaskTopology(taskId: string) {
    if (dockState.docked) {
      setDockPassthrough(false)
      const openRequest = window.todoDesk?.setDockTopologyOpen?.(true)
      // Do not block React on the native resize response. Electron applies bounds synchronously,
      // while rendering now prevents a delayed IPC response from swallowing the user's click.
      setTopologyTaskId(taskId)
      const result = await openRequest
      if (result && !result.ok) {
        setTopologyTaskId('')
        setSyncState('无法展开贴附模式的任务拓扑')
      }
      return
    }
    setTopologyTaskId(taskId)
  }

  function closeTaskTopology() {
    setTopologyTaskId('')
    if (!dockState.docked) return
    // Let React remove the fixed overlay before shrinking the native window. Otherwise
    // one rendered frame is clipped into the narrow dock and looks like a flash.
    requestAnimationFrame(() => {
      void window.todoDesk?.setDockTopologyOpen?.(false)
    })
  }

  async function openTaskFromTopology(taskId: string) {
    setTopologyTaskId('')
    if (dockState.docked) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      await window.todoDesk?.setDockTopologyOpen?.(false)
    }
    await openRelatedTask(taskId)
  }

  useEffect(() => {
    if (dockDetailOpen && !selectedDockTaskId) {
      closeDockDetailWindow()
    }
  }, [closeDockDetailWindow, dockDetailOpen, selectedDockTaskId])

  useEffect(() => {
    if (!dockState.docked) {
      setDockPassthrough(false)
    }
  }, [dockState.docked, setDockPassthrough])

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
    const mergedParentTaskIds = mergeUniqueStrings(sourceTasks.map((task) => task.parentTaskId || ''))
    const mergedParentTaskId = mergedParentTaskIds.length === 1 && !sourceIdSet.has(mergedParentTaskIds[0])
      ? mergedParentTaskIds[0]
      : ''
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
      parentTaskId: mergedParentTaskId || undefined,
      parentLink: mergedParentTaskId
        ? {
            type: 'subtask_of',
            affectsParentCompletion: true,
            createdBy: 'human',
            createdAt: now,
            confidence: 'explicit',
          }
        : undefined,
      origin: createHumanTaskOrigin(mode === 'ai' ? 'ui-ai-merge' : 'ui-merge'),
      remindedAt: '',
      source: mode === 'ai' ? 'ai-merge' : 'merge',
      agent: mergeUniqueStrings(sourceTasks.map((task) => task.agent || '')).join(' / '),
      agentSessionId: mergeUniqueStrings(sourceTasks.map((task) => task.agentSessionId || '')).join(' / '),
      repository: mergeUniqueStrings(sourceTasks.map((task) => task.repository || '')).join(' / '),
      repositoryPath: mergeUniqueStrings(sourceTasks.map((task) => task.repositoryPath || '')).join(' / '),
    }
    const deletedAt = now
    let nextTasks = data.tasks.filter((task) => !sourceIdSet.has(task.id))
    nextTasks.splice(Math.max(0, firstSourceIndex), 0, mergedTask)
    if (mergedTask.status === 'done' && mergedTask.parentTaskId) {
      nextTasks = applyParentReviewForCompletedChild(nextTasks, mergedTask.id, now)
    }
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
    const status = allTaskStatuses.includes(draft.status) ? draft.status : 'todo'
    const priority = ['high', 'medium', 'low'].includes(draft.priority) ? draft.priority : 'medium'
    const wasDone = existing?.status === 'done'
    const willBeDone = status === 'done'
    const nextParentTaskId = draftParentTaskId.trim()
    const keepExistingParentLink = Boolean(
      nextParentTaskId
      && existing?.parentTaskId === nextParentTaskId
      && existing.parentLink,
    )
    return {
      id: existing?.id ?? crypto.randomUUID(),
      title: toDraftString(draft.title).trim(),
      detail: toDraftString(draft.detail).trim(),
      status,
      priority,
      project: toDraftString(draft.project).trim(),
      tags: parseTags(draft.tags),
      dueAt: fromLocalInputValue(toDraftString(draft.dueAt)),
      reminderAt: fromLocalInputValue(toDraftString(draft.reminderAt)),
      imagePaths: Array.isArray(attachedImages) ? attachedImages : [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      completedAt: willBeDone ? existing?.completedAt || now : wasDone ? '' : existing?.completedAt || '',
      completionAcceptance: existing?.completionAcceptance,
      sessionReview: existing?.sessionReview,
      parentTaskId: nextParentTaskId || undefined,
      // 只有人类在表单中新建或更换关系时才重建 parentLink。
      // 父任务未变时保留 agent 写入的派生类型、原因和创建时间。
      parentLink: nextParentTaskId
        ? keepExistingParentLink
          ? existing?.parentLink
          : {
              type: draftParentLinkType,
              reason: draftParentLinkReason.trim() || undefined,
              affectsParentCompletion: draftAffectsParentCompletion,
              createdBy: 'human',
              createdAt: now,
              confidence: 'explicit',
            }
        : undefined,
      parentCompletionReview: existing?.parentCompletionReview,
      origin: existing?.origin ?? createHumanTaskOrigin('ui-form'),
      remindedAt: existing?.remindedAt ?? '',
      calendarSync: existing?.calendarSync,
      source: existing?.source,
      agent: existing?.agent,
      agentSessionId: existing?.agentSessionId,
      repository: existing?.repository,
      repositoryPath: existing?.repositoryPath,
    }
  }

  function startCreate(status: TaskStatus) {
    setEditingTaskId('')
    setDraftParentTaskId('')
    setDraftParentLinkType('subtask_of')
    setDraftParentLinkReason('')
    setDraftAffectsParentCompletion(true)
    setDraft({ ...emptyTaskDraft, status })
    setAiEditInstruction('')
    setAttachedImages([])
    setSelectedTaskId('')
    setComposerCollapsed(false)
  }

  function changeDraftParentTask(parentTaskId: string) {
    if (parentTaskId !== draftParentTaskId) {
      setDraftParentLinkType('subtask_of')
      setDraftParentLinkReason('')
      setDraftAffectsParentCompletion(true)
    }
    setDraftParentTaskId(parentTaskId)
  }

  function startCreateBranchTask(parentTask: Task, relationType: TaskParentLinkType) {
    setMainView('board')
    setEditingTaskId('')
    setDraftParentTaskId(parentTask.id)
    setDraftParentLinkType(relationType)
    setDraftParentLinkReason('')
    setDraftAffectsParentCompletion(true)
    setDraft({
      ...emptyTaskDraft,
      status: 'todo',
      project: parentTask.project || '',
    })
    setAiEditInstruction('')
    setAttachedImages([])
    setSelectedTaskId(parentTask.id)
    setMultiSelectedTaskIds([])
    setComposerCollapsed(false)
    setAiState(`正在为「${parentTask.title}」创建${parentLinkTypeConfig[relationType].label}`)
    setSubmitState('')
    if (data.settings.addMode !== 'detail') {
      void updateSettings({ addMode: 'detail' })
    }
  }

  function startEdit(task: Task) {
    setEditingTaskId(task.id)
    setDraftParentTaskId(task.parentTaskId || '')
    setDraftParentLinkType(task.parentLink?.type === 'discovered_from' ? 'discovered_from' : 'subtask_of')
    setDraftParentLinkReason(task.parentLink?.reason || '')
    setDraftAffectsParentCompletion(task.parentLink?.affectsParentCompletion !== false)
    setDraft(buildDraftFromTask(task))
    setAiEditInstruction('')
    setAttachedImages(task.imagePaths ?? [])
    setSelectedTaskId(task.id)
    setComposerCollapsed(false)
  }

  async function saveDraftTask() {
    if (submitState === '正在保存...') return
    if (!toDraftString(draft.title).trim()) {
      setAiState('标题不能为空')
      return
    }

    const currentData = dataRef.current
    const existing = editingTaskId ? currentData.tasks.find((task) => task.id === editingTaskId) : undefined
    if (editingTaskId && !existing) {
      const message = '保存失败：原任务已不存在，请重新选择任务'
      setAiState(message)
      setSyncState(message)
      return
    }
    if (draftParentTaskId && !currentData.tasks.some((task) => task.id === draftParentTaskId)) {
      const message = '保存失败：所选父任务已不存在，请重新选择'
      setAiState(message)
      setSyncState(message)
      return
    }
    if (existing && wouldCreateTaskCycle(existing.id, draftParentTaskId, currentData.tasks)) {
      const message = '保存失败：父任务不能是当前任务或它的后代'
      setAiState(message)
      setSyncState(message)
      return
    }

    setSubmitState('正在保存...')
    setAiState('正在保存任务...')
    try {
      const nextTask = buildTaskFromDraft(existing)
      let nextTasks = existing
        ? currentData.tasks.map((task) => (task.id === existing.id ? nextTask : task))
        : [nextTask, ...currentData.tasks]
      const previousParentTaskId = existing?.parentTaskId || ''
      if (previousParentTaskId && previousParentTaskId !== nextTask.parentTaskId) {
        // 换父任务或解除关系后，旧父任务的子任务完成提醒已经失真，必须一起清理。
        nextTasks = nextTasks.map((task) =>
          task.id === previousParentTaskId && hasActiveParentCompletionReview(task)
            ? {
                ...task,
                parentCompletionReview: undefined,
                updatedAt: nextTask.updatedAt,
              }
            : task,
        )
      }
      if (nextTask.status === 'done' && nextTask.parentTaskId) {
        nextTasks = applyParentReviewForCompletedChild(nextTasks, nextTask.id, nextTask.updatedAt)
      }
      const saved = await persist({ ...currentData, tasks: nextTasks })
      const savedTask = saved.tasks.find((task) => task.id === nextTask.id) ?? nextTask
      const message = existing ? '已保存修改' : '已添加任务'
      setSelectedTaskId(savedTask.id)
      setEditingTaskId(savedTask.id)
      setDraftParentTaskId(savedTask.parentTaskId || '')
      setDraftParentLinkType(savedTask.parentLink?.type === 'discovered_from' ? 'discovered_from' : 'subtask_of')
      setDraftParentLinkReason(savedTask.parentLink?.reason || '')
      setDraftAffectsParentCompletion(savedTask.parentLink?.affectsParentCompletion !== false)
      setDraft(buildDraftFromTask(savedTask))
      setAttachedImages(savedTask.imagePaths ?? [])
      setAiState(message)
      setSyncState(message)
    } catch (error) {
      const message = error instanceof Error ? `保存失败：${error.message}` : '保存失败'
      setAiState(message)
      setSyncState(message)
    } finally {
      setSubmitState('')
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await saveDraftTask()
  }

  async function parseTextToDrafts(
    text: string,
    status: TaskStatus,
    images: TaskImage[] = [],
    options: { forceAi?: boolean } = {},
  ): Promise<TaskParseResult> {
    const trimmed = text.trim()
    const plainDraft = { ...emptyTaskDraft, title: trimmed, status }
    if (!trimmed && images.length === 0) {
      return { drafts: [{ ...emptyTaskDraft, status }], source: 'plain', message: '' }
    }

    // 显式点击“智能添加”或“AI 填充”时，用户已经表达了要用 AI；设置里的开关只控制默认自动解析。
    const shouldUseAi = data.settings.aiEnabled || Boolean(options.forceAi)
    if (!shouldUseAi) {
      const message = 'AI 元数据识别未启用，已按普通文本添加'
      setAiState(message)
      return { drafts: [plainDraft], source: 'plain', message }
    }
    if (!window.todoDesk?.parseTask) {
      const message = 'AI 解析需要桌面 App 运行，已按普通文本添加'
      setAiState(message)
      return { drafts: [plainDraft], source: 'plain', message }
    }

    const parseSettings = options.forceAi ? { ...data.settings, aiEnabled: true } : data.settings
    setAiState(images.length ? '正在用 AI 识别图片、任务和时间...' : '正在用 AI 识别任务、时间和标签...')
    try {
      const result = await window.todoDesk.parseTask({ text: trimmed, settings: parseSettings, images })
      const parsedTasks = result.tasks?.length ? result.tasks : result.task ? [result.task] : []
      if (result.ok && parsedTasks.length) {
        const drafts = parsedTasks.map((task) => applyParsedTaskToDraft(task, trimmed, status))
        if (result.usedLocalFallback) {
          const message = result.message || 'AI 请求失败，已使用本地时间识别'
          setAiState(message)
          return { drafts, source: 'local-fallback', message }
        }
        const imageSource = result.imageMode === 'ocr' ? 'OCR' : images.length ? '图片' : '文本'
        const message =
          parsedTasks.length > 1 ? `AI 已从${imageSource}识别 ${parsedTasks.length} 个任务` : `AI 已从${imageSource}填充元数据`
        setAiState(message)
        return { drafts, source: 'ai', message }
      }
      const message = buildPlainFallbackMessage(result.message)
      setAiState(message)
      return { drafts: [plainDraft], source: 'plain', message }
    } catch (error) {
      const message = buildPlainFallbackMessage(error instanceof Error ? error.message : '')
      setAiState(message)
      return { drafts: [plainDraft], source: 'plain', message }
    }
  }

  async function parseTextToDraft(
    text: string,
    status: TaskStatus,
    images: TaskImage[] = [],
    options: { forceAi?: boolean } = {},
  ) {
    const result = await parseTextToDrafts(text, status, images, options)
    return result.drafts[0] ?? { ...emptyTaskDraft, title: text.trim(), status }
  }

  function getQuickTargetStatus() {
    return (dockState.docked || data.settings.appMode === 'mini') && data.settings.miniColumn !== 'done'
      ? data.settings.miniColumn
      : 'todo'
  }

  async function handleQuickSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmed = quickText.trim()
    // Mini mode does not show an attachment tray, so never apply hidden stale images there.
    const quickImages = data.settings.appMode === 'mini' ? [] : attachedImages
    if (!trimmed && quickImages.length === 0) return
    if (submitState) return
    const targetStatus = getQuickTargetStatus()
    setSubmitState('正在添加...')
    setAiState('正在用 AI 智能添加...')
    try {
      const parseResult = await parseTextToDrafts(trimmed, targetStatus, quickImages, { forceAi: true })
      const createdVia =
        parseResult.source === 'ai'
          ? 'ui-smart-add-ai'
          : parseResult.source === 'local-fallback'
            ? 'ui-smart-add-local-fallback'
            : 'ui-smart-add-plain-fallback'
      const nextTasks = parseResult.drafts.map((parsedDraft) =>
        createTaskFromDraft(parsedDraft, trimmed || '图片中的任务', quickImages, createdVia),
      )
      const saved = await persist({ ...data, tasks: [...nextTasks, ...data.tasks] })
      setData(saved)
      setSelectedTaskId(nextTasks[0]?.id ?? '')
      setQuickText('')
      setAttachedImages([])
      const addMessage = nextTasks.length > 1 ? `已添加 ${nextTasks.length} 个任务` : `已添加：${nextTasks[0]?.title || '任务'}`
      const message = parseResult.message ? `${parseResult.message}，${addMessage}` : addMessage
      setSubmitState(message)
      setAiState(message)
      if (quickTextareaRef.current) {
        quickTextareaRef.current.style.height = `${compactQuickTextareaBaseHeight}px`
      }
      window.setTimeout(() => setSubmitState(''), 1800)
    } catch (error) {
      const message = error instanceof Error ? error.message : '添加任务失败'
      setSubmitState(message)
      setAiState(message)
    }
  }

  async function openDetailAddFromQuick() {
    if (submitState === '正在添加...') return
    const trimmed = quickText.trim()
    const [titleLine = '', ...detailLines] = trimmed.split(/\r?\n/)
    // 普通添加保留为人工填写流程：把紧凑输入迁移到完整表单，避免点击按钮后直接创建不完整任务。
    setEditingTaskId('')
    setDraftParentTaskId('')
    setDraftParentLinkType('subtask_of')
    setDraftParentLinkReason('')
    setDraftAffectsParentCompletion(true)
    setDraft({
      ...emptyTaskDraft,
      title: titleLine.trim(),
      detail: detailLines.join('\n').trim(),
      status: getQuickTargetStatus(),
    })
    setSelectedTaskId('')
    setSubmitState('')
    setAiState('')
    setQuickText('')
    setComposerCollapsed(false)
    if (quickTextareaRef.current) {
      quickTextareaRef.current.style.height = `${compactQuickTextareaBaseHeight}px`
    }
    await updateSettings({ addMode: 'detail' })
  }

  async function fillDraftWithAi() {
    const source = [draft.title, draft.detail].filter(Boolean).join('\n')
    if (!source.trim() && attachedImages.length === 0) {
      setAiState('先输入标题、详情或附加图片')
      return
    }
    const parsedDraft = await parseTextToDraft(source, draft.status, attachedImages, { forceAi: true })
    setDraft(parsedDraft)
  }

  async function editDraftWithAi() {
    if (!editingTaskId) {
      await fillDraftWithAi()
      return
    }
    if (aiEditing) return

    const currentData = dataRef.current
    const originalTask = currentData.tasks.find((task) => task.id === editingTaskId)
    if (!originalTask) {
      const message = 'AI 修改失败：原任务已不存在'
      setAiState(message)
      setSyncState(message)
      return
    }
    const instruction = aiEditInstruction.trim()
    const draftTask = buildAiEditableTaskFromDraft(draft)
    const hasDraftContent = Boolean(draftTask.title || draftTask.detail || draftTask.project || draftTask.tags?.length)
    if (!instruction && !hasDraftContent && attachedImages.length === 0) {
      setAiState('先输入修改要求、任务内容或附加图片')
      return
    }
    if (!window.todoDesk?.editTask) {
      setAiState('AI 修改需要桌面 App 运行')
      setSyncState('AI 修改需要桌面 App 运行')
      return
    }

    setAiEditing(true)
    setAiState(attachedImages.length ? '正在用 AI 根据要求和图片修改任务...' : '正在用 AI 修改任务...')
    try {
      const result = await window.todoDesk.editTask({
        originalTask,
        draftTask,
        instruction,
        settings: { ...data.settings, aiEnabled: true },
        images: attachedImages,
      })
      if (!result.ok || !result.task) {
        const message = result.message || 'AI 修改失败'
        setAiState(message)
        setSyncState(message)
        return
      }

      setDraft((current) => applyEditedTaskToDraft(current, result.task || {}))
      setAiEditInstruction('')
      const imageSource = result.imageMode === 'ocr' ? '，已使用 OCR' : result.imageMode === 'vision' ? '，已读取图片' : ''
      const message = `AI 已修改草稿${imageSource}，确认后点保存`
      setAiState(message)
      setSyncState(message)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'AI 修改失败'
      setAiState(message)
      setSyncState(message)
    } finally {
      setAiEditing(false)
    }
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

  async function linkParentTask(taskId: string, parentTaskId: string, relationType?: TaskParentLinkType) {
    const currentData = dataRef.current
    const taskToLink = currentData.tasks.find((task) => task.id === taskId)
    const parentTask = parentTaskId ? currentData.tasks.find((task) => task.id === parentTaskId) : undefined
    if (!taskToLink || (parentTaskId && !parentTask)) {
      setSyncState('父任务绑定失败：任务不存在')
      return
    }
    if (wouldCreateTaskCycle(taskId, parentTaskId, currentData.tasks)) {
      setSyncState('父任务绑定失败：不能形成循环关系')
      return
    }

    const now = new Date().toISOString()
    const previousParentTaskId = taskToLink.parentTaskId || ''
    const keepExistingRelation = previousParentTaskId === parentTaskId
    const nextRelationType = relationType
      || (keepExistingRelation && taskToLink.parentLink?.type === 'discovered_from' ? 'discovered_from' : 'subtask_of')
    const nextTask: Task = {
      ...taskToLink,
      parentTaskId: parentTaskId || undefined,
      parentLink: parentTaskId
        ? {
            type: nextRelationType,
            reason: keepExistingRelation
              ? taskToLink.parentLink?.reason
              : nextRelationType === 'discovered_from'
                ? '通过全局拓扑建立的派生关系'
                : undefined,
            affectsParentCompletion: keepExistingRelation
              ? taskToLink.parentLink?.affectsParentCompletion !== false
              : true,
            createdBy: 'human',
            createdAt: keepExistingRelation ? taskToLink.parentLink?.createdAt || now : now,
            confidence: 'explicit',
          }
        : undefined,
      updatedAt: now,
    }
    let nextTasks = currentData.tasks.map((task) => (task.id === taskId ? nextTask : task))

    if (previousParentTaskId && previousParentTaskId !== parentTaskId) {
      // 解除或更换父任务时，旧父任务上的提醒已经不再可信，必须清掉让后续子任务完成重新触发。
      nextTasks = nextTasks.map((task) =>
        task.id === previousParentTaskId && hasActiveParentCompletionReview(task)
          ? {
              ...task,
              parentCompletionReview: undefined,
              updatedAt: now,
            }
          : task,
      )
    }
    if (nextTask.status === 'done' && parentTaskId) {
      nextTasks = applyParentReviewForCompletedChild(nextTasks, taskId, now)
    }

    const saved = await persist({ ...currentData, tasks: nextTasks })
    const savedTask = saved.tasks.find((task) => task.id === taskId)
    setSelectedTaskId(taskId)
    setSyncState(
      parentTaskId
        ? `已建立${parentLinkTypeConfig[nextRelationType].shortLabel}关系：${parentTask?.title || savedTask?.parentTaskId}`
        : '已解除父任务绑定',
    )
  }

  async function openRelatedTask(taskId: string) {
    const targetTask = dataRef.current.tasks.find((task) => task.id === taskId)
    if (!targetTask) return

    const targetColumn = getTaskColumnStatus(targetTask.status)
    // 关联任务跳转必须跨过当前搜索和来源筛选，否则从父卡片点 AI 子任务时，
    // 目标卡片可能仍被“人工任务”筛选或旧搜索词隐藏，用户会误以为没有打开。
    setSearch('')
    setOriginFilter('all')
    setMultiSelectedTaskIds([])
    setMainView('board')

    if ((dataRef.current.settings.appMode === 'mini' || dockState.docked) && dataRef.current.settings.miniColumn !== targetColumn) {
      await updateSettings({ miniColumn: targetColumn })
    }
    if (dockState.docked) {
      await openDockDetailWindow()
      setDockDetailOpenState(true)
    }
    setSelectedTaskId(taskId)
  }

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
      const completionAcceptance = currentTask.status === 'pending_acceptance'
        ? {
            requestedAt: currentTask.completionAcceptance?.requestedAt || completedAt,
            requestedBy: currentTask.completionAcceptance?.requestedBy || 'agent',
            message: currentTask.completionAcceptance?.message || completionAcceptanceMessage,
            resolution: 'accepted' as const,
            resolvedAt: completedAt,
          }
        : currentTask.completionAcceptance
      const parentCompletionReview = hasActiveParentCompletionReview(currentTask)
        ? {
            ...currentTask.parentCompletionReview,
            requestedAt: currentTask.parentCompletionReview?.requestedAt || completedAt,
            requestedBy: currentTask.parentCompletionReview?.requestedBy || 'agent',
            message: currentTask.parentCompletionReview?.message || parentCompletionReviewMessage,
            reason: currentTask.parentCompletionReview?.reason || 'all_agent_children_done',
            childTaskIds: currentTask.parentCompletionReview?.childTaskIds || [],
            resolution: 'accepted' as const,
            resolvedAt: completedAt,
          }
        : currentTask.parentCompletionReview
      let nextTasks = data.tasks.map((task) =>
        task.id === taskId
          ? {
              ...task,
              status: 'done' as TaskStatus,
              completedAt,
              completionAcceptance,
              sessionReview: undefined,
              parentCompletionReview,
              updatedAt: completedAt,
            }
          : task,
      )
      nextTasks = applyParentReviewForCompletedChild(nextTasks, taskId, completedAt)
      const nextData = {
        ...data,
        tasks: nextTasks,
      }
      const saved = await persist(nextData)
      setSelectedTaskId(taskId)

      if (saved.settings.syncOnComplete) {
        syncToLark(saved, taskId)
      }
    },
    [data, persist, syncToLark],
  )

  async function continueCompletionRequest(taskId: string) {
    const currentTask = data.tasks.find((task) => task.id === taskId)
    if (!currentTask) return
    const resolvedAt = new Date().toISOString()
    await updateTask(taskId, {
      status: 'doing',
      completedAt: '',
      completionAcceptance: {
        requestedAt: currentTask.completionAcceptance?.requestedAt || resolvedAt,
        requestedBy: currentTask.completionAcceptance?.requestedBy || 'agent',
        message: currentTask.completionAcceptance?.message || completionAcceptanceMessage,
        resolution: 'rework',
        resolvedAt,
      },
    })
    setSelectedTaskId(taskId)
  }

  async function dismissCompletionRequest(taskId: string) {
    const currentTask = data.tasks.find((task) => task.id === taskId)
    if (!currentTask) return
    const resolvedAt = new Date().toISOString()
    await updateTask(taskId, {
      completionAcceptance: {
        requestedAt: currentTask.completionAcceptance?.requestedAt || resolvedAt,
        requestedBy: currentTask.completionAcceptance?.requestedBy || 'agent',
        message: currentTask.completionAcceptance?.message || completionAcceptanceMessage,
        resolution: 'dismissed',
        resolvedAt,
      },
    })
    setSelectedTaskId(taskId)
  }

  async function keepParentTaskOpen(taskId: string) {
    const currentTask = data.tasks.find((task) => task.id === taskId)
    if (!currentTask?.parentCompletionReview) return
    const resolvedAt = new Date().toISOString()
    await updateTask(taskId, {
      parentCompletionReview: {
        ...currentTask.parentCompletionReview,
        requestedAt: currentTask.parentCompletionReview.requestedAt || resolvedAt,
        requestedBy: currentTask.parentCompletionReview.requestedBy || 'agent',
        message: currentTask.parentCompletionReview.message || parentCompletionReviewMessage,
        reason: currentTask.parentCompletionReview.reason || 'all_agent_children_done',
        childTaskIds: currentTask.parentCompletionReview.childTaskIds || [],
        resolution: 'kept',
        resolvedAt,
      },
    })
    setSelectedTaskId(taskId)
  }

  async function resolveSessionReview(taskId: string, resolution: 'reviewed' | 'rework' | 'dismissed') {
    const currentTask = data.tasks.find((task) => task.id === taskId)
    if (!currentTask) return
    const resolvedAt = new Date().toISOString()
    // Session review choices should leave a visible workflow result: rework reopens the task, while "later" moves active work out of Doing.
    const statusPatch: Partial<Task> =
      resolution === 'rework'
        ? { status: 'doing', completedAt: '' }
        : resolution === 'dismissed' && currentTask.status === 'doing'
          ? { status: 'todo', completedAt: '' }
          : {}
    await updateTask(taskId, {
      ...statusPatch,
      sessionReview: {
        requestedAt: currentTask.sessionReview?.requestedAt || resolvedAt,
        requestedBy: currentTask.sessionReview?.requestedBy || 'agent',
        message: currentTask.sessionReview?.message || incompleteSessionMessage,
        resolution,
        resolvedAt,
      },
    })
    setSelectedTaskId(taskId)
  }

  async function toggleDone(taskId: string) {
    const currentTask = data.tasks.find((task) => task.id === taskId)
    if (!currentTask) return
    if (currentTask.status === 'done') {
      await reopenTask(taskId, 'todo')
      return
    }
    await completeTask(taskId)
  }

  async function reopenTask(taskId: string, status: TaskColumnStatus = 'todo') {
    await updateTask(taskId, { status, completedAt: '' })
  }

  async function moveTask(taskId: string, status: TaskColumnStatus) {
    const currentTask = data.tasks.find((task) => task.id === taskId)
    if (!currentTask || currentTask.status === status) {
      setDraggingTaskId('')
      return
    }

    if (status === 'done') {
      setDraggingTaskId('')
      await completeTask(taskId)
      return
    }

    await updateTask(taskId, { status, completedAt: '' })
    setSelectedTaskId(taskId)
    setDraggingTaskId('')
  }

  async function saveTopologyPositions(positions: Record<string, TopologyPosition>) {
    const currentData = dataRef.current
    const taskIds = new Set(currentData.tasks.map((task) => task.id))
    const normalizedPositions = Object.fromEntries(
      Object.entries(positions).filter(([taskId, point]) =>
        taskIds.has(taskId) && Number.isFinite(point.x) && Number.isFinite(point.y),
      ),
    )

    // 节点拖动可能和 Agent API 写任务同时发生，必须基于 dataRef 的最新快照保存，
    // 否则使用渲染闭包里的旧 data 会把刚创建的任务覆盖掉。
    await persist({
      ...currentData,
      settings: {
        ...currentData.settings,
        topologyPositions: normalizedPositions,
      },
    })
  }

  async function linkTopologyTasks(parentTaskId: string, childTaskId: string, relationType: TaskParentLinkType) {
    if (parentTaskId === childTaskId) {
      setSyncState('任务不能连接到自己')
      return
    }
    await linkParentTask(childTaskId, parentTaskId, relationType)
  }

  function openTaskFromGlobalTopology(taskId: string) {
    setMainView('board')
    void openRelatedTask(taskId)
  }

  function addTaskFromGlobalTopology() {
    setMainView('board')
    startCreate('todo')
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
    try {
      await persist({ ...data, tasks: nextTasks, trash: [trashedTask, ...(data.trash ?? [])] })
    } catch (error) {
      setSyncState(error instanceof Error ? error.message : '删除任务失败')
      return
    }
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
    // 任务进回收站时会强同步删除外部日历事件；恢复时必须丢掉旧同步状态，
    // 让 Electron 保存数据时按当前任务时间重新创建系统日历和飞书日历事件。
    const { deletedAt: _deletedAt, calendarSync: _calendarSync, ...restoredTask } = taskToRestore
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
      setDraftParentTaskId('')
      setDraftParentLinkType('subtask_of')
      setDraftParentLinkReason('')
      setDraftAffectsParentCompletion(true)
      setAttachedImages([])
    }
    if (patch.aiBaseUrl !== undefined || patch.aiModel !== undefined || patch.aiApiKey !== undefined) {
      setAiTestResult({ status: 'idle', message: '配置已变更，建议重新测试' })
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

  async function updateShortcut(action: ShortcutAction, accelerator: string) {
    const nextShortcuts = {
      ...normalizeGlobalShortcuts(data.settings.globalShortcuts),
      [action]: accelerator,
    }
    const duplicate = findShortcutDuplicate(nextShortcuts, action, accelerator)
    if (duplicate) {
      setSyncState(`快捷键已被「${duplicate.label}」使用`)
      return
    }
    await updateSettings({ globalShortcuts: nextShortcuts })
    setSyncState('快捷键已更新')
  }

  async function beginShortcutRecording(action: ShortcutAction) {
    setRecordingShortcutAction(action)
    await window.todoDesk?.setShortcutRecording?.(true)
  }

  async function stopShortcutRecording() {
    setRecordingShortcutAction('')
    await window.todoDesk?.setShortcutRecording?.(false)
  }

  async function handleShortcutKeyDown(event: KeyboardEvent<HTMLButtonElement>, action: ShortcutAction) {
    if (recordingShortcutAction !== action) return
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape') {
      await stopShortcutRecording()
      return
    }

    const accelerator = shortcutEventToAccelerator(event)
    if (!accelerator) {
      setSyncState('请按带有 ⌘ / Ctrl / ⌥ / ⇧ 的组合键')
      return
    }
    await updateShortcut(action, accelerator)
    await stopShortcutRecording()
  }

  async function resetShortcut(action: ShortcutAction) {
    await updateShortcut(action, defaultGlobalShortcuts[action])
    await stopShortcutRecording()
  }

  async function resetAllShortcuts() {
    await updateSettings({ globalShortcuts: defaultGlobalShortcuts })
    await stopShortcutRecording()
    setSyncState('快捷键已恢复默认')
  }

  async function testAiConnection() {
    if (!window.todoDesk?.testAiConnection) {
      setAiTestResult({ status: 'failed', message: '测试连接需要桌面 App 运行' })
      return
    }

    setAiTestResult({ status: 'checking', message: '正在测试 AI 连接...' })
    try {
      const result = await window.todoDesk.testAiConnection({ settings: data.settings })
      setAiTestResult({
        status: result.ok ? 'ok' : 'failed',
        message: result.message || (result.ok ? '连接成功' : '连接失败'),
      })
    } catch (error) {
      setAiTestResult({
        status: 'failed',
        message: error instanceof Error ? error.message : 'AI 连通性测试失败',
      })
    }
  }

  async function updateColumnSort(status: TaskColumnStatus, sortMode: TaskSortMode) {
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
        {attachedImages.map((image, index) => (
          <div className="image-chip" key={image.path}>
            <button
              className="image-chip-preview"
              type="button"
              title="预览图片"
              aria-label={`预览图片：${image.name || `附件 ${index + 1}`}`}
              onClick={() => openImagePreview(attachedImages, index, draft.title.trim() || '任务附件')}
            >
              <img src={image.url} alt={image.name || `附件 ${index + 1}`} />
            </button>
            <button
              className="image-chip-remove"
              type="button"
              title="删除图片"
              aria-label={`删除图片：${image.name || `附件 ${index + 1}`}`}
              onClick={() => removeImage(image.path)}
            >
              <span aria-hidden="true">×</span>
            </button>
          </div>
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
    const message = result.ok ? result.message || '已写入系统日历' : result.message || '加入日历失败'
    setSyncState(message)
    setAiState(message)
  }

  async function openAgentSession(task: Task) {
    if (!window.todoDesk?.openAgentSession) {
      setSyncState('跳转 session 需要桌面 App 运行')
      return false
    }
    try {
      const result = await window.todoDesk.openAgentSession(task)
      const message = result.ok ? '已打开关联 Codex session' : result.message || '打开 agent session 失败'
      setSyncState(message)
      setAiState(message)
      return Boolean(result.ok)
    } catch (error) {
      const message = error instanceof Error ? error.message : '打开 agent session 失败'
      setSyncState(message)
      setAiState(message)
      return false
    }
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

  function handleDockPointerMove(event: ReactMouseEvent<HTMLElement>) {
    const target = event.target instanceof Element ? event.target : null
    const isInteractiveDockArea = Boolean(target?.closest('.dock-card, .dock-popover, .task-topology-backdrop'))
    setDockPassthrough(!isInteractiveDockArea)
  }

  function handleDockInteractiveEnter() {
    setDockPassthrough(false)
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
  const composerExpanded = !isQuickComposer || attachedImages.length > 0

  function resizeQuickTextarea(textarea: HTMLTextAreaElement) {
    // Compact mode reserves the lower composer block. Keep the empty input tall
    // enough to occupy that block, then grow upward for pasted notes until the
    // field reaches the designed cap and starts scrolling internally.
    textarea.style.height = `${compactQuickTextareaBaseHeight}px`
    const nextHeight = Math.min(
      Math.max(textarea.scrollHeight, compactQuickTextareaBaseHeight),
      compactQuickTextareaMaxHeight,
    )
    textarea.style.height = `${nextHeight}px`
  }

  function handleQuickTextChange(event: ChangeEvent<HTMLTextAreaElement>) {
    setQuickText(event.target.value)
    resizeQuickTextarea(event.currentTarget)
  }

  if (dockState.docked) {
    return (
      <main
        className={`app-shell dock-shell dock-${dockState.edge || 'right'} ${expandedDockTask ? 'dock-has-popover' : ''}`}
        onMouseMove={handleDockPointerMove}
      >
        <section className="dock-card" onMouseEnter={handleDockInteractiveEnter}>
          <div className="dock-top-actions">
            <button className="dock-restore" type="button" title="恢复窗口" onClick={() => window.todoDesk?.restoreDock()}>
              <AppIcon name="normalMode" />
            </button>
            <button className="dock-collapse" type="button" title="收起详情" disabled={!hasExpandedTask} onClick={closeDockDetailWindow}>
              <AppIcon name={hasExpandedTask ? 'collapseOn' : 'collapseOff'} />
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
                  className={`dock-task-item ${isAgentCreatedTask(task) ? 'agent-task' : ''} ${task.id === selectedTaskId ? 'selected' : ''} ${multiSelectedTaskIds.includes(task.id) ? 'multi-selected' : ''} ${hasActiveCompletionGate(task) || hasActiveSessionReview(task) || hasActiveParentCompletionReview(task) ? 'has-task-notice' : ''} ${hasActiveCompletionGate(task) ? 'has-completion-notice' : ''} ${hasActiveSessionReview(task) ? 'has-session-review-notice' : ''} ${hasActiveParentCompletionReview(task) ? 'has-parent-review-notice' : ''}`}
                >
                  <button
                    className="dock-task-head"
                    type="button"
                    onClick={(event) => selectDockTask(task.id, event)}
                  >
                    <strong>
                      <TaskNoticeDots task={task} />
                      {task.title}
                    </strong>
                    <small>{task.parentTaskId ? `${getTaskParentLinkLabel(task)} · ` : ''}{getTaskTimeLabel(task)}</small>
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
          <aside
            className={`dock-popover ${isAgentCreatedTask(expandedDockTask) ? 'agent-task' : 'human-task'}`}
            aria-label="任务详情"
            onMouseEnter={handleDockInteractiveEnter}
          >
            <header>
              <span className={`priority priority-${expandedDockTask.priority}`}>{priorityConfig[expandedDockTask.priority].label}</span>
              <button type="button" title="收起详情" onClick={closeDockDetailWindow}>
                <AppIcon name="close" />
              </button>
            </header>
            <div className="dock-popover-scroll">
              <strong>{expandedDockTask.title}</strong>
              <CompletionGateNotice
                task={expandedDockTask}
                onConfirm={completeTask}
                onContinue={continueCompletionRequest}
                onDismiss={dismissCompletionRequest}
              />
              <SessionReviewNotice task={expandedDockTask} onResolve={resolveSessionReview} onOpenSession={openAgentSession} />
              <ParentCompletionReviewNotice
                task={expandedDockTask}
                childTasks={childTasksByParentId.get(expandedDockTask.id) ?? []}
                onConfirm={completeTask}
                onKeep={keepParentTaskOpen}
              />
              {expandedDockTask.detail && <TaskDetailText detail={expandedDockTask.detail} variant="dock" />}
              <TaskRelationshipSummary
                task={expandedDockTask}
                taskPath={buildTaskPath(expandedDockTask, taskLookup)}
                childTasks={childTasksByParentId.get(expandedDockTask.id) ?? []}
                onOpenTask={(taskId) => {
                  void openRelatedTask(taskId)
                }}
                onOpenTopology={openTaskTopology}
              />
              <TaskChildList
                task={expandedDockTask}
                childTasks={childTasksByParentId.get(expandedDockTask.id) ?? []}
                onOpenTask={(taskId) => {
                  void openRelatedTask(taskId)
                }}
              />
              <TaskParentBinder
                task={expandedDockTask}
                parentTask={expandedDockTask.parentTaskId ? taskLookup.get(expandedDockTask.parentTaskId) : undefined}
                parentCandidates={parentTaskCandidates}
                onChangeParentTask={linkParentTask}
              />
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
              {expandedDockTask.status !== 'done' && expandedDockTask.status !== 'pending_acceptance' && (
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
        {topologyTaskId && taskLookup.has(topologyTaskId) && (
          <TaskTopologyDialog
            tasks={data.tasks}
            currentTaskId={topologyTaskId}
            onClose={closeTaskTopology}
            onOpenTask={(taskId) => void openTaskFromTopology(taskId)}
          />
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
              className={`ghost-icon-button pin-button ${data.settings.keepOnTop ? 'active' : ''}`}
              type="button"
              title={data.settings.keepOnTop ? '取消置顶' : '窗口置顶'}
              onClick={() => updateSettings({ keepOnTop: !data.settings.keepOnTop })}
            >
              <AppIcon name="pinOff" />
            </button>
            <button
              className="ghost-icon-button collapse-all-button"
              type="button"
              title={hasExpandedTask ? '全部任务收起' : '没有展开的任务'}
              disabled={!hasExpandedTask}
              onClick={() => setSelectedTaskId('')}
            >
              <AppIcon name={hasExpandedTask ? 'collapseOn' : 'collapseOff'} />
            </button>
            <button className="ghost-icon-button" type="button" title="返回正常模式" onClick={() => updateSettings({ appMode: 'normal' })}>
              <AppIcon name="normalMode" />
            </button>
            <button className="ghost-icon-button" type="button" title={`回收箱 ${data.trash.length}`} onClick={() => setTrashOpen(true)}>
              <AppIcon name="trash" />
            </button>
            <button className="icon-button" type="button" title="设置" onClick={() => setSettingsOpen(true)}>
              <AppIcon name="settings" />
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
                taskPath={buildTaskPath(task, taskLookup)}
                parentTask={task.parentTaskId ? taskLookup.get(task.parentTaskId) : undefined}
                childTasks={childTasksByParentId.get(task.id) ?? []}
                parentTaskCandidates={parentTaskCandidates}
                onSelect={selectTask}
                onToggleExpand={(taskId) => setSelectedTaskId((current) => (current === taskId ? '' : taskId))}
                onEdit={startEdit}
                onToggleDone={toggleDone}
                onMove={moveTask}
                onKeepParentTaskOpen={keepParentTaskOpen}
                onChangeParentTask={linkParentTask}
                onOpenRelatedTask={(taskId) => {
                  void openRelatedTask(taskId)
                }}
                onOpenTopology={openTaskTopology}
                onContinueCompletionRequest={continueCompletionRequest}
                onDismissCompletionRequest={dismissCompletionRequest}
                onResolveSessionReview={resolveSessionReview}
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
                  <AppIcon name="close" />
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
        {topologyTaskId && taskLookup.has(topologyTaskId) && (
          <TaskTopologyDialog
            tasks={data.tasks}
            currentTaskId={topologyTaskId}
            onClose={closeTaskTopology}
            onOpenTask={(taskId) => void openTaskFromTopology(taskId)}
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
            <AppIcon name="pinOff" />
          </button>
          <button
            className="ghost-icon-button collapse-all-button"
            type="button"
            title={hasExpandedTask ? '全部任务收起' : '没有展开的任务'}
            disabled={!hasExpandedTask}
            onClick={() => setSelectedTaskId('')}
          >
            <AppIcon name={hasExpandedTask ? 'collapseOn' : 'collapseOff'} />
          </button>
          <button className="ghost-icon-button" type="button" title={`回收箱 ${data.trash.length}`} onClick={() => setTrashOpen(true)}>
            <AppIcon name="trash" />
          </button>
          <button className="ghost-icon-button" type="button" title="贴附到左侧" onClick={() => dockToEdge('left')}>
            <AppIcon name="dockLeft" />
          </button>
          <button className="ghost-icon-button" type="button" title="贴附到右侧" onClick={() => dockToEdge('right')}>
            <AppIcon name="dockRight" />
          </button>
          <span className={`sync-dot ${data.settings.larkDoc ? 'ready' : ''}`} title={syncState} />
          <button className="icon-button" type="button" title="设置" onClick={() => setSettingsOpen(true)}>
            <AppIcon name="settings" />
          </button>
        </div>
      </header>

      <section className="control-strip">
        <label className="search-box" htmlFor="search">
          <AppIcon name="search" />
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

      <section className="view-strip" aria-label="主视图切换">
        <div className="mode-switch" role="tablist" aria-label="Todo Desk 视图">
          <button
            className={mainView === 'board' ? 'active' : ''}
            type="button"
            role="tab"
            aria-selected={mainView === 'board'}
            onClick={() => setMainView('board')}
          >
            看板
          </button>
          <button
            className={mainView === 'calendar' ? 'active' : ''}
            type="button"
            role="tab"
            aria-selected={mainView === 'calendar'}
            onClick={() => setMainView('calendar')}
          >
            日历
          </button>
          <button
            className={mainView === 'topology' ? 'active' : ''}
            type="button"
            role="tab"
            aria-selected={mainView === 'topology'}
            onClick={() => setMainView('topology')}
          >
            拓扑
          </button>
        </div>
        <div className="calendar-mini-status">
          <span>TD {calendarSyncSummary.todoDesk}</span>
          <span>系统 {calendarSyncSummary.localOk}</span>
          <span>飞书 {calendarSyncSummary.larkOk}</span>
        </div>
      </section>

      {multiSelectedTasks.length > 1 && (
        <SelectionMergeBar
          count={multiSelectedTasks.length}
          onPlainMerge={() => mergeSelectedTasks('plain')}
          onAiMerge={() => mergeSelectedTasks('ai')}
          onClear={() => setMultiSelectedTaskIds([])}
          mergingMode={mergingMode}
        />
      )}

      {mainView === 'calendar' ? (
        <TodoCalendarView
          month={calendarMonth}
          selectedDate={selectedCalendarDate}
          tasksByDate={calendarTasksByDate}
          selectedTasks={selectedCalendarTasks}
          syncSummary={calendarSyncSummary}
          onPreviousMonth={() => setCalendarMonth((current) => addCalendarMonths(current, -1))}
          onNextMonth={() => setCalendarMonth((current) => addCalendarMonths(current, 1))}
          onToday={() => {
            const today = new Date()
            setCalendarMonth(today)
            setSelectedCalendarDate(toCalendarDateKey(today))
          }}
          onSelectDate={selectCalendarDate}
          onCreateForDate={startCreateForCalendarDate}
          onSelectTask={(taskId) => {
            setSelectedTaskId(taskId)
            setMultiSelectedTaskIds([])
          }}
          onEditTask={startEdit}
          onSyncTask={syncTaskCalendar}
          onOpenCalendar={openCalendar}
        />
      ) : mainView === 'topology' ? (
        <Suspense fallback={<div className="global-topology-loading">正在加载任务拓扑...</div>}>
          <GlobalTopologyView
            tasks={data.tasks}
            includedTaskIds={filteredTasks.map((task) => task.id)}
            positions={data.settings.topologyPositions}
            onSavePositions={saveTopologyPositions}
            onLinkTasks={linkTopologyTasks}
            onUnlinkTask={(taskId) => linkParentTask(taskId, '')}
            onChangeStatus={moveTask}
            onToggleDone={toggleDone}
            onOpenTask={openTaskFromGlobalTopology}
            onAddTask={addTaskFromGlobalTopology}
          />
        </Suspense>
      ) : (
        <section className="board board-three">
          {taskStatuses.map((status) => (
            <TaskColumn
              key={status}
              status={status}
              tasks={groupedTasks[status]}
              taskLookup={taskLookup}
              childTasksByParentId={childTasksByParentId}
              parentTaskCandidates={parentTaskCandidates}
              sortMode={data.settings.columnSorts[status]}
              sortOpen={openSortColumn === status}
              selectedTaskId={selectedTaskId}
              multiSelectedTaskIds={multiSelectedTaskIds}
              detailPopoverEnabled={!editingTaskId && !draftParentTaskId}
              onAdd={() => startCreate(status === 'done' ? 'todo' : status)}
              onToggleSort={() => setOpenSortColumn((current) => (current === status ? '' : status))}
              onSortChange={(sortMode) => updateColumnSort(status, sortMode)}
              onSelect={(taskId, event) => {
                setOpenSortColumn('')
                selectTask(taskId, event)
              }}
              onEdit={startEdit}
              onComplete={completeTask}
              onToggleDone={toggleDone}
              onKeepParentTaskOpen={keepParentTaskOpen}
              onChangeParentTask={linkParentTask}
              onCreateChildTask={startCreateBranchTask}
              onOpenRelatedTask={(taskId) => {
                void openRelatedTask(taskId)
              }}
              onOpenTopology={openTaskTopology}
              onContinueCompletionRequest={continueCompletionRequest}
              onDismissCompletionRequest={dismissCompletionRequest}
              onResolveSessionReview={resolveSessionReview}
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
      )}

      <section
        className={`composer ${composerExpanded ? 'composer-expanded' : 'composer-compact'} ${composerCollapsed ? 'composer-collapsed' : ''}`}
      >
        <button
          className="composer-collapse-toggle"
          type="button"
          title={composerCollapsed ? '展开添加任务栏' : '收起添加任务栏'}
          aria-label={composerCollapsed ? '展开添加任务栏' : '收起添加任务栏'}
          aria-expanded={!composerCollapsed}
          aria-controls="task-composer-content"
          onClick={() => setComposerCollapsed((current) => !current)}
        >
          <AppIcon name={composerCollapsed ? 'chevronUp' : 'chevronDown'} />
        </button>
        {!composerCollapsed && (
        <div id="task-composer-content" className="composer-content">
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
          <form
            className="quick-form"
            onSubmit={handleQuickSubmit}
            onPaste={handlePasteImages}
            aria-expanded={composerExpanded}
          >
            <textarea
              ref={quickTextareaRef}
              rows={composerExpanded ? 3 : 1}
              value={quickText}
              onChange={handleQuickTextChange}
              onInput={(event) => resizeQuickTextarea(event.currentTarget)}
              placeholder="输入文字，或附加截图后让 AI 从图片里识别任务"
              disabled={submitState === '正在添加...'}
            />
            {renderAttachedImages()}
            <div className="form-actions">
              <div className="quick-toolbar-left">
                <button className="quick-tool-button" type="button" onClick={importImages}>
                  添加附件
                </button>
                <span className="quick-toolbar-divider" aria-hidden="true" />
                <button className="quick-tool-button" type="button" onClick={pasteImagesFromClipboard}>
                  截图识别
                </button>
                {(submitState || composerExpanded) && (
                  <span className="quick-toolbar-status">{submitState || aiState}</span>
                )}
              </div>
              <button type="button" onClick={openDetailAddFromQuick} disabled={submitState === '正在添加...'}>
                普通添加
              </button>
              <button className="primary-button" type="submit" disabled={submitState === '正在添加...'}>
                {submitState === '正在添加...' ? '添加中...' : '智能添加'}
              </button>
            </div>
          </form>
        ) : (
          <form onSubmit={handleSubmit} onPaste={handlePasteImages} noValidate>
          {draftParentTask && !editingTaskId ? (
            <div className="draft-parent-banner">
              <div className="draft-parent-copy">
                <span>上级任务</span>
                <strong title={draftParentTask.title}>{draftParentTask.title}</strong>
              </div>
              <div className="draft-parent-relation" role="group" aria-label="任务关系类型">
                {(Object.entries(parentLinkTypeConfig) as Array<[TaskParentLinkType, { label: string; shortLabel: string }]>).map(([value, config]) => (
                  <button
                    className={draftParentLinkType === value ? 'active' : ''}
                    type="button"
                    key={value}
                    title={config.label}
                    onClick={() => setDraftParentLinkType(value)}
                  >
                    {config.shortLabel}
                  </button>
                ))}
              </div>
              <button
                className="draft-parent-cancel"
                type="button"
                onClick={() => {
                  setDraftParentTaskId('')
                  setDraftParentLinkReason('')
                }}
              >
                取消
              </button>
              <div className="draft-parent-options">
                {draftParentLinkType === 'discovered_from' && (
                  <input
                    value={draftParentLinkReason}
                    onChange={(event) => setDraftParentLinkReason(event.target.value)}
                    placeholder="简要说明这个问题是怎么引出的"
                    maxLength={240}
                  />
                )}
                <label>
                  <input
                    type="checkbox"
                    checked={draftAffectsParentCompletion}
                    onChange={(event) => setDraftAffectsParentCompletion(event.target.checked)}
                  />
                  <span>影响上级任务完成</span>
                </label>
              </div>
            </div>
          ) : (
            <div className="draft-parent-picker">
              <TaskParentBinder
                task={{ id: editingTaskId, parentTaskId: draftParentTaskId || undefined }}
                parentTask={draftParentTask}
                parentCandidates={parentTaskCandidates}
                onChangeParentTask={(_taskId, parentTaskId) => changeDraftParentTask(parentTaskId)}
              />
            </div>
          )}
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
          {editingTaskId ? (
            <div className="detail-form-footer">
              <div className="ai-edit-panel">
                <div className="ai-edit-head">
                  <strong>AI 修改</strong>
                  <span>{aiState || '输入修改要求后生成草稿，确认后再保存'}</span>
                </div>
                <div className="ai-edit-row">
                  <input
                    value={aiEditInstruction}
                    onChange={(event) => setAiEditInstruction(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        editDraftWithAi()
                      }
                    }}
                    placeholder="例如：改成高优先级，明天 10 点提醒，详情整理成步骤"
                  />
                  <button type="button" disabled={aiEditing} onClick={editDraftWithAi}>
                    {aiEditing ? '修改中...' : '生成修改'}
                  </button>
                </div>
              </div>
              <div className="form-actions detail-task-actions">
                <button type="button" onClick={() => startCreate('todo')}>
                  清空
                </button>
                <button
                  className="primary-button"
                  type="button"
                  disabled={submitState === '正在保存...'}
                  onClick={saveDraftTask}
                >
                  {submitState === '正在保存...' ? '保存中...' : '保存'}
                </button>
              </div>
            </div>
          ) : (
            <div className="form-actions">
              <span>{aiState}</span>
              <button type="button" onClick={fillDraftWithAi}>
                AI 填充
              </button>
              <button type="button" onClick={() => startCreate('todo')}>
                清空
              </button>
              <button
                className="primary-button"
                type="button"
                disabled={submitState === '正在保存...'}
                onClick={saveDraftTask}
              >
                {submitState === '正在保存...' ? '保存中...' : '添加任务'}
              </button>
            </div>
          )}
        </form>
        )}
        </div>
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
                <AppIcon name="close" />
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
                  checked={data.settings.calendarSyncEnabled}
                  onChange={(event) => updateSettings({ calendarSyncEnabled: event.target.checked })}
                />
                有时间时自动加入系统日历
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={data.settings.larkCalendarSync}
                  onChange={(event) => updateSettings({ larkCalendarSync: event.target.checked })}
                />
                有时间时自动同步飞书日历
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

            <div className="settings-section shortcut-settings-section">
              <div className="shortcut-section-head">
                <div>
                  <h3>全局快捷键</h3>
                  <p>点击右侧按键框后，按下新的组合键；按 Esc 取消录入。</p>
                </div>
                <button type="button" className="shortcut-reset-all" onClick={resetAllShortcuts}>
                  全部默认
                </button>
              </div>
              <div className="shortcut-list">
                {shortcutActionOptions.map((option) => {
                  const currentShortcut = normalizeGlobalShortcuts(data.settings.globalShortcuts)[option.action]
                  const recording = recordingShortcutAction === option.action
                  return (
                    <div className={`shortcut-row ${recording ? 'recording' : ''}`} key={option.action}>
                      <div className="shortcut-copy">
                        <strong>{option.label}</strong>
                        <span>{option.hint}</span>
                      </div>
                      <button
                        className="shortcut-recorder"
                        type="button"
                        aria-label={`设置${option.label}快捷键`}
                        onClick={() => void beginShortcutRecording(option.action)}
                        onBlur={() => {
                          if (recordingShortcutAction === option.action) void stopShortcutRecording()
                        }}
                        onKeyDown={(event) => void handleShortcutKeyDown(event, option.action)}
                      >
                        {recording ? '按下组合键' : formatShortcutForDisplay(currentShortcut)}
                      </button>
                      <button
                        className="shortcut-reset"
                        type="button"
                        onClick={() => void resetShortcut(option.action)}
                      >
                        默认
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>

            <label className="settings-field">
              <span>飞书日历 calendar_id</span>
              <input
                value={data.settings.larkCalendarId}
                onChange={(event) => updateSettings({ larkCalendarId: event.target.value || 'primary' })}
                placeholder="primary 或共享日历 ID"
              />
            </label>

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
              <div className="settings-test-row">
                <button
                  type="button"
                  disabled={aiTestResult.status === 'checking'}
                  onClick={testAiConnection}
                >
                  {aiTestResult.status === 'checking' ? '测试中...' : '测试连接'}
                </button>
                <span className={`settings-test-result ${aiTestResult.status}`}>
                  {aiTestResult.message}
                </span>
              </div>
            </div>

            <div className="settings-section">
              <h3>小卡模式</h3>
              <p>正常模式展示三列，小卡模式只展示一个列表；拖到左右屏幕边缘会自动变成贴边长条。</p>
              <label className="settings-field">
                <span>小卡展示列表</span>
                <select
                  value={data.settings.miniColumn}
                  onChange={(event) => updateSettings({ miniColumn: event.target.value as TaskColumnStatus })}
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
      {topologyTaskId && taskLookup.has(topologyTaskId) && (
        <TaskTopologyDialog
          tasks={data.tasks}
          currentTaskId={topologyTaskId}
          onClose={closeTaskTopology}
          onOpenTask={(taskId) => void openTaskFromTopology(taskId)}
        />
      )}
    </main>
  )
}

interface TaskColumnProps {
  status: TaskColumnStatus
  tasks: Task[]
  taskLookup: Map<string, Task>
  childTasksByParentId: Map<string, Task[]>
  parentTaskCandidates: Task[]
  sortMode: TaskSortMode
  sortOpen: boolean
  selectedTaskId: string
  multiSelectedTaskIds: string[]
  detailPopoverEnabled: boolean
  onAdd: () => void
  onToggleSort: () => void
  onSortChange: (sortMode: TaskSortMode) => void
  onSelect: (taskId: string, event?: { metaKey?: boolean; ctrlKey?: boolean }) => void
  onEdit: (task: Task) => void
  onComplete: (taskId: string) => void
  onToggleDone: (taskId: string) => void
  onKeepParentTaskOpen: (taskId: string) => void
  onChangeParentTask: (taskId: string, parentTaskId: string) => void
  onCreateChildTask: (task: Task, relationType: TaskParentLinkType) => void
  onOpenRelatedTask: (taskId: string) => void
  onOpenTopology: (taskId: string) => void
  onContinueCompletionRequest: (taskId: string) => void
  onDismissCompletionRequest: (taskId: string) => void
  onResolveSessionReview: (taskId: string, resolution: 'reviewed' | 'rework' | 'dismissed') => void
  draggingTaskId: string
  onDragStart: (taskId: string) => void
  onDropTask: (taskId: string, status: TaskColumnStatus) => void
  onMove: (taskId: string, status: TaskColumnStatus) => void
  onDelete: (taskId: string) => void
  onPreviewImages: (images: TaskImage[], index: number, title: string) => void
  onCopy: (task: Task) => void
  onOpenCalendar: (task: Task) => void
  onOpenAgentSession: (task: Task) => Promise<boolean> | boolean
}

interface TodoCalendarViewProps {
  month: Date
  selectedDate: string
  tasksByDate: Map<string, Task[]>
  selectedTasks: Task[]
  syncSummary: {
    todoDesk: number
    localOk: number
    larkOk: number
    failed: number
  }
  onPreviousMonth: () => void
  onNextMonth: () => void
  onToday: () => void
  onSelectDate: (dateKey: string) => void
  onCreateForDate: (dateKey: string) => void
  onSelectTask: (taskId: string) => void
  onEditTask: (task: Task) => void
  onSyncTask: (task: Task) => void
  onOpenCalendar: (task: Task) => void
}

function TodoCalendarView({
  month,
  selectedDate,
  tasksByDate,
  selectedTasks,
  syncSummary,
  onPreviousMonth,
  onNextMonth,
  onToday,
  onSelectDate,
  onCreateForDate,
  onSelectTask,
  onEditTask,
  onSyncTask,
  onOpenCalendar,
}: TodoCalendarViewProps) {
  const days = getCalendarMonthDays(month)
  const selectedDateLabel = new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).format(fromCalendarDateKey(selectedDate))

  return (
    <section className="calendar-panel" aria-label="Todo Desk 日历">
      <header className="calendar-panel-head">
        <div>
          <h2>{formatCalendarMonth(month)}</h2>
          <p>{syncSummary.todoDesk} 个带时间任务</p>
        </div>
        <div className="calendar-nav" aria-label="日历月份">
          <button type="button" onClick={onPreviousMonth}>‹</button>
          <button type="button" onClick={onToday}>今天</button>
          <button type="button" onClick={onNextMonth}>›</button>
        </div>
      </header>

      <div className={`calendar-sync-overview ${syncSummary.failed > 0 ? 'failed' : 'ok'}`}>
        <span className="calendar-sync-overview-dot" aria-hidden="true" />
        <span>{syncSummary.failed > 0 ? `${syncSummary.failed} 项同步异常` : '三端同步正常'}</span>
        <span className="calendar-sync-overview-detail">
          Todo Desk {syncSummary.todoDesk} · 系统 {syncSummary.localOk} · 飞书 {syncSummary.larkOk}
        </span>
      </div>

      <div className="calendar-layout">
        <div className="calendar-grid" role="grid" aria-label={formatCalendarMonth(month)}>
          {calendarWeekdays.map((weekday) => (
            <div className="calendar-weekday" key={weekday}>{weekday}</div>
          ))}
          {days.map((day) => {
            const dayTasks = tasksByDate.get(day.key) ?? []
            return (
              <div
                key={day.key}
                className={`calendar-day ${day.inMonth ? '' : 'muted'} ${day.isToday ? 'today' : ''} ${selectedDate === day.key ? 'selected' : ''}`}
                role="gridcell"
                onClick={() => onSelectDate(day.key)}
              >
                <button className="calendar-day-number" type="button" onClick={() => onSelectDate(day.key)}>
                  {day.day}
                </button>
                <div className="calendar-day-events">
                  {dayTasks.slice(0, 3).map((task) => {
                    const calendarState = getCalendarTaskState(task)
                    const stateLabel = calendarTaskStateConfig[calendarState].label
                    return (
                      <button
                        key={task.id}
                        className={`calendar-event-chip calendar-state-${calendarState}`}
                        type="button"
                        title={`${stateLabel} · ${task.title}`}
                        aria-label={`${stateLabel}：${task.title}`}
                        onClick={(event) => {
                          event.stopPropagation()
                          onSelectDate(day.key)
                          onSelectTask(task.id)
                        }}
                      >
                        {task.title}
                      </button>
                    )
                  })}
                  {dayTasks.length > 3 && <span className="calendar-more">+{dayTasks.length - 3}</span>}
                </div>
              </div>
            )
          })}
        </div>

        <aside className="calendar-agenda" aria-label={`${selectedDateLabel} 任务`}>
          <header>
            <div>
              <h3>{selectedDateLabel}</h3>
              <p>{selectedTasks.length ? `${selectedTasks.length} 个任务` : '没有带时间的任务'}</p>
            </div>
            <button type="button" onClick={() => onCreateForDate(selectedDate)}>新增</button>
          </header>
          <div className="calendar-agenda-list">
            {selectedTasks.map((task) => {
              const localStatus = getCalendarSyncStatus(task, 'local')
              const larkStatus = getCalendarSyncStatus(task, 'lark')
              const calendarState = getCalendarTaskState(task)
              const stateLabel = calendarTaskStateConfig[calendarState].label
              const taskSyncSummary = getCalendarTaskSyncSummary(localStatus, larkStatus)
              return (
                <article className={`calendar-agenda-card calendar-state-${calendarState} ${isAgentCreatedTask(task) ? 'agent-task' : ''}`} key={task.id}>
                  <button className="calendar-agenda-main" type="button" onClick={() => onSelectTask(task.id)}>
                    <span className="calendar-agenda-headline">
                      <strong>{task.title}</strong>
                      <span className={`calendar-task-state-badge calendar-state-${calendarState}`}>{stateLabel}</span>
                    </span>
                    <span className="calendar-agenda-time">{getTaskTimeLabel(task)}</span>
                  </button>
                  <footer className="calendar-agenda-footer">
                    <span
                      className={`calendar-sync-summary ${taskSyncSummary.tone}`}
                      title={taskSyncSummary.detail}
                    >
                      <span className="calendar-sync-summary-dot" aria-hidden="true" />
                      {taskSyncSummary.label}
                    </span>
                    <div className="calendar-agenda-actions">
                      <button type="button" onClick={() => onSyncTask(task)}>同步</button>
                      <button type="button" onClick={() => onOpenCalendar(task)}>系统</button>
                      <button type="button" onClick={() => onEditTask(task)}>编辑</button>
                    </div>
                  </footer>
                </article>
              )
            })}
          </div>
        </aside>
      </div>
    </section>
  )
}

interface MiniTaskRowProps {
  task: Task
  selected: boolean
  multiSelected: boolean
  taskPath: Task[]
  parentTask?: Task
  childTasks: Task[]
  parentTaskCandidates: Task[]
  onSelect: (taskId: string, event?: { metaKey?: boolean; ctrlKey?: boolean }) => void
  onToggleExpand: (taskId: string) => void
  onEdit: (task: Task) => void
  onToggleDone: (taskId: string) => void
  onMove: (taskId: string, status: TaskColumnStatus) => void
  onKeepParentTaskOpen: (taskId: string) => void
  onChangeParentTask: (taskId: string, parentTaskId: string) => void
  onOpenRelatedTask: (taskId: string) => void
  onOpenTopology: (taskId: string) => void
  onContinueCompletionRequest: (taskId: string) => void
  onDismissCompletionRequest: (taskId: string) => void
  onResolveSessionReview: (taskId: string, resolution: 'reviewed' | 'rework' | 'dismissed') => void
  onDelete: (taskId: string) => void
  onPreviewImages: (images: TaskImage[], index: number, title: string) => void
  onCopy: (task: Task) => void
  onOpenCalendar: (task: Task) => void
  onOpenAgentSession: (task: Task) => Promise<boolean> | boolean
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

interface CompletionGateNoticeProps {
  task: Task
  onConfirm: (taskId: string) => void
  onContinue: (taskId: string) => void
  onDismiss: (taskId: string) => void
}

function CompletionGateNotice({ task, onConfirm, onContinue, onDismiss }: CompletionGateNoticeProps) {
  if (task.status !== 'pending_acceptance') return null

  const active = hasActiveCompletionGate(task)
  const message = task.completionAcceptance?.message || completionAcceptanceMessage

  return (
    <section className={`completion-gate ${active ? 'active' : 'handled'}`} onClick={(event) => event.stopPropagation()}>
      <div className="completion-gate-copy">
        <span className="completion-gate-dot" aria-hidden="true" />
        <div>
          <strong>{active ? '等待确认完成' : '完成提醒已处理'}</strong>
          <p>{active ? message : '可以稍后确认完成，或让 agent 继续修改。'}</p>
        </div>
      </div>
      <div className="completion-gate-actions">
        <button className="primary-button" type="button" onClick={() => onConfirm(task.id)}>
          确认完成
        </button>
        <button type="button" onClick={() => onContinue(task.id)}>
          继续修改
        </button>
        {active && (
          <button type="button" onClick={() => onDismiss(task.id)}>
            暂不处理
          </button>
        )}
      </div>
    </section>
  )
}

interface SessionReviewNoticeProps {
  task: Task
  onResolve: (taskId: string, resolution: 'reviewed' | 'rework' | 'dismissed') => void
  onOpenSession?: (task: Task) => Promise<boolean> | boolean
}

interface ParentCompletionReviewNoticeProps {
  task: Task
  childTasks: Task[]
  onConfirm: (taskId: string) => void
  onKeep: (taskId: string) => void
}

interface TaskParentBinderProps {
  task: Pick<Task, 'id' | 'parentTaskId'>
  parentTask?: Task
  parentCandidates: Task[]
  onChangeParentTask: (taskId: string, parentTaskId: string) => void
}

type ParentPickerStyle = CSSProperties & {
  '--parent-picker-list-max-height'?: string
}

function TaskParentBinder({ task, parentTask, parentCandidates, onChangeParentTask }: TaskParentBinderProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [popoverStyle, setPopoverStyle] = useState<ParentPickerStyle>({})
  const containerRef = useRef<HTMLDivElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const normalizedQuery = query.trim()
  const candidateLookup = useMemo(
    () => new Map(parentCandidates.map((candidate) => [candidate.id, candidate])),
    [parentCandidates],
  )
  // 父任务不能选自己或自己的后代，否则保存后会形成无法遍历的循环关系。
  const validParentCandidates = useMemo(
    () => parentCandidates.filter((candidate) => {
      if (candidate.id === task.id) return false
      return !buildTaskPath(candidate, candidateLookup).some((ancestor) => ancestor.id === task.id)
    }),
    [candidateLookup, parentCandidates, task.id],
  )
  const filteredCandidates = useMemo(() => {
    if (!normalizedQuery) return validParentCandidates
    return validParentCandidates.filter((candidate) => taskMatchesSearch(candidate, normalizedQuery))
  }, [normalizedQuery, validParentCandidates])
  const visibleCandidateLimit = normalizedQuery ? 10 : 7
  const visibleCandidates = filteredCandidates.slice(0, visibleCandidateLimit)

  useEffect(() => {
    if (!open) return undefined

    function updatePopoverMetrics() {
      const target = containerRef.current
      if (!target) return

      const viewportPadding = 10
      const rect = target.getBoundingClientRect()
      const preferredWidth = Math.min(360, Math.max(rect.width + 82, 300))
      const maxWidth = Math.max(180, window.innerWidth - viewportPadding * 2)
      const width = Math.min(preferredWidth, maxWidth)
      const left = Math.min(Math.max(viewportPadding, rect.left), window.innerWidth - width - viewportPadding)
      const below = window.innerHeight - rect.bottom
      const above = rect.top
      const openAbove = below < 238 && above > below
      const available = Math.max(openAbove ? above : below, 188)
      const listHeight = Math.min(232, Math.max(128, available - 88))

      // 使用 fixed 浮层是为了避开小卡/贴附详情里的滚动容器裁切，同时不改变卡片本身高度。
      setPopoverStyle({
        left,
        top: openAbove
          ? Math.max(viewportPadding, rect.top - listHeight - 84)
          : Math.min(rect.bottom + 6, window.innerHeight - viewportPadding),
        width,
        '--parent-picker-list-max-height': `${listHeight}px`,
      })
    }

    updatePopoverMetrics()
    window.addEventListener('resize', updatePopoverMetrics)
    window.addEventListener('scroll', updatePopoverMetrics, true)
    return () => {
      window.removeEventListener('resize', updatePopoverMetrics)
      window.removeEventListener('scroll', updatePopoverMetrics, true)
    }
  }, [filteredCandidates.length, open])

  useEffect(() => {
    if (!open) return undefined

    function handlePointerDown(event: globalThis.MouseEvent) {
      const target = event.target
      if (target instanceof Node && containerRef.current?.contains(target)) return
      if (target instanceof Node && popoverRef.current?.contains(target)) return
      setOpen(false)
    }

    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        setOpen(false)
      }
    }

    window.addEventListener('mousedown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('mousedown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  function selectParent(parentTaskId: string) {
    onChangeParentTask(task.id, parentTaskId)
    setOpen(false)
    setQuery('')
  }

  return (
    <div
      className={`task-parent-binder ${open ? 'open' : ''} ${parentTask ? 'has-parent' : 'is-empty'}`}
      ref={containerRef}
      draggable={false}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onDragStart={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      <span>父任务</span>
      <button
        className="parent-picker-trigger"
        type="button"
        draggable={false}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={parentTask?.title || '未绑定父任务'}
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation()
          setOpen((current) => !current)
        }}
      >
        <span className="parent-picker-copy">
          <strong>{parentTask?.title || '未绑定'}</strong>
          <small>{parentTask ? statusConfig[parentTask.status].label : '选择'}</small>
        </span>
        <AppIcon name="chevronDown" />
      </button>
      {open && createPortal(
        <div
          className="parent-picker-popover"
          ref={popoverRef}
          role="dialog"
          aria-label="选择父任务"
          style={popoverStyle}
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onDragStart={(event) => {
            event.preventDefault()
            event.stopPropagation()
          }}
        >
          <label className="parent-picker-search">
            <AppIcon name="search" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索父任务标题、项目、标签"
            />
          </label>
          <div className="parent-picker-list" role="listbox" aria-label="父任务候选">
            <button
              className={!task.parentTaskId ? 'selected' : ''}
              type="button"
              role="option"
              aria-selected={!task.parentTaskId}
              onClick={() => selectParent('')}
            >
              <span className="parent-option-title">
                <span>不绑定父任务</span>
                {!task.parentTaskId && <small>当前</small>}
              </span>
              <span className="parent-option-meta">任务保持独立</span>
            </button>
            {visibleCandidates.map((candidate) => (
              <button
                key={candidate.id}
                className={task.parentTaskId === candidate.id ? 'selected' : ''}
                type="button"
                role="option"
                aria-selected={task.parentTaskId === candidate.id}
                onClick={() => selectParent(candidate.id)}
              >
                <span className="parent-option-title">
                  <span>{candidate.title}</span>
                  <small>{statusConfig[candidate.status].shortLabel}</small>
                </span>
                <span className="parent-option-meta">
                  {statusConfig[candidate.status].label}
                  {candidate.project ? ` · ${candidate.project}` : ''}
                  {candidate.updatedAt ? ` · ${formatDateTime(candidate.updatedAt)}` : ''}
                </span>
              </button>
            ))}
            {filteredCandidates.length === 0 && <p>没有匹配的任务</p>}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}

function ParentCompletionReviewNotice({ task, childTasks, onConfirm, onKeep }: ParentCompletionReviewNoticeProps) {
  const review = task.parentCompletionReview
  if (!review) return null

  const active = hasActiveParentCompletionReview(task)
  const childCount = review.childTaskIds.length || childTasks.length
  const doneCount = childTasks.filter((child) => child.status === 'done').length || childCount

  return (
    <section className={`parent-review ${active ? 'active' : 'handled'}`} onClick={(event) => event.stopPropagation()}>
      <div className="parent-review-copy">
        <span className="parent-review-dot" aria-hidden="true" />
        <div>
          <strong>{active ? '确认父任务' : '父任务提醒已处理'}</strong>
          <p>{active ? `${review.message} AI 子任务 ${doneCount}/${childCount}` : '父任务保持当前状态。'}</p>
        </div>
      </div>
      {active && (
        <div className="parent-review-actions">
          <button className="primary-button" type="button" onClick={() => onConfirm(task.id)}>
            完成父任务
          </button>
          <button type="button" onClick={() => onKeep(task.id)}>
            继续保留
          </button>
        </div>
      )}
    </section>
  )
}

function TaskNoticeDots({ task }: { task: Task }) {
  const completion = hasActiveCompletionGate(task)
  const sessionReview = hasActiveSessionReview(task)
  const parentReview = hasActiveParentCompletionReview(task)
  if (!completion && !sessionReview && !parentReview) return null

  return (
    <span className="task-notice-dots" aria-label="任务提醒">
      {completion && <span className="completion-notice-dot" title="等待确认完成" />}
      {sessionReview && <span className="session-review-dot" title="本轮未完成" />}
      {parentReview && <span className="parent-review-dot" title="确认父任务是否完成" />}
    </span>
  )
}

function SessionReviewNotice({ task, onResolve, onOpenSession }: SessionReviewNoticeProps) {
  if (!task.sessionReview) return null

  const active = hasActiveSessionReview(task)
  const message = task.sessionReview.message || incompleteSessionMessage
  const canOpenSession = canOpenAgentSession(task)
  const handledCopy = {
    title: '已查看未完成提醒',
    detail: '这次未完成提醒已经处理。',
  }

  async function openSessionAndResolve() {
    if (!onOpenSession || !canOpenSession) return
    const opened = await onOpenSession(task)
    if (opened) {
      onResolve(task.id, 'reviewed')
    }
  }

  return (
    <section className={`session-review ${active ? 'active' : 'handled'}`} onClick={(event) => event.stopPropagation()}>
      <div className="session-review-copy">
        <span className="session-review-dot" aria-hidden="true" />
        <div>
          <strong>{active ? '本轮未完成' : handledCopy.title}</strong>
          <p>{active ? message : handledCopy.detail}</p>
        </div>
      </div>
      {active && (
        <div className="session-review-actions">
          <button className="primary-button" type="button" title="清掉提醒，任务状态不变" onClick={() => onResolve(task.id, 'reviewed')}>
            已查看
          </button>
          <button type="button" title={canOpenSession ? '打开关联 agent 会话，打开成功后清掉提醒' : '当前任务没有可打开的会话'} disabled={!canOpenSession || !onOpenSession} onClick={openSessionAndResolve}>
            查看会话
          </button>
        </div>
      )}
    </section>
  )
}

function TaskRelationshipSummary({
  task,
  taskPath,
  childTasks,
  onOpenTask,
  onOpenTopology,
}: {
  task: Task
  taskPath: Task[]
  childTasks: Task[]
  onOpenTask: (taskId: string) => void
  onOpenTopology: (taskId: string) => void
}) {
  const ancestors = taskPath.slice(0, -1)
  if (ancestors.length === 0 && childTasks.length === 0) return null

  const doneChildren = childTasks.filter((child) => child.status === 'done').length
  const relationType = task.parentLink?.type === 'discovered_from' ? 'discovered_from' : 'subtask_of'

  return (
    <div className="task-relationship-summary">
      {ancestors.length > 0 && (
        <div className="task-branch-path">
          <span className={`task-link-type task-link-type-${relationType}`}>
            {parentLinkTypeConfig[relationType].shortLabel}
          </span>
          <div className="task-branch-trail" aria-label="任务所属主线">
            {ancestors.map((ancestor, index) => (
              <span key={ancestor.id}>
                {index > 0 && <i aria-hidden="true">›</i>}
                <button type="button" title={ancestor.title} onClick={() => onOpenTask(ancestor.id)}>
                  {ancestor.title}
                </button>
              </span>
            ))}
          </div>
        </div>
      )}
      {task.parentLink?.reason && (
        <p className="task-branch-reason" title={task.parentLink.reason}>
          {task.parentLink.reason}
        </p>
      )}
      {task.parentTaskId && task.parentLink?.affectsParentCompletion === false && (
        <span className="task-follow-up-pill">仅后续跟进</span>
      )}
      {childTasks.length > 0 && (
        <span className="task-child-progress">
          分支 {doneChildren}/{childTasks.length}
        </span>
      )}
      <button className="task-topology-button" type="button" onClick={() => onOpenTopology(task.id)}>
        查看拓扑
      </button>
    </div>
  )
}

function TaskChildList({
  task,
  childTasks,
  onOpenTask,
  onCreateChildTask,
}: {
  task: Task
  childTasks: Task[]
  onOpenTask: (taskId: string) => void
  onCreateChildTask?: (task: Task, relationType: TaskParentLinkType) => void
}) {
  const canCreatePlannedChild = Boolean(onCreateChildTask && !isAgentCreatedTask(task))
  const canCreateDerivedChild = Boolean(onCreateChildTask)
  if (childTasks.length === 0 && !canCreatePlannedChild && !canCreateDerivedChild) return null

  const sortedChildren = [...childTasks].sort((left, right) =>
    String(right.updatedAt || right.createdAt).localeCompare(String(left.updatedAt || left.createdAt)),
  )

  return (
    <section className="task-child-list" onClick={(event) => event.stopPropagation()}>
      <header>
        <strong>任务分支</strong>
        <div>
          <span>{childTasks.filter((child) => child.status === 'done').length}/{childTasks.length}</span>
          {canCreatePlannedChild && (
            <button type="button" title="按计划拆分工作" onClick={() => onCreateChildTask?.(task, 'subtask_of')}>
              拆分
            </button>
          )}
          {canCreateDerivedChild && (
            <button type="button" title="记录处理过程中发现的新问题" onClick={() => onCreateChildTask?.(task, 'discovered_from')}>
              派生
            </button>
          )}
        </div>
      </header>
      {sortedChildren.length > 0 ? (
        <div className="task-child-items">
          {sortedChildren.map((child) => (
            <article className={`task-child-item ${isAgentCreatedTask(child) ? 'agent-task' : ''}`} key={child.id}>
              <button type="button" className="task-child-main" title={child.title} onClick={() => onOpenTask(child.id)}>
                <span className="task-child-title">
                  <span className={`task-link-type task-link-type-${child.parentLink?.type === 'discovered_from' ? 'discovered_from' : 'subtask_of'}`}>
                    {getTaskParentLinkLabel(child)}
                  </span>
                  <strong>
                    <TaskNoticeDots task={child} />
                    {child.title}
                  </strong>
                </span>
                <small>
                  {child.parentLink?.reason ? `${child.parentLink.reason} · ` : ''}
                  {statusConfig[child.status].label}
                  {child.project ? ` · ${child.project}` : ''}
                  {child.updatedAt ? ` · ${formatDateTime(child.updatedAt)}` : ''}
                </small>
              </button>
              <span className={`priority priority-${child.priority}`}>{priorityConfig[child.priority].label}</span>
            </article>
          ))}
        </div>
      ) : (
        <p className="task-child-empty">暂无子任务</p>
      )}
    </section>
  )
}

function MiniTaskRow({ task, selected, multiSelected, taskPath, parentTask, childTasks, parentTaskCandidates, onSelect, onToggleExpand, onEdit, onToggleDone, onMove, onKeepParentTaskOpen, onChangeParentTask, onOpenRelatedTask, onOpenTopology, onContinueCompletionRequest, onDismissCompletionRequest, onResolveSessionReview, onDelete, onPreviewImages, onCopy, onOpenCalendar, onOpenAgentSession }: MiniTaskRowProps) {
  const isDone = task.status === 'done'
  const hasCompletionNotice = hasActiveCompletionGate(task)
  const hasSessionReviewNotice = hasActiveSessionReview(task)
  const hasParentReviewNotice = hasActiveParentCompletionReview(task)
  const hasNotice = hasCompletionNotice || hasSessionReviewNotice || hasParentReviewNotice

  return (
    <article
      className={`mini-task-row ${isAgentCreatedTask(task) ? 'agent-task' : ''} ${selected ? 'expanded' : ''} ${multiSelected ? 'multi-selected' : ''} ${hasNotice ? 'has-task-notice' : ''} ${hasCompletionNotice ? 'has-completion-notice' : ''} ${hasSessionReviewNotice ? 'has-session-review-notice' : ''} ${hasParentReviewNotice ? 'has-parent-review-notice' : ''}`}
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
          <strong>
            <TaskNoticeDots task={task} />
            {task.title}
          </strong>
          <small>{task.parentTaskId ? `${getTaskParentLinkLabel(task)} · ` : ''}{getTaskTimeLabel(task)}</small>
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
          <AppIcon name={selected ? 'chevronUp' : 'chevronDown'} />
        </button>
      </div>
      {selected && (
        <div className="mini-task-detail">
          <div className="mini-task-detail-scroll">
            <CompletionGateNotice
              task={task}
              onConfirm={onToggleDone}
              onContinue={onContinueCompletionRequest}
              onDismiss={onDismissCompletionRequest}
            />
            <SessionReviewNotice task={task} onResolve={onResolveSessionReview} onOpenSession={onOpenAgentSession} />
            <ParentCompletionReviewNotice task={task} childTasks={childTasks} onConfirm={onToggleDone} onKeep={onKeepParentTaskOpen} />
            <TaskRelationshipSummary task={task} taskPath={taskPath} childTasks={childTasks} onOpenTask={onOpenRelatedTask} onOpenTopology={onOpenTopology} />
            <TaskChildList task={task} childTasks={childTasks} onOpenTask={onOpenRelatedTask} />
            <TaskParentBinder task={task} parentTask={parentTask} parentCandidates={parentTaskCandidates} onChangeParentTask={onChangeParentTask} />
            {task.detail && <TaskDetailText detail={task.detail} variant="mini" />}
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
            {!isDone && task.status !== 'pending_acceptance' && (
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

interface TaskTopologyDialogProps {
  tasks: Task[]
  currentTaskId: string
  onClose: () => void
  onOpenTask: (taskId: string) => void
}

function collectTaskTopologyStats(rootTaskId: string, childTasksByParentId: Map<string, Task[]>) {
  let taskCount = 0
  let maxDepth = 0
  const visited = new Set<string>()
  const stack = [{ taskId: rootTaskId, depth: 0 }]

  while (stack.length > 0) {
    const current = stack.pop()
    if (!current || visited.has(current.taskId)) continue
    visited.add(current.taskId)
    taskCount += 1
    maxDepth = Math.max(maxDepth, current.depth)
    for (const child of childTasksByParentId.get(current.taskId) ?? []) {
      stack.push({ taskId: child.id, depth: current.depth + 1 })
    }
  }

  return { taskCount, maxDepth }
}

function TaskTopologyNode({
  task,
  currentTaskId,
  childTasksByParentId,
  onOpenTask,
  visited,
  hasParent = false,
}: {
  task: Task
  currentTaskId: string
  childTasksByParentId: Map<string, Task[]>
  onOpenTask: (taskId: string) => void
  visited: Set<string>
  hasParent?: boolean
}) {
  const [detailOpen, setDetailOpen] = useState(false)
  if (visited.has(task.id)) return null
  const nextVisited = new Set(visited)
  nextVisited.add(task.id)
  const childTasks = [...(childTasksByParentId.get(task.id) ?? [])]
    .filter((child) => !nextVisited.has(child.id))
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
  const relationType = task.parentLink?.type === 'discovered_from' ? 'discovered_from' : 'subtask_of'
  const taskOriginClass = isAgentCreatedTask(task) ? 'agent-task' : 'human-task'
  const detailId = `task-topology-detail-${task.id}`

  return (
    <div className={`task-topology-branch ${hasParent ? 'has-parent' : ''}`} role="treeitem" aria-expanded={childTasks.length > 0 || undefined}>
      <article
        className={`task-topology-node ${task.id === currentTaskId ? 'current' : ''} ${taskOriginClass} ${detailOpen ? 'expanded' : ''}`}
        aria-current={task.id === currentTaskId ? 'true' : undefined}
      >
        {/* 拓扑节点单击只展开上下文；跨视图跳转必须由详情里的明确按钮触发，避免误跳。 */}
        <button
          className="task-topology-node-summary"
          type="button"
          title={`${detailOpen ? '收起' : '展开'}任务详情：${task.title}`}
          aria-expanded={detailOpen}
          aria-controls={detailId}
          onClick={() => setDetailOpen((current) => !current)}
        >
          <span className="task-topology-node-title">
            <i className={`task-topology-status status-${getTaskColumnStatus(task.status)}`} aria-hidden="true" />
            <strong>
              <TaskNoticeDots task={task} />
              {task.title}
            </strong>
          </span>
          <span className="task-topology-node-meta">
            {task.parentTaskId && (
              <span className={`task-link-type task-link-type-${relationType}`}>
                {parentLinkTypeConfig[relationType].shortLabel}
              </span>
            )}
            <span>{statusConfig[task.status].label}</span>
            <span>{priorityConfig[task.priority].label}优先级</span>
            {isAgentCreatedTask(task) && <span>AI</span>}
            {task.parentLink?.affectsParentCompletion === false && <span>后续</span>}
            <span className="task-topology-node-expand" aria-hidden="true">
              {detailOpen ? '收起' : '详情'}
              <AppIcon name={detailOpen ? 'chevronUp' : 'chevronDown'} />
            </span>
          </span>
          {!detailOpen && task.parentLink?.reason && <small>{task.parentLink.reason}</small>}
        </button>
        {detailOpen && (
          <section className="task-topology-node-detail" id={detailId} aria-label={`${task.title} 的任务详情`}>
            <div className="task-topology-node-detail-scroll">
              {task.detail ? (
                <p className="task-topology-node-description">{task.detail}</p>
              ) : (
                <p className="task-topology-node-empty">暂无任务详情</p>
              )}
              {task.parentLink?.reason && (
                <div className="task-topology-node-reason">
                  <strong>{relationType === 'discovered_from' ? '派生原因' : '拆分说明'}</strong>
                  <p>{task.parentLink.reason}</p>
                </div>
              )}
              <dl className="task-topology-node-facts">
                {task.project && <div><dt>项目</dt><dd>{task.project}</dd></div>}
                <div><dt>创建</dt><dd>{formatDateTime(task.createdAt)}</dd></div>
                {task.updatedAt && <div><dt>更新</dt><dd>{formatDateTime(task.updatedAt)}</dd></div>}
                {task.dueAt && <div><dt>截止</dt><dd>{formatDateTime(task.dueAt)}</dd></div>}
                {task.reminderAt && <div><dt>提醒</dt><dd>{formatDateTime(task.reminderAt)}</dd></div>}
                {task.completedAt && <div><dt>完成</dt><dd>{formatDateTime(task.completedAt)}</dd></div>}
                {task.imagePaths.length > 0 && <div><dt>附件</dt><dd>{task.imagePaths.length} 张图片</dd></div>}
              </dl>
              {task.tags.length > 0 && (
                <div className="task-topology-node-tags">
                  {task.tags.map((tag) => <span key={tag}>#{tag}</span>)}
                </div>
              )}
            </div>
            <footer className="task-topology-node-actions">
              <button type="button" onClick={() => onOpenTask(task.id)}>打开任务卡片</button>
            </footer>
          </section>
        )}
      </article>
      {childTasks.length > 0 && (
        <div className="task-topology-children" role="group">
          {childTasks.map((child) => (
            <TaskTopologyNode
              key={child.id}
              task={child}
              currentTaskId={currentTaskId}
              childTasksByParentId={childTasksByParentId}
              onOpenTask={onOpenTask}
              visited={nextVisited}
              hasParent
            />
          ))}
        </div>
      )}
    </div>
  )
}

function TaskTopologyDialog({ tasks, currentTaskId, onClose, onOpenTask }: TaskTopologyDialogProps) {
  const taskLookup = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks])
  const childTasksByParentId = useMemo(() => {
    const grouped = new Map<string, Task[]>()
    for (const task of tasks) {
      if (!task.parentTaskId) continue
      const children = grouped.get(task.parentTaskId) ?? []
      children.push(task)
      grouped.set(task.parentTaskId, children)
    }
    return grouped
  }, [tasks])
  const currentTask = taskLookup.get(currentTaskId)
  const rootTask = currentTask ? buildTaskPath(currentTask, taskLookup)[0] : undefined
  const stats = useMemo(
    () => rootTask ? collectTaskTopologyStats(rootTask.id, childTasksByParentId) : { taskCount: 0, maxDepth: 0 },
    [childTasksByParentId, rootTask],
  )

  useEffect(() => {
    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  if (!currentTask || !rootTask) return null

  return (
    <div className="task-topology-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="task-topology-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-topology-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="task-topology-head">
          <div>
            <h2 id="task-topology-title">任务拓扑</h2>
            <p title={rootTask.title}>
              {rootTask.title} · {stats.taskCount} 个任务 · {stats.maxDepth + 1} 层
            </p>
          </div>
          <button className="icon-button" type="button" title="关闭任务拓扑" onClick={onClose}>
            <AppIcon name="close" />
          </button>
        </header>
        <div className="task-topology-legend" aria-label="拓扑图例">
          <span className="task-topology-origin human-task"><i />人工任务</span>
          <span className="task-topology-origin agent-task"><i />AI 任务</span>
          <span><i className="status-doing" />正在做</span>
          <span><i className="status-todo" />Todo</span>
          <span><i className="status-done" />已完成</span>
          <span className="task-link-type task-link-type-subtask_of">子任务</span>
          <span className="task-link-type task-link-type-discovered_from">派生</span>
        </div>
        <div className="task-topology-stage">
          <div className="task-topology-tree" role="tree" aria-label={`${rootTask.title} 的任务拓扑`}>
            <TaskTopologyNode
              task={rootTask}
              currentTaskId={currentTaskId}
              childTasksByParentId={childTasksByParentId}
              onOpenTask={onOpenTask}
              visited={new Set()}
            />
          </div>
        </div>
      </section>
    </div>
  )
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
            <AppIcon name="close" />
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
            <AppIcon name="close" />
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
  taskLookup,
  childTasksByParentId,
  parentTaskCandidates,
  sortMode,
  sortOpen,
  selectedTaskId,
  multiSelectedTaskIds,
  detailPopoverEnabled,
  onAdd,
  onToggleSort,
  onSortChange,
  onSelect,
  onEdit,
  onComplete,
  onToggleDone,
  onKeepParentTaskOpen,
  onChangeParentTask,
  onCreateChildTask,
  onOpenRelatedTask,
  onOpenTopology,
  onContinueCompletionRequest,
  onDismissCompletionRequest,
  onResolveSessionReview,
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
            detailOpen={detailPopoverEnabled && task.id === selectedTaskId && multiSelectedTaskIds.length === 0}
            multiSelected={multiSelectedTaskIds.includes(task.id)}
            taskPath={buildTaskPath(task, taskLookup)}
            parentTask={task.parentTaskId ? taskLookup.get(task.parentTaskId) : undefined}
            childTasks={childTasksByParentId.get(task.id) ?? []}
            parentTaskCandidates={parentTaskCandidates}
            compact
            onSelect={onSelect}
            onSelectWithEvent={onSelect}
            onEdit={onEdit}
            onComplete={onComplete}
            onToggleDone={onToggleDone}
            onKeepParentTaskOpen={onKeepParentTaskOpen}
            onChangeParentTask={onChangeParentTask}
            onCreateChildTask={onCreateChildTask}
            onOpenRelatedTask={onOpenRelatedTask}
            onOpenTopology={onOpenTopology}
            onContinueCompletionRequest={onContinueCompletionRequest}
            onDismissCompletionRequest={onDismissCompletionRequest}
            onResolveSessionReview={onResolveSessionReview}
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
  detailOpen: boolean
  multiSelected: boolean
  taskPath: Task[]
  parentTask?: Task
  childTasks: Task[]
  parentTaskCandidates: Task[]
  compact?: boolean
  onSelect: (taskId: string) => void
  onSelectWithEvent: (taskId: string, event?: { metaKey?: boolean; ctrlKey?: boolean }) => void
  onEdit: (task: Task) => void
  onComplete: (taskId: string) => void
  onToggleDone: (taskId: string) => void
  onKeepParentTaskOpen: (taskId: string) => void
  onChangeParentTask: (taskId: string, parentTaskId: string) => void
  onCreateChildTask: (task: Task, relationType: TaskParentLinkType) => void
  onOpenRelatedTask: (taskId: string) => void
  onOpenTopology: (taskId: string) => void
  onContinueCompletionRequest: (taskId: string) => void
  onDismissCompletionRequest: (taskId: string) => void
  onResolveSessionReview: (taskId: string, resolution: 'reviewed' | 'rework' | 'dismissed') => void
  onDragStart: (taskId: string) => void
  onMove: (taskId: string, status: TaskColumnStatus) => void
  onDelete: (taskId: string) => void
  onPreviewImages: (images: TaskImage[], index: number, title: string) => void
  onCopy: (task: Task) => void
  onOpenCalendar: (task: Task) => void
  onOpenAgentSession: (task: Task) => Promise<boolean> | boolean
}

type NormalTaskDetailStyle = CSSProperties & {
  '--normal-detail-anchor-y'?: string
}

interface NormalTaskDetailPopoverProps {
  task: Task
  anchorRef: RefObject<HTMLElement | null>
  taskPath: Task[]
  parentTask?: Task
  childTasks: Task[]
  parentTaskCandidates: Task[]
  onClose: () => void
  onEdit: (task: Task) => void
  onComplete: (taskId: string) => void
  onKeepParentTaskOpen: (taskId: string) => void
  onChangeParentTask: (taskId: string, parentTaskId: string) => void
  onCreateChildTask: (task: Task, relationType: TaskParentLinkType) => void
  onOpenRelatedTask: (taskId: string) => void
  onOpenTopology: (taskId: string) => void
  onContinueCompletionRequest: (taskId: string) => void
  onDismissCompletionRequest: (taskId: string) => void
  onResolveSessionReview: (taskId: string, resolution: 'reviewed' | 'rework' | 'dismissed') => void
  onMove: (taskId: string, status: TaskColumnStatus) => void
  onDelete: (taskId: string) => void
  onPreviewImages: (images: TaskImage[], index: number, title: string) => void
  onCopy: (task: Task) => void
  onOpenCalendar: (task: Task) => void
  onOpenAgentSession: (task: Task) => Promise<boolean> | boolean
}

function NormalTaskDetailPopover({
  task,
  anchorRef,
  taskPath,
  parentTask,
  childTasks,
  parentTaskCandidates,
  onClose,
  onEdit,
  onComplete,
  onKeepParentTaskOpen,
  onChangeParentTask,
  onCreateChildTask,
  onOpenRelatedTask,
  onOpenTopology,
  onContinueCompletionRequest,
  onDismissCompletionRequest,
  onResolveSessionReview,
  onMove,
  onDelete,
  onPreviewImages,
  onCopy,
  onOpenCalendar,
  onOpenAgentSession,
}: NormalTaskDetailPopoverProps) {
  const [placement, setPlacement] = useState<{ side: 'left' | 'right' | 'center'; style: NormalTaskDetailStyle }>({
    side: 'center',
    style: { left: -9999, top: 12, width: 420, height: 560 },
  })
  const isDone = task.status === 'done'

  useEffect(() => {
    function updatePlacement() {
      const anchor = anchorRef.current
      if (!anchor) return

      const viewportPadding = 12
      const gap = 10
      const rect = anchor.getBoundingClientRect()
      const availableWidth = Math.max(1, window.innerWidth - viewportPadding * 2)
      const availableHeight = Math.max(1, window.innerHeight - viewportPadding * 2)
      const panelWidth = Math.min(460, availableWidth)
      const panelHeight = Math.min(640, availableHeight)
      const anchorCenter = rect.left + rect.width / 2
      const openRight = anchorCenter <= window.innerWidth / 2
      const preferredLeft = openRight ? rect.right + gap : rect.left - panelWidth - gap
      const left = Math.min(
        Math.max(viewportPadding, preferredLeft),
        window.innerWidth - panelWidth - viewportPadding,
      )
      const top = Math.min(
        Math.max(viewportPadding, rect.top - 10),
        window.innerHeight - panelHeight - viewportPadding,
      )
      const panelOverlapsAnchor = left < rect.right && left + panelWidth > rect.left
      const side = panelOverlapsAnchor ? 'center' : openRight ? 'right' : 'left'
      const anchorY = Math.min(Math.max(rect.top + Math.min(rect.height / 2, 44) - top, 24), panelHeight - 24)

      // 使用 fixed portal 避开列滚动容器的 overflow 裁切；滚动和缩放时重新锚定，卡片本身不参与详情布局。
      setPlacement({
        side,
        style: {
          left,
          top,
          width: panelWidth,
          height: panelHeight,
          '--normal-detail-anchor-y': `${anchorY}px`,
        },
      })
    }

    updatePlacement()
    const resizeObserver = new ResizeObserver(updatePlacement)
    if (anchorRef.current) resizeObserver.observe(anchorRef.current)
    window.addEventListener('resize', updatePlacement)
    window.addEventListener('scroll', updatePlacement, true)
    return () => {
      resizeObserver.disconnect()
      window.removeEventListener('resize', updatePlacement)
      window.removeEventListener('scroll', updatePlacement, true)
    }
  }, [anchorRef, task.id, task.updatedAt])

  useEffect(() => {
    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return createPortal(
    <div
      className="normal-task-detail-layer"
      role="presentation"
      onMouseDown={(event) => {
        // 只把红框外的遮罩视为关闭区域；详情内部所有点击都留给正文和操作控件处理。
        if (event.target === event.currentTarget) onClose()
      }}
      // Portal 的 React 事件仍会冒泡回任务卡；必须在这里截断，避免内部点击触发卡片收起。
      onClick={(event) => event.stopPropagation()}
    >
      <aside
        className={`normal-task-detail-popover side-${placement.side} ${isAgentCreatedTask(task) ? 'agent-task' : 'human-task'}`}
        role="dialog"
        aria-modal="true"
        aria-label={`${task.title} 的任务详情`}
        style={placement.style}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="normal-task-detail-head">
          <div>
            <span className="normal-task-origin">{isAgentCreatedTask(task) ? 'AI 任务' : '人工任务'}</span>
            <h3><TaskNoticeDots task={task} />{task.title}</h3>
          </div>
          <button className="icon-button" type="button" title="收起任务详情" onClick={onClose}>
            <AppIcon name="close" />
          </button>
        </header>
        <div className="normal-task-detail-summary">
          <span className={`priority priority-${task.priority}`}>{priorityConfig[task.priority].label}</span>
          <span className="status-pill">{statusConfig[task.status].label}</span>
          {task.parentTaskId && (
            <span className={`branch-pill branch-pill-${task.parentLink?.type === 'discovered_from' ? 'discovered' : 'planned'}`}>
              {getTaskParentLinkLabel(task)}
            </span>
          )}
          <span>{getTaskTimeLabel(task)}</span>
          {task.project && <span>{task.project}</span>}
        </div>
        <div className="normal-task-detail-scroll">
          <CompletionGateNotice
            task={task}
            onConfirm={onComplete}
            onContinue={onContinueCompletionRequest}
            onDismiss={onDismissCompletionRequest}
          />
          <SessionReviewNotice task={task} onResolve={onResolveSessionReview} onOpenSession={onOpenAgentSession} />
          <ParentCompletionReviewNotice task={task} childTasks={childTasks} onConfirm={onComplete} onKeep={onKeepParentTaskOpen} />
          {task.detail && <TaskDetailText detail={task.detail} variant="card" />}
          <TaskRelationshipSummary task={task} taskPath={taskPath} childTasks={childTasks} onOpenTask={onOpenRelatedTask} onOpenTopology={onOpenTopology} />
          <TaskChildList
            task={task}
            childTasks={childTasks}
            onOpenTask={onOpenRelatedTask}
            onCreateChildTask={onCreateChildTask}
          />
          <TaskParentBinder task={task} parentTask={parentTask} parentCandidates={parentTaskCandidates} onChangeParentTask={onChangeParentTask} />
          <dl>
            <div><dt>创建</dt><dd>{formatDateTime(task.createdAt)}</dd></div>
            {task.project && <div><dt>项目</dt><dd>{task.project}</dd></div>}
            {task.dueAt && <div><dt>截止</dt><dd>{formatDateTime(task.dueAt)}</dd></div>}
            {task.reminderAt && <div><dt>提醒</dt><dd>{formatDateTime(task.reminderAt)}</dd></div>}
            {task.completedAt && <div><dt>完成</dt><dd>{formatDateTime(task.completedAt)}</dd></div>}
          </dl>
          {task.tags.length > 0 && (
            <div className="tag-list">
              {task.tags.map((tag) => <span key={tag}>#{tag}</span>)}
            </div>
          )}
          {task.imagePaths.length > 0 && (
            <div className="preview-grid inline-preview-grid">
              {task.imagePaths.map((image, index) => (
                <button
                  key={image.path}
                  className="preview-thumb"
                  type="button"
                  title="查看大图"
                  onClick={() => onPreviewImages(task.imagePaths, index, task.title)}
                >
                  <img src={image.url} alt={image.name} />
                </button>
              ))}
            </div>
          )}
        </div>
        <footer className="normal-task-detail-actions">
          {!isDone && task.status !== 'pending_acceptance' && <button className="primary-button" type="button" onClick={() => onComplete(task.id)}>完成</button>}
          {isDone && <button type="button" onClick={() => onMove(task.id, 'todo')}>转待办</button>}
          {isDone && <button type="button" onClick={() => onMove(task.id, 'doing')}>继续做</button>}
          {!isDone && task.status !== 'doing' && <button type="button" onClick={() => onMove(task.id, 'doing')}>开始</button>}
          {!isDone && task.status !== 'todo' && <button type="button" onClick={() => onMove(task.id, 'todo')}>待办</button>}
          <button type="button" onClick={() => onCopy(task)}>复制</button>
          {canOpenAgentSession(task) && <button type="button" onClick={() => onOpenAgentSession(task)}>会话</button>}
          {(task.reminderAt || task.dueAt) && <button type="button" onClick={() => onOpenCalendar(task)}>日历</button>}
          <button type="button" onClick={() => onEdit(task)}>编辑</button>
          <button className="danger-button" type="button" onClick={() => onDelete(task.id)}>删除</button>
        </footer>
      </aside>
    </div>,
    document.body,
  )
}

function TaskCard({
  task,
  selected,
  detailOpen,
  multiSelected,
  taskPath,
  parentTask,
  childTasks,
  parentTaskCandidates,
  compact = false,
  onSelect,
  onSelectWithEvent,
  onEdit,
  onComplete,
  onToggleDone,
  onKeepParentTaskOpen,
  onChangeParentTask,
  onCreateChildTask,
  onOpenRelatedTask,
  onOpenTopology,
  onContinueCompletionRequest,
  onDismissCompletionRequest,
  onResolveSessionReview,
  onDragStart,
  onMove,
  onDelete,
  onPreviewImages,
  onCopy,
  onOpenCalendar,
  onOpenAgentSession,
}: TaskCardProps) {
  const cardRef = useRef<HTMLElement | null>(null)
  const isDone = task.status === 'done'
  const isOverdue = !isDone && task.dueAt && new Date(task.dueAt).getTime() < Date.now()
  const hasCompletionNotice = hasActiveCompletionGate(task)
  const hasSessionReviewNotice = hasActiveSessionReview(task)
  const hasParentReviewNotice = hasActiveParentCompletionReview(task)
  const hasNotice = hasCompletionNotice || hasSessionReviewNotice || hasParentReviewNotice

  return (
    <article
      ref={cardRef}
      className={`task-card ${isAgentCreatedTask(task) ? 'agent-task' : ''} ${selected ? 'selected' : ''} ${multiSelected ? 'multi-selected' : ''} ${compact ? 'compact' : ''} ${hasNotice ? 'has-task-notice' : ''} ${hasCompletionNotice ? 'has-completion-notice' : ''} ${hasSessionReviewNotice ? 'has-session-review-notice' : ''} ${hasParentReviewNotice ? 'has-parent-review-notice' : ''}`}
      draggable
      onDragStart={(event) => {
        if (isInteractiveTaskEventTarget(event.target)) {
          event.preventDefault()
          onDragStart('')
          return
        }
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('text/plain', task.id)
        onDragStart(task.id)
      }}
      onDragEnd={() => onDragStart('')}
      onClick={(event: ReactMouseEvent<HTMLElement>) => {
        if (isInteractiveTaskEventTarget(event.target)) return
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
          <strong>
            <TaskNoticeDots task={task} />
            {task.title}
          </strong>
          {!compact && !selected && task.detail && <small>{task.detail}</small>}
        </div>
      </div>
      <div className="meta-row">
        <span className={`priority priority-${task.priority}`}>{priorityConfig[task.priority].label}</span>
        <span className="status-pill">{statusConfig[task.status].label}</span>
        {task.parentTaskId && (
          <span className={`branch-pill branch-pill-${task.parentLink?.type === 'discovered_from' ? 'discovered' : 'planned'}`}>
            {getTaskParentLinkLabel(task)}
          </span>
        )}
        <span>{getTaskTimeLabel(task)}</span>
        {task.project && <span>{task.project}</span>}
        {task.dueAt && isOverdue && <span className="danger">已逾期</span>}
        {task.imagePaths.length > 0 && <span>{task.imagePaths.length}图</span>}
      </div>
      {detailOpen && (
        <NormalTaskDetailPopover
          task={task}
          anchorRef={cardRef}
          taskPath={taskPath}
          parentTask={parentTask}
          childTasks={childTasks}
          parentTaskCandidates={parentTaskCandidates}
          onClose={() => onSelect(task.id)}
          onEdit={onEdit}
          onComplete={onComplete}
          onKeepParentTaskOpen={onKeepParentTaskOpen}
          onChangeParentTask={onChangeParentTask}
          onCreateChildTask={onCreateChildTask}
          onOpenRelatedTask={onOpenRelatedTask}
          onOpenTopology={onOpenTopology}
          onContinueCompletionRequest={onContinueCompletionRequest}
          onDismissCompletionRequest={onDismissCompletionRequest}
          onResolveSessionReview={onResolveSessionReview}
          onMove={onMove}
          onDelete={onDelete}
          onPreviewImages={onPreviewImages}
          onCopy={onCopy}
          onOpenCalendar={onOpenCalendar}
          onOpenAgentSession={onOpenAgentSession}
        />
      )}
    </article>
  )
}

export default App
