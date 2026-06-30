import { useCallback, useEffect, useMemo, useState } from 'react'
import './App.css'
import type { DragEvent, FormEvent, KeyboardEvent } from 'react'
import type { AddMode, AppData, AppMode, AppSettings, Task, TaskImage, TaskPriority, TaskStatus } from './types'

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

function createDefaultData(): AppData {
  const now = new Date().toISOString()
  return {
    version: 1,
    settings: {
      larkDoc: '',
      syncOnComplete: true,
      keepOnTop: false,
      snapToEdge: true,
      apiEnabled: true,
      apiPort: 47731,
      aiEnabled: false,
      aiBaseUrl: 'https://api.openai.com/v1',
      aiModel: 'gpt-4o-mini',
      aiApiKey: '',
      appMode: 'normal',
      miniColumn: 'doing',
      addMode: 'quick',
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
      },
    ],
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
      edgeDocked: false,
    },
    tasks: Array.isArray(value.tasks) ? value.tasks : [],
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
  if (task.completedAt) return `完成 ${formatDateTime(task.completedAt)}`
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

function App() {
  const [data, setData] = useState<AppData>(() => createDefaultData())
  const [isLoaded, setIsLoaded] = useState(false)
  const [search, setSearch] = useState('')
  const [selectedTaskId, setSelectedTaskId] = useState<string>('')
  const [editingTaskId, setEditingTaskId] = useState<string>('')
  const [draft, setDraft] = useState(emptyTaskDraft)
  const [attachedImages, setAttachedImages] = useState<TaskImage[]>([])
  const [syncState, setSyncState] = useState('尚未同步')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [quickText, setQuickText] = useState('')
  const [aiState, setAiState] = useState('AI 元数据识别未启用')
  const [draggingTaskId, setDraggingTaskId] = useState('')
  const [dockState, setDockState] = useState({ docked: false, edge: '' })

  useEffect(() => {
    loadData()
      .then((nextData) => {
        setData(nextData)
        setSelectedTaskId(nextData.tasks[0]?.id ?? '')
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

  const filteredTasks = useMemo(() => {
    const keyword = normalizeKeywords(search)
    return data.tasks.filter((task) => fuzzyIncludes(taskSearchText(task), keyword))
  }, [data.tasks, search])

  const groupedTasks = useMemo(
    () => ({
      doing: filteredTasks.filter((task) => task.status === 'doing'),
      todo: filteredTasks.filter((task) => task.status === 'todo'),
      done: filteredTasks
        .filter((task) => task.status === 'done')
        .sort((left, right) => String(right.completedAt).localeCompare(String(left.completedAt))),
    }),
    [filteredTasks],
  )

  const selectedTask = data.tasks.find((task) => task.id === selectedTaskId)
  const doingCount = data.tasks.filter((task) => task.status === 'doing').length
  const activeCount = data.tasks.filter((task) => task.status !== 'done').length
  const overdueCount = data.tasks.filter(
    (task) => task.status !== 'done' && task.dueAt && new Date(task.dueAt).getTime() < Date.now(),
  ).length

  const persist = useCallback(async (nextData: AppData) => {
    const saved = await saveData(nextData)
    setData(saved)
    return saved
  }, [])

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
      remindedAt: existing?.remindedAt ?? '',
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

  async function parseTextToDraft(text: string, status: TaskStatus) {
    const trimmed = text.trim()
    if (!trimmed) return { ...emptyTaskDraft, status }
    if (!data.settings.aiEnabled) {
      setAiState('AI 元数据识别未启用')
      return { ...emptyTaskDraft, title: trimmed, status }
    }
    if (!window.todoDesk?.parseTask) {
      setAiState('AI 解析需要桌面 App 运行')
      return { ...emptyTaskDraft, title: trimmed, status }
    }

    setAiState('正在识别时间、优先级和标签...')
    try {
      const result = await window.todoDesk.parseTask({ text: trimmed, settings: data.settings })
      if (result.ok && result.task) {
        setAiState('AI 已填充元数据')
        return applyParsedTaskToDraft(result.task, trimmed, status)
      }
      setAiState(result.message || 'AI 解析失败，已按普通文本添加')
    } catch (error) {
      setAiState(error instanceof Error ? error.message : 'AI 解析失败，已按普通文本添加')
    }
    return { ...emptyTaskDraft, title: trimmed, status }
  }

  async function handleQuickSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmed = quickText.trim()
    if (!trimmed) return
    const parsedDraft = await parseTextToDraft(trimmed, 'todo')
    const now = new Date().toISOString()
    const nextTask: Task = {
      id: crypto.randomUUID(),
      title: parsedDraft.title.trim() || trimmed,
      detail: parsedDraft.detail.trim(),
      status: parsedDraft.status,
      priority: parsedDraft.priority,
      project: parsedDraft.project.trim(),
      tags: parseTags(parsedDraft.tags),
      dueAt: fromLocalInputValue(parsedDraft.dueAt),
      reminderAt: fromLocalInputValue(parsedDraft.reminderAt),
      imagePaths: [],
      createdAt: now,
      updatedAt: now,
      completedAt: parsedDraft.status === 'done' ? now : '',
      remindedAt: '',
    }
    const saved = await persist({ ...data, tasks: [nextTask, ...data.tasks] })
    setData(saved)
    setSelectedTaskId(nextTask.id)
    setQuickText('')
  }

  async function fillDraftWithAi() {
    const source = [draft.title, draft.detail].filter(Boolean).join('\n')
    if (!source.trim()) {
      setAiState('先输入标题或详情')
      return
    }
    const parsedDraft = await parseTextToDraft(source, draft.status)
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
    if (!('Notification' in window)) return

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
  }, [data.tasks, updateTask])

  async function deleteTask(taskId: string) {
    const nextTasks = data.tasks.filter((task) => task.id !== taskId)
    await persist({ ...data, tasks: nextTasks })
    if (selectedTaskId === taskId) {
      setSelectedTaskId(nextTasks[0]?.id ?? '')
    }
    if (editingTaskId === taskId) {
      startCreate('todo')
    }
  }

  async function updateSettings(patch: Partial<AppSettings>) {
    const nextData = {
      ...data,
      settings: {
        ...data.settings,
        ...patch,
      },
    }
    await persist(nextData)
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

  function removeImage(path: string) {
    setAttachedImages((current) => current.filter((image) => image.path !== path))
  }

  async function revealStorage() {
    if (!window.todoDesk) {
      setSyncState('浏览器模式数据保存在 localStorage')
      return
    }
    await window.todoDesk.revealStorage()
  }

  function handleDraftKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.currentTarget.form?.requestSubmit()
    }
  }

  if (!isLoaded) {
    return (
      <main className="loading-shell">
        <div className="loading-mark">TD</div>
        <p>正在读取本地看板</p>
      </main>
    )
  }

  const visibleStatuses = data.settings.appMode === 'mini' ? [data.settings.miniColumn] : taskStatuses
  const isQuickComposer = !editingTaskId && data.settings.addMode === 'quick'

  if (dockState.docked) {
    const miniTasks = groupedTasks[data.settings.miniColumn]
    return (
      <main className={`app-shell dock-shell dock-${dockState.edge || 'right'}`}>
        <button className="dock-restore" type="button" onClick={() => window.todoDesk?.restoreDock()}>
          ↔
        </button>
        <section className="dock-card">
          <h1>{statusConfig[data.settings.miniColumn].label}</h1>
          <div className="dock-list">
            {miniTasks.slice(0, 8).map((task) => (
              <button key={task.id} type="button" onClick={() => setSelectedTaskId(task.id)}>
                <strong>{task.title}</strong>
                <small>{getTaskTimeLabel(task)}</small>
              </button>
            ))}
            {miniTasks.length === 0 && <span>暂无任务</span>}
          </div>
        </section>
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
          {data.settings.appMode === 'mini' && (
            <select
              className="mini-column-picker"
              value={data.settings.miniColumn}
              aria-label="小卡显示列表"
              onChange={(event) => updateSettings({ miniColumn: event.target.value as TaskStatus })}
            >
              {taskStatuses.map((status) => (
                <option key={status} value={status}>
                  {statusConfig[status].label}
                </option>
              ))}
            </select>
          )}
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
        <button className="primary-button" type="button" onClick={() => startCreate('todo')}>
          新建任务 +
        </button>
      </section>

      <div className="quiet-status">
        <span>{data.settings.larkDoc ? '完成后自动同步飞书' : '未配置飞书文档'}</span>
        <span>本地 JSON 自动保存</span>
        <span>API {data.settings.apiEnabled ? `127.0.0.1:${data.settings.apiPort}` : '已关闭'}</span>
      </div>

      <section className={`board ${data.settings.appMode === 'mini' ? 'board-mini' : 'board-three'}`}>
        {visibleStatuses.map((status) => (
          <TaskColumn
            key={status}
            status={status}
            tasks={groupedTasks[status]}
            selectedTaskId={selectedTaskId}
            onAdd={() => startCreate(status === 'done' ? 'todo' : status)}
            onSelect={setSelectedTaskId}
            onEdit={startEdit}
            onComplete={completeTask}
            onToggleDone={toggleDone}
            draggingTaskId={draggingTaskId}
            onDragStart={setDraggingTaskId}
            onDropTask={moveTask}
            onMove={moveTask}
            onDelete={deleteTask}
          />
        ))}
      </section>

      <section className="composer">
        <header className="section-head">
          <div>
            <h2>{editingTaskId ? '编辑任务' : '添加任务'}</h2>
            <p>{isQuickComposer ? '输入一句话，AI 自动识别时间和元数据' : '手动维护完整任务信息'}</p>
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
          <form className="quick-form" onSubmit={handleQuickSubmit}>
            <textarea
              value={quickText}
              onChange={(event) => setQuickText(event.target.value)}
              placeholder="例如：明天下午 3 点提醒我整理周报，归到工作，优先级高"
            />
            <div className="form-actions">
              <span>{aiState}</span>
              <button className="primary-button" type="submit">
                智能添加
              </button>
            </div>
          </form>
        ) : (
          <form onSubmit={handleSubmit}>
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
          </div>
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

      {selectedTask && (
        <aside className="detail-drawer">
          <header className="section-head">
            <div>
              <h2>任务详情</h2>
              <p>当前选中：{selectedTask.title}</p>
            </div>
          </header>
          <div>
            <span className={`priority priority-${selectedTask.priority}`}>
              {priorityConfig[selectedTask.priority].label}
            </span>
            <span className="status-pill">{statusConfig[selectedTask.status].label}</span>
          </div>
          <h2>{selectedTask.title}</h2>
          {selectedTask.detail && <p>{selectedTask.detail}</p>}
          <dl>
            {selectedTask.project && (
              <>
                <dt>项目</dt>
                <dd>{selectedTask.project}</dd>
              </>
            )}
            {selectedTask.dueAt && (
              <>
                <dt>截止</dt>
                <dd>{formatDateTime(selectedTask.dueAt)}</dd>
              </>
            )}
            {selectedTask.reminderAt && (
              <>
                <dt>提醒</dt>
                <dd>{formatDateTime(selectedTask.reminderAt)}</dd>
              </>
            )}
            {selectedTask.completedAt && (
              <>
                <dt>完成</dt>
                <dd>{formatDateTime(selectedTask.completedAt)}</dd>
              </>
            )}
          </dl>
          {selectedTask.tags.length > 0 && (
            <div className="tag-list">
              {selectedTask.tags.map((tag) => (
                <span key={tag}>#{tag}</span>
              ))}
            </div>
          )}
          {selectedTask.imagePaths.length > 0 && (
            <div className="preview-grid">
              {selectedTask.imagePaths.map((image) => (
                <img key={image.path} src={image.url} alt={image.name} />
              ))}
            </div>
          )}
        </aside>
      )}

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

            <div className="settings-actions">
              <button type="button" onClick={revealStorage}>
                打开本地数据
              </button>
              <button type="button" onClick={() => syncToLark()}>
                立即同步飞书
              </button>
            </div>
            <p className="settings-status">{syncState}</p>
          </aside>
        </div>
      )}
    </main>
  )
}

interface TaskColumnProps {
  status: TaskStatus
  tasks: Task[]
  selectedTaskId: string
  onAdd: () => void
  onSelect: (taskId: string) => void
  onEdit: (task: Task) => void
  onComplete: (taskId: string) => void
  onToggleDone: (taskId: string) => void
  draggingTaskId: string
  onDragStart: (taskId: string) => void
  onDropTask: (taskId: string, status: TaskStatus) => void
  onMove: (taskId: string, status: TaskStatus) => void
  onDelete: (taskId: string) => void
}

function TaskColumn({
  status,
  tasks,
  selectedTaskId,
  onAdd,
  onSelect,
  onEdit,
  onComplete,
  onToggleDone,
  draggingTaskId,
  onDragStart,
  onDropTask,
  onMove,
  onDelete,
}: TaskColumnProps) {
  const isDragTarget = Boolean(draggingTaskId)

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
      className={`column column-${status} ${isDragTarget ? 'drop-ready' : ''}`}
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
        {status !== 'done' && (
          <button type="button" title="新增任务" onClick={onAdd}>
            +
          </button>
        )}
      </header>
      <div className="task-list">
        {tasks.length === 0 && <p className="empty-state">这里暂时没有事项</p>}
        {tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            selected={task.id === selectedTaskId}
            onSelect={onSelect}
            onEdit={onEdit}
            onComplete={onComplete}
            onToggleDone={onToggleDone}
            onDragStart={onDragStart}
            onMove={onMove}
            onDelete={onDelete}
          />
        ))}
      </div>
    </section>
  )
}

interface TaskCardProps {
  task: Task
  selected: boolean
  compact?: boolean
  onSelect: (taskId: string) => void
  onEdit: (task: Task) => void
  onComplete: (taskId: string) => void
  onToggleDone: (taskId: string) => void
  onDragStart: (taskId: string) => void
  onMove: (taskId: string, status: TaskStatus) => void
  onDelete: (taskId: string) => void
}

function TaskCard({
  task,
  selected,
  compact = false,
  onSelect,
  onEdit,
  onComplete,
  onToggleDone,
  onDragStart,
  onMove,
  onDelete,
}: TaskCardProps) {
  const isDone = task.status === 'done'
  const isOverdue = !isDone && task.dueAt && new Date(task.dueAt).getTime() < Date.now()

  return (
    <article
      className={`task-card ${selected ? 'selected' : ''} ${compact ? 'compact' : ''}`}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('text/plain', task.id)
        onDragStart(task.id)
      }}
      onDragEnd={() => onDragStart('')}
    >
      <div className="task-main">
        <button
          className={`check ${isDone ? 'checked' : ''}`}
          type="button"
          aria-label={isDone ? '取消完成' : '完成任务'}
          onClick={() => onToggleDone(task.id)}
        >
          ✓
        </button>
        <button
          className="task-copy"
          type="button"
          onClick={() => onSelect(task.id)}
          onDoubleClick={() => onEdit(task)}
        >
          <strong>{task.title}</strong>
          {!compact && task.detail && <small>{task.detail}</small>}
        </button>
      </div>
      <div className="meta-row">
        <span className={`priority priority-${task.priority}`}>{priorityConfig[task.priority].label}</span>
        <span>{getTaskTimeLabel(task)}</span>
        {task.project && <span>{task.project}</span>}
        {task.dueAt && isOverdue && <span className="danger">已逾期</span>}
        {task.imagePaths.length > 0 && <span>{task.imagePaths.length}图</span>}
      </div>
      {task.tags.length > 0 && !compact && (
        <div className="tag-list">
          {task.tags.map((tag) => (
            <span key={tag}>#{tag}</span>
          ))}
        </div>
      )}
      <div className="card-actions">
        {!isDone ? (
          <button type="button" onClick={() => onComplete(task.id)}>
            完成
          </button>
        ) : (
          <>
            <button type="button" onClick={() => onMove(task.id, 'todo')}>
              转待办
            </button>
            <button type="button" onClick={() => onMove(task.id, 'doing')}>
              继续做
            </button>
          </>
        )}
        {!isDone && task.status !== 'doing' && (
          <button type="button" onClick={() => onMove(task.id, 'doing')}>
            开始
          </button>
        )}
        {!isDone && task.status !== 'todo' && (
          <button type="button" onClick={() => onMove(task.id, 'todo')}>
            待办
          </button>
        )}
        <button type="button" onClick={() => onEdit(task)}>
          编辑
        </button>
        <button type="button" onClick={() => onDelete(task.id)}>
          删除
        </button>
      </div>
    </article>
  )
}

export default App
