import { app, BrowserWindow, clipboard, dialog, ipcMain, screen, shell } from 'electron'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { appendFile, copyFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { basename, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildAiEndpoint, buildAiFallbackEndpoint, buildAiMergeRequestPayload, clipText, looksLikeHtml, normalizeMergedTask, parseTasksWithAiAndImages, parseTasksWithLocalFallback } from './ai-task-parser.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const isDev = Boolean(process.env.VITE_DEV_SERVER_URL)
const appDataVersion = 2
let mainWindow = null
let apiServer = null
let apiPort = null
let lastNormalBounds = null
let lastNormalModeBounds = null
let isDocked = false
let currentDockEdge = ''
let keepOnTopBeforeDock = false
let currentAppMode = 'normal'
let suppressMoveHandlingUntil = 0
let dockDragStartBounds = null
let dockPassthrough = false
let dockTransitioning = false

const dockCollapsedWidth = 152
const dockDetailWidth = 260
const dockDetailGap = 12
const dockExpandedWidth = dockCollapsedWidth + dockDetailGap + dockDetailWidth
const dockDetachThreshold = 96
const dockTransitionFadeOutMs = 90
const dockTransitionFadeInMs = 140
const dockTransitionHiddenOpacity = 0.08
const normalWindowBackground = '#f7f2e8'
const transparentWindowBackground = '#00000000'
const aiRequestTimeoutMs = 45_000
const calendarSyncRetryMs = 10 * 60_000
const calendarSyncTimeoutMs = 20_000
const miniWindowWidth = 300
const miniWindowHeight = 420
const miniWindowMinWidth = 300
const miniWindowMinHeight = 350
const codexThreadIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const taskStatuses = new Set(['doing', 'todo', 'pending_acceptance', 'done'])
const completionAcceptanceMessage = '实现已完成，等待用户确认是否标记 done'
const incompleteSessionMessage = '本轮 session 输出完成，但任务尚未完成'
const originKinds = new Set(['human', 'agent', 'integration', 'system', 'legacy'])
const originChannels = new Set(['ui', 'local-api', 'todo-desk-skill', 'import', 'automation'])
const originConfidences = new Set(['explicit', 'legacy-inferred'])
const legacyAgentSources = new Set(['codex', 'claude', 'cursor', 'kimi', 'forceclaw'])
const uiDerivedSources = new Set(['merge', 'ai-merge'])

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== ''))
}

function normalizeString(value) {
  return String(value || '').trim()
}

function humanOrigin(createdVia, confidence = 'explicit') {
  return {
    kind: 'human',
    channel: 'ui',
    createdVia,
    confidence,
  }
}

function normalizeExplicitOrigin(origin) {
  if (!origin || typeof origin !== 'object') return null
  const kind = normalizeString(origin.kind)
  if (!originKinds.has(kind)) return null
  const channel = normalizeString(origin.channel)
  const confidence = normalizeString(origin.confidence)
  const agent = origin.agent && typeof origin.agent === 'object'
    ? compactObject({
        name: normalizeString(origin.agent.name),
        sessionId: normalizeString(origin.agent.sessionId),
        tool: normalizeString(origin.agent.tool),
      })
    : undefined
  const repository = origin.repository && typeof origin.repository === 'object'
    ? compactObject({
        name: normalizeString(origin.repository.name),
        path: normalizeString(origin.repository.path),
        remote: normalizeString(origin.repository.remote),
        branch: normalizeString(origin.repository.branch),
      })
    : undefined
  const client = origin.client && typeof origin.client === 'object'
    ? compactObject({
        name: normalizeString(origin.client.name),
        version: normalizeString(origin.client.version),
      })
    : undefined

  return compactObject({
    kind,
    channel: originChannels.has(channel) ? channel : kind === 'human' ? 'ui' : 'local-api',
    createdVia: normalizeString(origin.createdVia) || 'unknown',
    confidence: originConfidences.has(confidence) ? confidence : 'explicit',
    agent: agent?.name ? agent : undefined,
    repository: Object.keys(repository || {}).length ? repository : undefined,
    client: client?.name ? client : undefined,
  })
}

function inferOriginFromTask(task, confidence = 'legacy-inferred') {
  const source = normalizeString(task.source).toLowerCase()
  const agentName = normalizeString(task.agent || task.agentName || (legacyAgentSources.has(source) ? source : ''))
  const sessionId = normalizeString(task.agentSessionId || task.sessionId || task.session)
  const repositoryName = normalizeString(task.repository || task.repo)
  const repositoryPath = normalizeString(task.repositoryPath || task.repoPath)

  if (agentName || sessionId || legacyAgentSources.has(source)) {
    const agent = compactObject({
      name: agentName || source || 'unknown',
      sessionId,
      tool: agentName || source,
    })
    const repository = compactObject({
      name: repositoryName,
      path: repositoryPath,
    })
    return compactObject({
      kind: 'agent',
      channel: confidence === 'explicit' && source === 'todo-desk-skill' ? 'todo-desk-skill' : 'local-api',
      createdVia: source || 'legacy-api',
      confidence,
      agent,
      repository: Object.keys(repository).length ? repository : undefined,
    })
  }

  if (uiDerivedSources.has(source)) {
    return {
      kind: 'human',
      channel: 'ui',
      createdVia: source,
      confidence,
    }
  }

  if (source) {
    return {
      kind: source === 'api' ? 'integration' : 'legacy',
      channel: 'local-api',
      createdVia: source,
      confidence,
    }
  }

  return humanOrigin('legacy-ui', confidence)
}

function normalizeTaskOrigin(task, confidence = 'legacy-inferred') {
  const explicit = normalizeExplicitOrigin(task.origin)
  const completionAcceptance = normalizeCompletionAcceptance(task.completionAcceptance)
  const sessionReview = normalizeSessionReview(task.sessionReview)
  if (explicit) return compactObject({ ...task, completionAcceptance, sessionReview, origin: explicit })
  return compactObject({ ...task, completionAcceptance, sessionReview, origin: inferOriginFromTask(task, confidence) })
}

function isAgentLikeTask(task) {
  return task?.origin?.kind === 'agent' || Boolean(task?.agent || task?.agentSessionId)
}

function completionRequestedBy(task) {
  return normalizeString(task?.origin?.agent?.name || task?.agent || task?.source || 'agent')
}

function normalizeCompletionAcceptance(value) {
  if (!value || typeof value !== 'object') return undefined
  const resolution = normalizeString(value.resolution)
  const normalized = compactObject({
    requestedAt: normalizeString(value.requestedAt),
    requestedBy: normalizeString(value.requestedBy),
    message: normalizeString(value.message),
    resolvedAt: normalizeString(value.resolvedAt),
    resolution: ['accepted', 'rework', 'dismissed'].includes(resolution) ? resolution : undefined,
  })
  return normalized.requestedAt || normalized.message ? normalized : undefined
}

function normalizeSessionReview(value) {
  if (!value || typeof value !== 'object') return undefined
  const resolution = normalizeString(value.resolution)
  const normalized = compactObject({
    requestedAt: normalizeString(value.requestedAt),
    requestedBy: normalizeString(value.requestedBy),
    message: normalizeString(value.message),
    resolvedAt: normalizeString(value.resolvedAt),
    resolution: ['reviewed', 'rework', 'dismissed'].includes(resolution) ? resolution : undefined,
  })
  return normalized.requestedAt || normalized.message ? normalized : undefined
}

function ensureCompletionAcceptance(task, now) {
  const current = normalizeCompletionAcceptance(task.completionAcceptance)
  return {
    requestedAt: current?.requestedAt || now,
    requestedBy: current?.requestedBy || completionRequestedBy(task),
    message: current?.message || completionAcceptanceMessage,
  }
}

function ensureSessionReview(task, input, now) {
  const current = normalizeSessionReview(task.sessionReview)
  const requestedBy = completionRequestedBy(task)
  return {
    requestedAt: current?.requestedAt || now,
    requestedBy: current?.requestedBy || requestedBy,
    message: normalizeString(input.sessionReviewMessage || input.reviewMessage || input.humanInputMessage || input.blockedMessage) || current?.message || incompleteSessionMessage,
  }
}

function appendCompletionAcceptanceMessage(detail) {
  const current = normalizeString(detail)
  if (current.includes(completionAcceptanceMessage)) return current
  return [current, completionAcceptanceMessage].filter(Boolean).join('\n\n')
}

function completionDecision(input) {
  const decision = normalizeString(input.completionDecision || input.acceptanceDecision).toLowerCase()
  if (['confirm', 'accepted', 'accept', 'done'].includes(decision) || input.userConfirmedCompletion === true) return 'confirm'
  if (['continue', 'rework', 'modify'].includes(decision)) return 'continue'
  if (['dismiss', 'dismissed', 'later', 'ignore'].includes(decision)) return 'dismiss'
  return ''
}

function applyCompletionDecision(task, input, now) {
  const decision = completionDecision(input)
  if (!decision) return null

  const base = ensureCompletionAcceptance(task, now)
  if (decision === 'confirm') {
    return {
      status: 'done',
      completedAt: task.completedAt || now,
      sessionReview: undefined,
      completionAcceptance: {
        ...base,
        resolution: 'accepted',
        resolvedAt: now,
      },
    }
  }
  if (decision === 'continue') {
    return {
      status: 'doing',
      completedAt: '',
      completionAcceptance: {
        ...base,
        resolution: 'rework',
        resolvedAt: now,
      },
    }
  }
  return {
    completionAcceptance: {
      ...base,
      resolution: 'dismissed',
      resolvedAt: now,
    },
  }
}

function sessionReviewDecision(input) {
  const decision = normalizeString(input.sessionReviewDecision || input.reviewDecision).toLowerCase()
  if (['reviewed', 'review', 'seen', 'ok', 'ack'].includes(decision) || input.userReviewedSession === true) return 'reviewed'
  if (['continue', 'rework', 'modify'].includes(decision)) return 'rework'
  if (['dismiss', 'dismissed', 'later', 'ignore'].includes(decision)) return 'dismissed'
  return ''
}

function applySessionReview(task, input, now) {
  // Blue-dot metadata means this session turn is done, but the task is still unfinished.
  // Completed work must use the red completion gate so the user explicitly accepts "done".
  const requested = input.status === 'pending_acceptance' || task.status === 'pending_acceptance'
    ? false
    : input.requestHumanInput || input.requestBlocked || input.requestSessionReview || input.requestReview
  if (!requested && !sessionReviewDecision(input)) return null

  const decision = sessionReviewDecision(input)
  const base = ensureSessionReview(task, input, now)
  if (!decision) return { sessionReview: base }

  const patch = {
    sessionReview: {
      ...base,
      resolution: decision,
      resolvedAt: now,
    },
  }
  if (decision === 'rework') {
    patch.status = 'doing'
    patch.completedAt = ''
  }
  if (decision === 'dismissed' && task.status === 'doing') {
    patch.status = 'todo'
    patch.completedAt = ''
  }
  return patch
}

function gateAgentCompletion(task, input, now) {
  if (input.status !== 'done' || !isAgentLikeTask(task) || completionDecision(input) === 'confirm') return null
  return {
    status: 'pending_acceptance',
    completedAt: '',
    detail: appendCompletionAcceptanceMessage(task.detail),
    completionAcceptance: ensureCompletionAcceptance(task, now),
    sessionReview: undefined,
  }
}

function getPaths() {
  const userData = app.getPath('userData')
  return {
    userData,
    dataFile: join(userData, 'todo-desk-data.json'),
    attachmentDir: join(userData, 'attachments'),
    calendarDir: join(userData, 'calendar-events'),
    logFile: join(userData, 'todo-desk.log'),
  }
}

async function writeLog(level, message, meta = {}) {
  try {
    const paths = getPaths()
    await mkdir(paths.userData, { recursive: true })
    const line = JSON.stringify({
      at: new Date().toISOString(),
      level,
      message,
      ...meta,
    })
    await appendFile(paths.logFile, `${line}\n`, 'utf8')
  } catch (error) {
    console.error('Todo Desk log write failed:', error)
  }
}

function safeAiMeta(settings, extra = {}) {
  return {
    endpoint: buildAiEndpoint(settings.aiBaseUrl),
    model: settings.aiModel,
    aiEnabled: Boolean(settings.aiEnabled),
    hasApiKey: Boolean(settings.aiApiKey),
    ...extra,
  }
}

function getDefaultData() {
  const now = new Date().toISOString()
  return {
    version: appDataVersion,
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
      columnSorts: {
        doing: 'manual',
        todo: 'manual',
        done: 'completed-desc',
      },
      edgeDocked: false,
    },
    tasks: [
      {
        id: crypto.randomUUID(),
        title: '梳理今天正在推进的工作',
        detail: '把当前工作、待办和已完成事项放进看板，完成后会自动同步到飞书。',
        status: 'doing',
        priority: 'high',
        project: '工作',
        tags: ['初始化'],
        dueAt: '',
        reminderAt: '',
        imagePaths: [],
        createdAt: now,
        updatedAt: now,
        completedAt: '',
        origin: humanOrigin('seed-data'),
      },
      {
        id: crypto.randomUUID(),
        title: '配置飞书文档链接',
        detail: '填入飞书文档 URL 后，勾选完成任务时会自动追加同步当前看板快照。',
        status: 'todo',
        priority: 'medium',
        project: '配置',
        tags: ['飞书'],
        dueAt: '',
        reminderAt: '',
        imagePaths: [],
        createdAt: now,
        updatedAt: now,
        completedAt: '',
        origin: humanOrigin('seed-data'),
      },
    ],
    trash: [],
    syncLog: [],
  }
}

async function ensureStorage() {
  const paths = getPaths()
  await mkdir(paths.attachmentDir, { recursive: true })
  await mkdir(paths.calendarDir, { recursive: true })
  if (!existsSync(paths.dataFile)) {
    await writeJson(paths.dataFile, getDefaultData())
  }
}

async function readJson(filePath) {
  const raw = await readFile(filePath, 'utf8')
  return JSON.parse(raw)
}

async function writeJson(filePath, value) {
  await writeFile(filePath, JSON.stringify(value, null, 2), 'utf8')
}

function hashCalendarSyncValue(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 32)
}

function getTaskEventAt(task) {
  return task?.reminderAt || task?.dueAt || ''
}

function buildTaskCalendarDescription(task) {
  return [
    task.detail,
    task.id ? `Todo Desk ID：${task.id}` : '',
    task.project ? `项目：${task.project}` : '',
    task.tags?.length ? `标签：${task.tags.map((tag) => `#${tag}`).join(' ')}` : '',
    task.agent || task.origin?.agent?.name ? `Agent：${task.agent || task.origin?.agent?.name}` : '',
    task.agentSessionId || task.origin?.agent?.sessionId ? `Session：${task.agentSessionId || task.origin?.agent?.sessionId}` : '',
    task.repository || task.origin?.repository?.name ? `代码库：${task.repository || task.origin?.repository?.name}` : '',
    '由 Todo Desk 自动创建',
  ].filter(Boolean).join('\n')
}

function buildTaskCalendarSignature(task, target, settings) {
  return hashCalendarSyncValue(JSON.stringify({
    target,
    calendarId: target === 'lark' ? settings.larkCalendarId || 'primary' : 'local',
    id: task.id,
    title: task.title,
    detail: task.detail,
    project: task.project,
    tags: task.tags || [],
    dueAt: task.dueAt || '',
    reminderAt: task.reminderAt || '',
  }))
}

function shouldAttemptCalendarTarget(previous, signature) {
  if (!previous || previous.signature !== signature) return true
  if (previous.status === 'ok') return false
  if (previous.status === 'deleted') return true
  const lastAttemptAt = new Date(previous.syncedAt || 0).getTime()
  return !lastAttemptAt || Date.now() - lastAttemptAt > calendarSyncRetryMs
}

function buildCalendarSyncResult(signature, patch) {
  return {
    signature,
    syncedAt: new Date().toISOString(),
    ...patch,
  }
}

function runCommand(command, args, timeoutMs = calendarSyncTimeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`${command} 超过 ${Math.round(timeoutMs / 1000)} 秒未返回`))
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      if (code === 0) {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() })
        return
      }
      reject(new Error(stderr.trim() || stdout.trim() || `${command} exited with code ${code}`))
    })
  })
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function buildCalendarDeleteResult(previous, patch) {
  return {
    signature: previous?.signature || '',
    syncedAt: new Date().toISOString(),
    ...patch,
  }
}

function toAppleScriptString(value) {
  return `"${String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')}"`
}

const appleScriptMonthNames = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

function buildAppleScriptDateLines(variableName, value) {
  const date = new Date(value)
  return [
    `set ${variableName} to current date`,
    // 先把 day 调成 1，避免当前日期是 31 号时切到 2 月这类短月份导致 AppleScript 抛错。
    `set day of ${variableName} to 1`,
    `set year of ${variableName} to ${date.getFullYear()}`,
    `set month of ${variableName} to ${appleScriptMonthNames[date.getMonth()]}`,
    `set day of ${variableName} to ${date.getDate()}`,
    `set time of ${variableName} to ${date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds()}`,
  ]
}

async function runAppleScript(lines) {
  const args = lines.flatMap((line) => ['-e', line])
  return await runCommand('osascript', args)
}

function buildLocalCalendarLookupScript(task, existingEventId = '') {
  const eventAt = getTaskEventAt(task)
  return [
    `set existingEventId to ${toAppleScriptString(existingEventId)}`,
    `set taskTitle to ${toAppleScriptString(task.title || 'Todo Desk 提醒')}`,
    `set taskMarker to ${toAppleScriptString(`Todo Desk ID：${task.id || ''}`)}`,
    `set legacyMarker to ${toAppleScriptString('由 Todo Desk 自动创建')}`,
    ...buildAppleScriptDateLines('targetStart', eventAt),
    'set matchingIds to {}',
    'tell application "Calendar"',
    'repeat with cal in calendars',
    'set matchedEvents to {}',
    'if existingEventId is not "" then',
    'try',
    'set matchedEvents to (events of cal whose uid is existingEventId)',
    'end try',
    'end if',
    'if (count of matchedEvents) is 0 then',
    'try',
    'set matchedEvents to (events of cal whose summary is taskTitle and start date is targetStart and description contains taskMarker)',
    'end try',
    'end if',
    'if (count of matchedEvents) is 0 then',
    'try',
    // 历史版本导入的 .ics 没有写 task id，只能退回到标题 + 时间 + Todo Desk 描述兜底。
    'set matchedEvents to (events of cal whose summary is taskTitle and start date is targetStart and description contains legacyMarker)',
    'end try',
    'end if',
    'repeat with calendarEvent in matchedEvents',
    'try',
    'set end of matchingIds to (uid of calendarEvent as text)',
    'end try',
    'end repeat',
    'end repeat',
    'end tell',
    'set AppleScript\'s text item delimiters to linefeed',
    'return matchingIds as text',
  ]
}

function buildLocalCalendarUpsertScript(task, existingEventId = '') {
  const eventAt = getTaskEventAt(task)
  const start = new Date(eventAt)
  const end = new Date(start.getTime() + 30 * 60_000)
  const alarmMinutes = task.reminderAt ? 0 : 10
  return [
    `set targetCalendarName to ${toAppleScriptString('日历')}`,
    `set existingEventId to ${toAppleScriptString(existingEventId)}`,
    `set taskTitle to ${toAppleScriptString(task.title || 'Todo Desk 提醒')}`,
    `set taskDescription to ${toAppleScriptString(buildTaskCalendarDescription(task))}`,
    ...buildAppleScriptDateLines('targetStart', eventAt),
    ...buildAppleScriptDateLines('targetEnd', end),
    'set targetCalendar to missing value',
    'set targetEvent to missing value',
    'tell application "Calendar"',
    'repeat with cal in calendars',
    'if writable of cal is true then',
    'if targetCalendar is missing value then set targetCalendar to cal',
    'if (name of cal as text) is targetCalendarName then',
    'set targetCalendar to cal',
    'exit repeat',
    'end if',
    'end if',
    'end repeat',
    'if targetCalendar is missing value then error "找不到可写本地日历"',
    'if existingEventId is not "" then',
    'repeat with cal in calendars',
    'try',
    'set matchedEvents to (events of cal whose uid is existingEventId)',
    'if (count of matchedEvents) > 0 then',
    'set targetEvent to item 1 of matchedEvents',
    'exit repeat',
    'end if',
    'end try',
    'end repeat',
    'end if',
    'if targetEvent is missing value then',
    'set targetEvent to make new event at end of events of targetCalendar with properties {summary:taskTitle, start date:targetStart, end date:targetEnd, description:taskDescription}',
    'else',
    'set summary of targetEvent to taskTitle',
    'set start date of targetEvent to targetStart',
    'set end date of targetEvent to targetEnd',
    'set description of targetEvent to taskDescription',
    'end if',
    'try',
    // 更新任务时间时先清掉旧提醒，否则同一个事件会累积多个弹窗提醒。
    'delete every display alarm of targetEvent',
    'end try',
    'tell targetEvent',
    `make new display alarm at end of display alarms with properties {trigger interval:-${alarmMinutes}}`,
    'end tell',
    'return (uid of targetEvent as text)',
    'end tell',
  ]
}

async function findLocalCalendarEventId(task, existingEventId = '', retryCount = 1) {
  for (let attempt = 0; attempt < retryCount; attempt += 1) {
    const { stdout } = await runAppleScript(buildLocalCalendarLookupScript(task, existingEventId))
    const eventId = stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)[0] || ''
    if (eventId) return eventId
    if (attempt < retryCount - 1) await delay(500)
  }
  return ''
}

async function deleteTaskCalendarFile(filePath) {
  if (!filePath || !existsSync(filePath)) return false
  await unlink(filePath)
  return true
}

async function deleteTaskFromLocalCalendar(task) {
  const previous = task.calendarSync?.local || null
  const eventAt = getTaskEventAt(task)
  const filePath = previous?.filePath || ''
  const eventId = previous?.eventId || ''
  const hasSyncedLocalEvent = previous?.status === 'ok' || Boolean(eventId || filePath)

  if (!hasSyncedLocalEvent) {
    return buildCalendarDeleteResult(previous, {
      status: 'skipped',
      filePath,
      eventId,
      message: '本地日历未同步，无需删除',
    })
  }

  let removedFile = false
  try {
    removedFile = await deleteTaskCalendarFile(filePath)
  } catch (error) {
    const message = error instanceof Error ? error.message : '删除本地日历文件失败'
    await writeLog('warn', 'Task local calendar file delete failed', { taskId: task.id, title: task.title, filePath, message })
  }

  if (!eventAt || Number.isNaN(new Date(eventAt).getTime())) {
    return buildCalendarDeleteResult(previous, {
      status: 'deleted',
      filePath,
      eventId,
      message: removedFile ? '已删除本地日历文件' : '任务没有有效时间，本地日历无需删除',
    })
  }

  try {
    const idsBeforeDelete = await findLocalCalendarEventId(task, eventId)
    if (!idsBeforeDelete) {
      await writeLog('info', 'Task local calendar event already missing', { taskId: task.id, title: task.title, filePath })
      return buildCalendarDeleteResult(previous, {
        status: 'deleted',
        filePath,
        eventId,
        message: removedFile ? '已删除本地日历文件；系统日历事件已不存在' : '系统日历事件已不存在',
      })
    }

    const deleteScript = [
      `set targetEventId to ${toAppleScriptString(idsBeforeDelete)}`,
      'set deletedCount to 0',
      'tell application "Calendar"',
      'repeat with cal in calendars',
      'try',
      'set matchedEvents to (events of cal whose uid is targetEventId)',
      'repeat with calendarEvent in matchedEvents',
      'delete calendarEvent',
      'set deletedCount to deletedCount + 1',
      'end repeat',
      'end try',
      'end repeat',
      'end tell',
      'return deletedCount',
    ]
    const { stdout } = await runAppleScript(deleteScript)
    const deletedCount = Number.parseInt(stdout, 10) || 0
    await writeLog('info', 'Task removed from local calendar', {
      taskId: task.id,
      title: task.title,
      eventId: idsBeforeDelete,
      deletedCount,
      filePath,
    })
    return buildCalendarDeleteResult(previous, {
      status: 'deleted',
      filePath,
      eventId: idsBeforeDelete,
      message: deletedCount > 0 ? '已删除本地日历事件' : '系统日历事件已不存在',
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : '删除本地日历失败'
    await writeLog('warn', 'Task local calendar delete failed', { taskId: task.id, title: task.title, eventId, filePath, message })
    return buildCalendarDeleteResult(previous, {
      status: 'failed',
      filePath,
      eventId,
      message,
    })
  }
}

function isAlreadyDeletedLarkError(message) {
  return /not\s*found|404|不存在|已删除|not_found/i.test(String(message || ''))
}

async function deleteTaskFromLarkCalendar(task, settings) {
  const previous = task.calendarSync?.lark || null
  const eventId = previous?.eventId || ''
  const calendarId = String(previous?.calendarId || settings.larkCalendarId || 'primary').trim() || 'primary'
  const hasSyncedLarkEvent = previous?.status === 'ok' || Boolean(eventId)

  if (!hasSyncedLarkEvent) {
    return buildCalendarDeleteResult(previous, {
      status: 'skipped',
      calendarId,
      eventId,
      message: '飞书日历未同步，无需删除',
    })
  }

  if (!eventId) {
    const message = '缺少飞书 event_id，无法确认删除目标'
    await writeLog('warn', 'Task Lark calendar delete skipped without event id', { taskId: task.id, title: task.title, calendarId })
    return buildCalendarDeleteResult(previous, {
      status: 'failed',
      calendarId,
      message,
    })
  }

  const cliPath = existsSync('/opt/homebrew/bin/lark-cli') ? '/opt/homebrew/bin/lark-cli' : 'lark-cli'
  try {
    const { stdout } = await runCommand(cliPath, [
      'calendar',
      'events',
      'delete',
      '--as',
      'user',
      '--params',
      JSON.stringify({
        calendar_id: calendarId,
        event_id: eventId,
        need_notification: 'false',
      }),
      '--format',
      'json',
    ])
    const body = stdout ? JSON.parse(stdout) : {}
    if (body?.ok === false) {
      throw new Error(body.error?.message || body.message || 'lark-cli 返回删除失败')
    }
    await writeLog('info', 'Task removed from Lark calendar', { taskId: task.id, title: task.title, calendarId, eventId })
    return buildCalendarDeleteResult(previous, {
      status: 'deleted',
      calendarId,
      eventId,
      message: '已删除飞书日历事件',
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : '删除飞书日历失败'
    if (isAlreadyDeletedLarkError(message)) {
      await writeLog('info', 'Task Lark calendar event already missing', { taskId: task.id, title: task.title, calendarId, eventId, message })
      return buildCalendarDeleteResult(previous, {
        status: 'deleted',
        calendarId,
        eventId,
        message: '飞书日历事件已不存在',
      })
    }
    await writeLog('warn', 'Task Lark calendar delete failed', { taskId: task.id, title: task.title, calendarId, eventId, message })
    return buildCalendarDeleteResult(previous, {
      status: 'failed',
      calendarId,
      eventId,
      message,
    })
  }
}

function shouldDeleteCalendarTarget(syncTarget) {
  return Boolean(syncTarget && (syncTarget.status === 'ok' || syncTarget.eventId || syncTarget.filePath))
}

async function deleteTaskCalendars(task, settings) {
  const calendarSync = task.calendarSync || {}
  const nextSync = { ...calendarSync }
  const failures = []

  // 飞书有稳定 event_id，先删飞书；失败时阻断本地删除，尽量避免出现 Todo Desk 没删成但外部日历已被部分改动。
  if (shouldDeleteCalendarTarget(calendarSync.lark)) {
    nextSync.lark = await deleteTaskFromLarkCalendar(task, settings)
    if (nextSync.lark.status === 'failed') failures.push(`飞书日历：${nextSync.lark.message || '删除失败'}`)
  }

  if (!failures.length && shouldDeleteCalendarTarget(calendarSync.local)) {
    nextSync.local = await deleteTaskFromLocalCalendar(task)
    if (nextSync.local.status === 'failed') failures.push(`本地日历：${nextSync.local.message || '删除失败'}`)
  }

  if (failures.length) {
    throw new Error(`删除任务前未能完成日历强同步：${failures.join('；')}`)
  }

  return nextSync
}

async function syncDeletedTasksFromCalendars(data, previousData) {
  if (!previousData?.tasks?.length) return data

  const settings = data.settings || getDefaultData().settings
  const nextTaskIds = new Set((data.tasks || []).map((task) => task.id))
  const removedTasks = (previousData.tasks || []).filter((task) => !nextTaskIds.has(task.id))
  if (!removedTasks.length) return data

  const deletedSyncByTaskId = new Map()
  for (const task of removedTasks) {
    const hasCalendarSync = shouldDeleteCalendarTarget(task.calendarSync?.local) || shouldDeleteCalendarTarget(task.calendarSync?.lark)
    if (!hasCalendarSync) continue
    const nextSync = await deleteTaskCalendars(task, settings)
    deletedSyncByTaskId.set(task.id, nextSync)
  }

  if (!deletedSyncByTaskId.size) return data
  return {
    ...data,
    trash: (data.trash || []).map((task) => {
      const deletedSync = deletedSyncByTaskId.get(task.id)
      return deletedSync ? { ...task, calendarSync: deletedSync } : task
    }),
  }
}

async function syncTaskToLocalCalendar(task, signature) {
  try {
    const previousEventId = task.calendarSync?.local?.eventId || ''
    const existingEventId = await findLocalCalendarEventId(task, previousEventId)
    const { stdout } = await runAppleScript(buildLocalCalendarUpsertScript(task, existingEventId || previousEventId))
    const eventId = stdout.trim()
    await writeLog('info', 'Task auto synced to local calendar', { taskId: task.id, title: task.title, eventId })
    return buildCalendarSyncResult(signature, {
      status: 'ok',
      eventId,
      message: existingEventId ? '已更新系统日历' : '已加入系统日历',
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : '加入系统日历失败'
    await writeLog('warn', 'Task local calendar sync failed', { taskId: task.id, title: task.title, message })
    return buildCalendarSyncResult(signature, {
      status: 'failed',
      message,
    })
  }
}

function buildLarkCalendarPayload(task) {
  const eventAt = getTaskEventAt(task)
  const start = new Date(eventAt)
  if (Number.isNaN(start.getTime())) {
    throw new Error('任务提醒时间无效')
  }
  const end = new Date(start.getTime() + 30 * 60_000)
  return {
    summary: `${task.title || '任务提醒'} · Todo Desk`,
    description: buildTaskCalendarDescription(task),
    start_time: {
      timestamp: String(Math.floor(start.getTime() / 1000)),
      timezone: 'Asia/Shanghai',
    },
    end_time: {
      timestamp: String(Math.floor(end.getTime() / 1000)),
      timezone: 'Asia/Shanghai',
    },
    reminders: [
      {
        minutes: task.reminderAt ? 0 : 10,
      },
    ],
    free_busy_status: 'free',
    visibility: 'private',
    vchat: {
      vc_type: 'no_meeting',
    },
  }
}

async function syncTaskToLarkCalendar(task, settings, signature) {
  const cliPath = existsSync('/opt/homebrew/bin/lark-cli') ? '/opt/homebrew/bin/lark-cli' : 'lark-cli'
  const calendarId = String(settings.larkCalendarId || 'primary').trim() || 'primary'
  const idempotencyKey = `todo-desk-${hashCalendarSyncValue(`${task.id}:${signature}`)}`
  const params = {
    calendar_id: calendarId,
    idempotency_key: idempotencyKey,
  }
  const payload = buildLarkCalendarPayload(task)

  try {
    const { stdout } = await runCommand(cliPath, [
      'calendar',
      'events',
      'create',
      '--as',
      'user',
      '--params',
      JSON.stringify(params),
      '--data',
      JSON.stringify(payload),
      '--format',
      'json',
    ])
    const body = stdout ? JSON.parse(stdout) : {}
    if (body?.ok === false) {
      throw new Error(body.error?.message || body.message || 'lark-cli 返回同步失败')
    }
    const event = body?.data?.event || body?.event || body?.data || {}
    await writeLog('info', 'Task auto synced to Lark calendar', {
      taskId: task.id,
      title: task.title,
      calendarId,
      eventId: event.event_id || '',
    })
    return buildCalendarSyncResult(signature, {
      status: 'ok',
      calendarId,
      eventId: event.event_id || '',
      appLink: event.app_link || '',
      message: '已同步飞书日历',
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : '同步飞书日历失败'
    await writeLog('warn', 'Task Lark calendar sync failed', { taskId: task.id, title: task.title, calendarId, message })
    return buildCalendarSyncResult(signature, {
      status: 'failed',
      calendarId,
      message,
    })
  }
}

async function syncTaskCalendars(task, settings) {
  const eventAt = getTaskEventAt(task)
  if (!eventAt) return task
  if (Number.isNaN(new Date(eventAt).getTime())) return task

  const nextSync = { ...(task.calendarSync || {}) }
  if (settings.calendarSyncEnabled !== false) {
    const localSignature = buildTaskCalendarSignature(task, 'local', settings)
    if (shouldAttemptCalendarTarget(nextSync.local, localSignature)) {
      nextSync.local = await syncTaskToLocalCalendar(task, localSignature)
    }
  }

  if (settings.larkCalendarSync !== false) {
    const larkSignature = buildTaskCalendarSignature(task, 'lark', settings)
    if (shouldAttemptCalendarTarget(nextSync.lark, larkSignature)) {
      nextSync.lark = await syncTaskToLarkCalendar(task, settings, larkSignature)
    }
  }

  return {
    ...task,
    calendarSync: nextSync,
  }
}

function taskCalendarComparableSignature(task) {
  return JSON.stringify({
    title: task.title,
    detail: task.detail,
    project: task.project,
    tags: task.tags || [],
    dueAt: task.dueAt || '',
    reminderAt: task.reminderAt || '',
    updatedAt: task.updatedAt || '',
  })
}

function shouldConsiderTaskForCalendarSync(task, previousTask) {
  if (!previousTask) return true
  if (task.calendarSync?.local || task.calendarSync?.lark) return true
  return taskCalendarComparableSignature(task) !== taskCalendarComparableSignature(previousTask)
}

async function syncTimedTasksToCalendars(data, previousData) {
  const settings = data.settings || getDefaultData().settings
  const previousTasks = new Map((previousData?.tasks || []).map((task) => [task.id, task]))
  const tasks = []
  for (const task of data.tasks || []) {
    if (!shouldConsiderTaskForCalendarSync(task, previousTasks.get(task.id))) {
      tasks.push(task)
      continue
    }
    tasks.push(await syncTaskCalendars(task, settings))
  }
  return {
    ...data,
    tasks,
  }
}

async function readData() {
  await ensureStorage()
  const data = await readJson(getPaths().dataFile)
  return {
    ...getDefaultData(),
    ...data,
    settings: {
      ...getDefaultData().settings,
      ...data.settings,
      columnSorts: {
        ...getDefaultData().settings.columnSorts,
        ...data.settings?.columnSorts,
      },
    },
    tasks: Array.isArray(data.tasks) ? data.tasks.map((task) => normalizeTaskOrigin(task)) : [],
    trash: Array.isArray(data.trash) ? data.trash.map((task) => normalizeTaskOrigin(task)) : [],
    syncLog: Array.isArray(data.syncLog) ? data.syncLog : [],
  }
}

async function saveData(nextData) {
  const normalized = {
    ...nextData,
    version: appDataVersion,
    settings: {
      ...getDefaultData().settings,
      ...nextData.settings,
      columnSorts: {
        ...getDefaultData().settings.columnSorts,
        ...nextData.settings?.columnSorts,
      },
    },
    tasks: Array.isArray(nextData.tasks) ? nextData.tasks.map((task) => normalizeTaskOrigin(task)) : [],
    trash: Array.isArray(nextData.trash) ? nextData.trash.map((task) => normalizeTaskOrigin(task)) : [],
  }
  await ensureStorage()
  const previousData = existsSync(getPaths().dataFile) ? await readJson(getPaths().dataFile) : null
  const withDeletedCalendarSync = await syncDeletedTasksFromCalendars(normalized, previousData)
  const withCalendarSync = await syncTimedTasksToCalendars(withDeletedCalendarSync, previousData)
  await writeJson(getPaths().dataFile, withCalendarSync)
  return withCalendarSync
}

async function saveAttachmentBuffer(buffer, originalName, extension = '.png') {
  await ensureStorage()
  const safeExt = extension.startsWith('.') ? extension : `.${extension}`
  const safeName = `${Date.now()}-${crypto.randomUUID()}${safeExt}`
  const destination = join(getPaths().attachmentDir, safeName)
  await writeFile(destination, buffer)
  return {
    name: originalName,
    path: destination,
    url: `file://${destination}`,
  }
}

function sendJson(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': 'http://127.0.0.1',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  })
  response.end(payload)
}

function readRequestJson(request) {
  return new Promise((resolve, reject) => {
    let raw = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 64_000) {
        reject(new Error('Request body is too large'))
        request.destroy()
      }
    })
    request.on('end', () => {
      if (!raw.trim()) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('Request body must be valid JSON'))
      }
    })
    request.on('error', reject)
  })
}

function normalizeExternalTask(input) {
  const now = new Date().toISOString()
  const status = taskStatuses.has(input.status) ? input.status : 'doing'
  const priority = ['low', 'medium', 'high'].includes(input.priority) ? input.priority : 'medium'
  const explicitOrigin = normalizeExplicitOrigin(input.origin)
  const source = normalizeString(input.source || 'api')
  const agent = normalizeString(input.agent || input.agentName || explicitOrigin?.agent?.name)
  const agentSessionId = normalizeString(input.agentSessionId || input.sessionId || input.session || explicitOrigin?.agent?.sessionId)
  const repository = normalizeString(input.repository || input.repo || explicitOrigin?.repository?.name)
  const repositoryPath = normalizeString(input.repositoryPath || input.repoPath || explicitOrigin?.repository?.path)
  const tags = Array.isArray(input.tags)
    ? input.tags.map((tag) => String(tag).trim()).filter(Boolean)
    : typeof input.tags === 'string'
      ? input.tags
          .split(/[,\s，、]+/)
          .map((tag) => tag.trim())
          .filter(Boolean)
      : []
  const rawImages = Array.isArray(input.imagePaths) ? input.imagePaths : Array.isArray(input.images) ? input.images : []
  const imagePaths = rawImages
    .map((image) => {
      if (typeof image === 'string') {
        return {
          name: basename(image),
          path: image,
          url: image.startsWith('file://') ? image : `file://${image}`,
        }
      }
      if (!image?.path) return null
      return {
        name: String(image.name || basename(image.path)),
        path: String(image.path),
        url: String(image.url || `file://${image.path}`),
      }
    })
    .filter(Boolean)

  const task = {
    id: crypto.randomUUID(),
    title: String(input.title || input.summary || 'AI 当前工作').trim(),
    detail: String(input.detail || input.description || '').trim(),
    status,
    priority,
    project: String(input.project || input.group || 'AI 工作').trim(),
    tags,
    dueAt: input.dueAt ? new Date(input.dueAt).toISOString() : '',
    reminderAt: input.reminderAt ? new Date(input.reminderAt).toISOString() : '',
    imagePaths,
    createdAt: now,
    updatedAt: now,
    completedAt: status === 'done' ? now : '',
    completionAcceptance: normalizeCompletionAcceptance(input.completionAcceptance),
    sessionReview: normalizeSessionReview(input.sessionReview),
    source,
    agent,
    agentSessionId,
    repository,
    repositoryPath,
  }
  const normalized = normalizeTaskOrigin({ ...task, origin: explicitOrigin || input.origin }, 'explicit')
  const sessionReviewPatch = applySessionReview(normalized, input, now)
  const withSessionReview = sessionReviewPatch ? normalizeTaskOrigin({ ...normalized, ...sessionReviewPatch }, 'explicit') : normalized
  const decisionPatch = applyCompletionDecision(withSessionReview, input, now)
  if (decisionPatch) return normalizeTaskOrigin({ ...withSessionReview, ...decisionPatch }, 'explicit')
  const gatePatch = gateAgentCompletion(withSessionReview, input, now)
  return normalizeTaskOrigin(gatePatch ? { ...withSessionReview, ...gatePatch } : withSessionReview, 'explicit')
}

function normalizeTaskPatch(input, currentTask) {
  const now = new Date().toISOString()
  const patch = {
    updatedAt: now,
  }
  if (typeof input.title === 'string') patch.title = input.title.trim()
  if (typeof input.detail === 'string') patch.detail = input.detail.trim()
  if (typeof input.description === 'string') patch.detail = input.description.trim()
  if (typeof input.project === 'string') patch.project = input.project.trim()
  if (['low', 'medium', 'high'].includes(input.priority)) patch.priority = input.priority
  if (taskStatuses.has(input.status)) {
    patch.status = input.status
    patch.completedAt = input.status === 'done' ? currentTask.completedAt || now : ''
  }
  if (input.completionAcceptance && typeof input.completionAcceptance === 'object') {
    patch.completionAcceptance = normalizeCompletionAcceptance(input.completionAcceptance)
  }
  if (input.sessionReview && typeof input.sessionReview === 'object') {
    patch.sessionReview = normalizeSessionReview(input.sessionReview)
  }
  if (Array.isArray(input.tags)) patch.tags = input.tags.map((tag) => String(tag).trim()).filter(Boolean)
  if (typeof input.tags === 'string') patch.tags = input.tags.split(/[,\s，、]+/).map((tag) => tag.trim()).filter(Boolean)
  if (Object.prototype.hasOwnProperty.call(input, 'dueAt')) patch.dueAt = input.dueAt ? new Date(input.dueAt).toISOString() : ''
  if (Object.prototype.hasOwnProperty.call(input, 'reminderAt')) patch.reminderAt = input.reminderAt ? new Date(input.reminderAt).toISOString() : ''
  if (typeof input.source === 'string') patch.source = input.source.trim()
  if (typeof input.agent === 'string' || typeof input.agentName === 'string') patch.agent = String(input.agent || input.agentName).trim()
  if (typeof input.agentSessionId === 'string' || typeof input.sessionId === 'string' || typeof input.session === 'string') {
    patch.agentSessionId = String(input.agentSessionId || input.sessionId || input.session).trim()
  }
  if (typeof input.repository === 'string' || typeof input.repo === 'string') patch.repository = String(input.repository || input.repo).trim()
  if (typeof input.repositoryPath === 'string' || typeof input.repoPath === 'string') patch.repositoryPath = String(input.repositoryPath || input.repoPath).trim()
  if (typeof input.appendDetail === 'string' && input.appendDetail.trim()) {
    patch.detail = [currentTask.detail, input.appendDetail.trim()].filter(Boolean).join('\n\n')
  }
  if (patch.status === 'pending_acceptance') {
    const taskForAcceptance = normalizeTaskOrigin({ ...currentTask, ...patch }, 'explicit')
    patch.completionAcceptance = ensureCompletionAcceptance(taskForAcceptance, now)
    patch.sessionReview = undefined
  }
  const candidate = normalizeTaskOrigin({ ...currentTask, ...patch }, 'explicit')
  const sessionReviewPatch = applySessionReview(candidate, input, now)
  const withSessionReview = sessionReviewPatch ? normalizeTaskOrigin({ ...candidate, ...sessionReviewPatch }, 'explicit') : candidate
  const decisionPatch = applyCompletionDecision(withSessionReview, input, now)
  if (decisionPatch) return { ...patch, ...sessionReviewPatch, ...decisionPatch }
  const gatePatch = gateAgentCompletion(withSessionReview, input, now)
  return gatePatch ? { ...patch, ...sessionReviewPatch, ...gatePatch } : { ...patch, ...sessionReviewPatch }
}

async function addTasksFromApi(input) {
  const rawTasks = Array.isArray(input?.tasks) ? input.tasks : [input]
  const tasks = rawTasks.map((item) => normalizeExternalTask(item))
  if (tasks.some((task) => !task.title)) {
    throw new Error('title is required')
  }

  const data = await readData()
  const nextData = await saveData({
    ...data,
    tasks: [...tasks, ...data.tasks],
  })

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('data:updated', nextData)
  }

  return { task: tasks[0], tasks, data: nextData }
}

async function updateTaskFromApi(taskId, input) {
  const data = await readData()
  const task = data.tasks.find((item) => item.id === taskId)
  if (!task) throw new Error('task not found')

  const patch = normalizeTaskPatch(input, task)
  const nextTask = { ...task, ...patch }
  const nextData = await saveData({
    ...data,
    tasks: data.tasks.map((item) => (item.id === taskId ? nextTask : item)),
  })

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('data:updated', nextData)
  }

  return { task: nextTask, data: nextData }
}

function isLoopbackRequest(request) {
  const address = request.socket.remoteAddress
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

async function handleApiRequest(request, response) {
  if (!isLoopbackRequest(request)) {
    sendJson(response, 403, { ok: false, error: 'Only loopback requests are allowed' })
    return
  }

  if (request.method === 'OPTIONS') {
    sendJson(response, 204, {})
    return
  }

  const url = new URL(request.url || '/', `http://127.0.0.1:${apiPort || 47731}`)

  try {
    if (request.method === 'GET' && url.pathname === '/health') {
      const data = await readData()
      sendJson(response, 200, {
        ok: true,
        app: 'Todo Desk',
        apiPort,
        taskCount: data.tasks.length,
      })
      return
    }

    if (request.method === 'GET' && url.pathname === '/tasks') {
      const data = await readData()
      sendJson(response, 200, {
        ok: true,
        tasks: data.tasks,
      })
      return
    }

    if (request.method === 'POST' && url.pathname === '/tasks') {
      const body = await readRequestJson(request)
      const result = await addTasksFromApi(body)
      sendJson(response, 201, {
        ok: true,
        task: result.task,
        tasks: result.tasks,
      })
      return
    }

    const taskPatchMatch = url.pathname.match(/^\/tasks\/([^/]+)$/)
    if (request.method === 'PATCH' && taskPatchMatch) {
      const body = await readRequestJson(request)
      const result = await updateTaskFromApi(decodeURIComponent(taskPatchMatch[1]), body)
      sendJson(response, 200, {
        ok: true,
        task: result.task,
      })
      return
    }

    sendJson(response, 404, { ok: false, error: 'Not found' })
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : 'Bad request',
    })
  }
}

async function stopApiServer() {
  if (!apiServer) return
  await new Promise((resolve) => apiServer.close(resolve))
  apiServer = null
  apiPort = null
}

async function startApiServer(settings) {
  await stopApiServer()
  if (!settings.apiEnabled) return

  const port = Number(settings.apiPort) || 47731
  apiServer = http.createServer((request, response) => {
    handleApiRequest(request, response)
  })
  try {
    await new Promise((resolve, reject) => {
      const handleError = (error) => {
        apiServer = null
        apiPort = null
        reject(error)
      }
      apiServer.once('error', handleError)
      apiServer.listen(port, '127.0.0.1', () => {
        apiServer.off('error', handleError)
        apiServer.on('error', (error) => {
          console.error('Todo Desk API server error:', error)
        })
        apiPort = port
        resolve()
      })
    })
    await writeLog('info', 'Todo Desk API server started', { port })
  } catch (error) {
    await writeLog('error', 'Todo Desk API server failed to start', {
      port,
      error: error instanceof Error ? error.message : 'unknown error',
    })
  }
}

function formatDateTime(value) {
  if (!value) return ''
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

async function openTaskInCalendar(task) {
  const previousEventId = task.calendarSync?.local?.eventId || ''
  const existingEventId = await findLocalCalendarEventId(task, previousEventId)
  const { stdout } = await runAppleScript(buildLocalCalendarUpsertScript(task, existingEventId || previousEventId))
  const eventId = stdout.trim()
  await runAppleScript(['tell application "Calendar" to activate'])
  await writeLog('info', 'Task calendar event opened', { taskId: task.id, title: task.title, eventId })
  return { ok: true, eventId, message: existingEventId ? '已更新系统日历' : '已写入系统日历' }
}

function buildAgentSessionUrl(task) {
  const agent = String(task?.origin?.agent?.name || task?.origin?.agent?.tool || task?.agent || task?.source || '').trim().toLowerCase()
  const sessionId = String(task?.origin?.agent?.sessionId || task?.agentSessionId || '').trim()
  if (!sessionId) {
    throw new Error('这个任务没有关联 agent session')
  }
  if (!agent.includes('codex')) {
    throw new Error(`暂只支持跳转 Codex session：${task?.agent || task?.source || '未知 agent'}`)
  }
  if (!codexThreadIdPattern.test(sessionId)) {
    throw new Error('Codex session id 格式不正确，无法跳转')
  }
  return `codex://threads/${sessionId}`
}

function formatTaskLine(task) {
  const tags = task.tags?.length ? ` #${task.tags.join(' #')}` : ''
  const due = task.dueAt ? ` 截止:${formatDateTime(task.dueAt)}` : ''
  const project = task.project ? ` [${task.project}]` : ''
  return `- ${task.title}${project}${due}${tags}`
}

async function requestAiEndpoint(url, payload, settings, context = 'AI 请求') {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), aiRequestTimeoutMs)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(settings.aiApiKey ? { Authorization: `Bearer ${settings.aiApiKey}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    clearTimeout(timeout)
    return {
      response,
      rawBody: await response.text(),
      contentType: response.headers.get('content-type') || '',
    }
  } catch (error) {
    clearTimeout(timeout)
    const message = error?.name === 'AbortError' ? `请求超过 ${Math.round(aiRequestTimeoutMs / 1000)} 秒未返回` : error instanceof Error ? error.message : 'AI 网络请求失败'
    await writeLog('error', `${context} failed before response`, safeAiMeta(settings, { endpoint: url, error: message }))
    throw new Error(`AI 网络请求失败：${message}`)
  }
}

async function callAiTaskParser(text, settings, images = []) {
  await writeLog('info', 'AI parse request started', safeAiMeta(settings, { inputLength: text.length, imageCount: images.length }))

  const requestEndpoint = (url, payload) => requestAiEndpoint(url, payload, settings, 'AI parse request')

  let result
  try {
    result = await parseTasksWithAiAndImages(text, settings, requestEndpoint, { images })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await writeLog(
      'error',
      'AI parse request failed',
      safeAiMeta(settings, {
        inputLength: text.length,
        imageCount: images.length,
        error: message,
      }),
    )
    throw error
  }
  if (result.usedFallback) {
    await writeLog(
      'warn',
      'AI parse response used /v1 fallback endpoint',
      safeAiMeta(settings, {
        endpoint: result.endpoint,
      }),
    )
  }
  await writeLog(
    'info',
    'AI parse request succeeded',
    safeAiMeta(settings, {
      taskCount: result.tasks?.length ?? 0,
      title: result.task?.title ?? '',
      imageMode: result.imageMode,
      imageCount: result.imageCount,
      ocrErrors: result.ocrErrors,
    }),
  )
  return result
}

async function callAiTaskMerger(tasks, settings) {
  if (!settings.aiEnabled) {
    return { ok: false, skipped: true, message: 'AI 未启用' }
  }
  if (!settings.aiBaseUrl || !settings.aiModel) {
    return { ok: false, skipped: true, message: 'AI Base URL 或 Model 未配置' }
  }

  const payload = buildAiMergeRequestPayload(tasks, settings)
  let endpoint = buildAiEndpoint(settings.aiBaseUrl)
  await writeLog('info', 'AI merge request started', safeAiMeta(settings, { taskCount: tasks.length }))

  let { response, rawBody, contentType } = await requestAiEndpoint(endpoint, payload, settings, 'AI merge request')
  if ((response.ok && looksLikeHtml(rawBody, contentType)) || (!response.ok && response.status === 404)) {
    const fallbackEndpoint = buildAiFallbackEndpoint(settings.aiBaseUrl)
    if (fallbackEndpoint) {
      await writeLog('warn', 'AI merge response used /v1 fallback endpoint', safeAiMeta(settings, { endpoint: fallbackEndpoint, originalStatus: response.status }))
      endpoint = fallbackEndpoint
      ;({ response, rawBody, contentType } = await requestAiEndpoint(endpoint, payload, settings, 'AI merge fallback request'))
    }
  }
  if (!response.ok) {
    await writeLog('error', 'AI merge request failed', safeAiMeta(settings, { endpoint, status: response.status, body: clipText(rawBody, 400) }))
    throw new Error(`AI 请求失败 ${response.status} ${response.statusText || ''}：${clipText(rawBody, 180)}`)
  }
  if (looksLikeHtml(rawBody, contentType)) {
    await writeLog('error', 'AI merge response was html', safeAiMeta(settings, { endpoint, contentType, body: clipText(rawBody, 400) }))
    throw new Error(`AI 返回的不是 JSON，可能 Base URL 填错或被重定向：${clipText(rawBody, 180)}`)
  }

  const body = JSON.parse(rawBody)
  const content = body?.choices?.[0]?.message?.content ?? body?.choices?.[0]?.text ?? body
  const merged = normalizeMergedTask(content, tasks)

  await writeLog('info', 'AI merge request succeeded', safeAiMeta(settings, { title: merged.title, taskCount: tasks.length }))
  return { ok: true, task: merged }
}

async function callAiConnectivityTest(settings) {
  if (!settings.aiBaseUrl || !settings.aiModel) {
    return { ok: false, skipped: true, message: 'AI Base URL 或 Model 未配置' }
  }

  const payload = {
    model: settings.aiModel,
    messages: [
      { role: 'system', content: 'You are a connectivity tester. Reply with OK only.' },
      { role: 'user', content: 'ping' },
    ],
    temperature: 0,
    max_tokens: 8,
  }
  let endpoint = buildAiEndpoint(settings.aiBaseUrl)
  await writeLog('info', 'AI connectivity test started', safeAiMeta(settings))

  let { response, rawBody, contentType } = await requestAiEndpoint(endpoint, payload, settings, 'AI connectivity test')
  if ((response.ok && looksLikeHtml(rawBody, contentType)) || (!response.ok && response.status === 404)) {
    const fallbackEndpoint = buildAiFallbackEndpoint(settings.aiBaseUrl)
    if (fallbackEndpoint) {
      await writeLog('warn', 'AI connectivity test used /v1 fallback endpoint', safeAiMeta(settings, { endpoint: fallbackEndpoint, originalStatus: response.status }))
      endpoint = fallbackEndpoint
      ;({ response, rawBody, contentType } = await requestAiEndpoint(endpoint, payload, settings, 'AI connectivity fallback test'))
    }
  }
  if (!response.ok) {
    await writeLog('error', 'AI connectivity test failed', safeAiMeta(settings, { endpoint, status: response.status, body: clipText(rawBody, 400) }))
    return { ok: false, message: `AI 连通性测试失败 ${response.status} ${response.statusText || ''}：${clipText(rawBody, 180)}` }
  }
  if (looksLikeHtml(rawBody, contentType)) {
    await writeLog('error', 'AI connectivity test returned html', safeAiMeta(settings, { endpoint, contentType, body: clipText(rawBody, 400) }))
    return { ok: false, message: `AI 返回的不是 JSON，可能 Base URL 填错或被重定向：${clipText(rawBody, 180)}` }
  }

  // A 200 response alone is not enough: HTML gateways and malformed proxies can still return OK.
  // Parsing the Chat Completions shape catches wrong endpoints while keeping the request lightweight.
  try {
    const body = JSON.parse(rawBody)
    const content = body?.choices?.[0]?.message?.content ?? body?.choices?.[0]?.text ?? ''
    if (!body?.choices?.length) {
      return { ok: false, message: `AI 返回 JSON 但不是 Chat Completions 格式：${clipText(rawBody, 180)}` }
    }
    await writeLog('info', 'AI connectivity test succeeded', safeAiMeta(settings, { endpoint, reply: clipText(content, 80) }))
    return {
      ok: true,
      endpoint,
      message: `连接成功：${settings.aiModel}`,
    }
  } catch (error) {
    await writeLog('error', 'AI connectivity test returned invalid json', safeAiMeta(settings, { endpoint, body: clipText(rawBody, 400) }))
    return { ok: false, message: error instanceof Error ? `AI 返回 JSON 解析失败：${error.message}` : 'AI 返回 JSON 解析失败' }
  }
}

function buildLarkMarkdown(data, completedTask) {
  const doing = data.tasks.filter((task) => task.status === 'doing' || task.status === 'pending_acceptance')
  const todo = data.tasks.filter((task) => task.status === 'todo')
  const done = data.tasks
    .filter((task) => task.status === 'done')
    .sort((left, right) => String(right.completedAt).localeCompare(String(left.completedAt)))
    .slice(0, 20)

  const lines = [
    '',
    `## Todo Desk 同步 ${new Date().toLocaleString('zh-CN')}`,
    '',
    `刚完成：${completedTask?.title ?? '手动同步'}`,
    '',
    '### 当前正在做',
    ...(doing.length ? doing.map(formatTaskLine) : ['- 无']),
    '',
    '### 未完成 Todo',
    ...(todo.length ? todo.map(formatTaskLine) : ['- 无']),
    '',
    '### 已完成',
    ...(done.length ? done.map(formatTaskLine) : ['- 无']),
  ]

  return lines.join('\n')
}

function runLarkUpdate(doc, markdown) {
  return new Promise((resolve, reject) => {
    const cliPath = existsSync('/opt/homebrew/bin/lark-cli') ? '/opt/homebrew/bin/lark-cli' : 'lark-cli'
    const child = spawn(cliPath, ['docs', '+update', '--doc', doc, '--mode', 'append', '--markdown', markdown], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() })
        return
      }
      reject(new Error(stderr.trim() || stdout.trim() || `lark-cli exited with code ${code}`))
    })
  })
}

function setDockState(docked, edge = '') {
  isDocked = docked
  currentDockEdge = docked ? edge : ''
  if (!docked) {
    dockDragStartBounds = null
    setDockPassthrough(false)
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setBackgroundColor(docked ? transparentWindowBackground : normalWindowBackground)
    mainWindow.setHasShadow?.(!docked)
    updateWindowButtonVisibility(mainWindow)
    mainWindow.webContents.send('dock:changed', { docked, edge })
  }
}

function setDockPassthrough(enabled) {
  if (!mainWindow || mainWindow.isDestroyed() || dockPassthrough === enabled) return
  dockPassthrough = enabled
  mainWindow.setIgnoreMouseEvents(Boolean(enabled), enabled ? { forward: true } : undefined)
}

function updateWindowButtonVisibility(window) {
  if (process.platform !== 'darwin' || !window || window.isDestroyed()) return
  window.setWindowButtonVisibility(!isDocked)
}

function setWindowBounds(window, bounds, animate = true) {
  const current = window.getBounds()
  if (
    current.x === bounds.x
    && current.y === bounds.y
    && current.width === bounds.width
    && current.height === bounds.height
  ) {
    return
  }
  suppressMoveHandlingUntil = Date.now() + 350
  window.setBounds(bounds, animate)
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function easeOutCubic(progress) {
  return 1 - ((1 - progress) ** 3)
}

function setWindowOpacity(window, opacity) {
  if (!window || window.isDestroyed()) return
  window.setOpacity?.(Math.min(1, Math.max(0, opacity)))
}

async function fadeWindowOpacity(window, from, to, durationMs) {
  if (!window || window.isDestroyed() || durationMs <= 0) {
    setWindowOpacity(window, to)
    return
  }

  const startedAt = Date.now()
  while (!window.isDestroyed()) {
    const progress = Math.min(1, (Date.now() - startedAt) / durationMs)
    const eased = easeOutCubic(progress)
    setWindowOpacity(window, from + ((to - from) * eased))
    if (progress >= 1) return
    await wait(16)
  }
}

function clampBoundsToWorkArea(bounds, area) {
  const width = Math.min(bounds.width, area.width)
  const height = Math.min(bounds.height, area.height)
  return {
    ...bounds,
    width,
    height,
    x: Math.min(Math.max(bounds.x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - height),
  }
}

async function dockWindowToEdge(window, edge, area) {
  if (!window || window.isDestroyed() || isDocked || dockTransitioning) return
  dockTransitioning = true
  lastNormalBounds = window.getBounds()
  keepOnTopBeforeDock = window.isAlwaysOnTop()
  const width = Math.min(dockExpandedWidth, area.width)
  const height = Math.min(520, Math.max(360, area.height - 160))
  const y = area.y + Math.round((area.height - height) / 2)
  const x = edge === 'left' ? area.x : area.x + area.width - width
  const dockedBounds = { x, y, width, height }

  try {
    setDockPassthrough(false)
    window.setAlwaysOnTop(true, 'floating')
    await fadeWindowOpacity(window, 1, dockTransitionHiddenOpacity, dockTransitionFadeOutMs)
    if (window.isDestroyed()) return

    window.setMinimumSize(width, 260)
    window.setBackgroundColor(transparentWindowBackground)
    window.setHasShadow?.(false)
    dockDragStartBounds = dockedBounds
    setDockState(true, edge)
    // The large normal-to-dock resize looks rough with native animation; swap bounds while faded out, then fade in the dock UI.
    setWindowBounds(window, dockedBounds, false)
    await wait(24)
    await fadeWindowOpacity(window, dockTransitionHiddenOpacity, 1, dockTransitionFadeInMs)
    void writeLog('info', 'Dock transition completed', { edge, bounds: dockedBounds })
  } finally {
    setWindowOpacity(window, 1)
    dockTransitioning = false
  }
}

function setDockDetailOpen(open) {
  if (!mainWindow || mainWindow.isDestroyed() || !isDocked) return { ok: false }
  const current = mainWindow.getBounds()
  const display = screen.getDisplayMatching(current)
  const area = display.workArea
  const width = Math.min(dockExpandedWidth, area.width)
  const height = Math.min(current.height, area.height)
  const x = currentDockEdge === 'left' ? area.x : area.x + area.width - width
  const y = Math.min(Math.max(current.y, area.y), area.y + area.height - height)
  const nextBounds = { x, y, width, height }
  mainWindow.setMinimumSize(width, 260)
  dockDragStartBounds = nextBounds
  setWindowBounds(mainWindow, nextBounds, false)
  void writeLog('info', 'Dock detail window state changed', { open, edge: currentDockEdge, bounds: nextBounds })
  return { ok: true, bounds: nextBounds }
}

function restoreDockedWindow(anchorBounds = null) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const current = mainWindow.getBounds()
  const display = screen.getDisplayMatching(anchorBounds || current)
  const area = display.workArea
  const isMiniRestore = currentAppMode === 'mini'
  const fallbackWidth = isMiniRestore ? miniWindowWidth : 980
  const fallbackHeight = isMiniRestore ? miniWindowHeight : 900
  const restoreWidth = lastNormalBounds?.width || fallbackWidth
  const restoreHeight = lastNormalBounds?.height || fallbackHeight
  const anchoredX = anchorBounds
    ? currentDockEdge === 'right'
      ? anchorBounds.x + anchorBounds.width - restoreWidth
      : anchorBounds.x
    : current.x - (restoreWidth - current.width)
  const nextBounds = anchorBounds
    ? {
        x: anchoredX,
        y: anchorBounds.y,
        width: restoreWidth,
        height: restoreHeight,
      }
    : lastNormalBounds
    ? { ...lastNormalBounds }
    : { x: anchoredX, y: current.y, width: restoreWidth, height: restoreHeight }
  mainWindow.setMinimumSize(isMiniRestore ? miniWindowMinWidth : 760, isMiniRestore ? miniWindowMinHeight : 640)
  setWindowBounds(mainWindow, clampBoundsToWorkArea(nextBounds, area), true)
  mainWindow.setAlwaysOnTop(keepOnTopBeforeDock)
  setDockState(false)
}

function maybeRestoreDockedWindow(window, phase) {
  if (!window || window.isDestroyed() || !isDocked) return false
  if (Date.now() < suppressMoveHandlingUntil) return false

  const bounds = window.getBounds()
  const display = screen.getDisplayMatching(bounds)
  const area = display.workArea
  if (!dockDragStartBounds) {
    dockDragStartBounds = bounds
  }

  const horizontalDelta = Math.abs(bounds.x - dockDragStartBounds.x)
  const edgeDistance = currentDockEdge === 'left'
    ? bounds.x - area.x
    : area.x + area.width - (bounds.x + bounds.width)
  const hasDetachedFromEdge = edgeDistance > dockDetachThreshold
  const hasStartedManualDrag = horizontalDelta > 18 && edgeDistance > 8

  if (!hasDetachedFromEdge && !hasStartedManualDrag) {
    return false
  }

  void writeLog('info', 'Docked window detached from edge', {
    edge: currentDockEdge,
    edgeDistance,
    horizontalDelta,
    phase,
    bounds,
  })
  restoreDockedWindow(bounds)
  return true
}

function applyAppModeWindow(mode) {
  if (!mainWindow || mainWindow.isDestroyed() || isDocked) return
  const bounds = mainWindow.getBounds()
  const display = screen.getDisplayMatching(bounds)
  const area = display.workArea
  void writeLog('info', 'Applying app mode window bounds', { mode, currentBounds: bounds })

  if (mode === 'mini') {
    if (currentAppMode !== 'mini') {
      lastNormalModeBounds = bounds
    }
    const width = Math.min(miniWindowWidth, area.width)
    const height = Math.min(miniWindowHeight, area.height)
    mainWindow.setMinimumSize(miniWindowMinWidth, miniWindowMinHeight)
    setWindowBounds(
      mainWindow,
      {
        x: Math.min(Math.max(bounds.x, area.x), area.x + area.width - width),
        y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - height),
        width,
        height,
      },
      true,
    )
    currentAppMode = 'mini'
    void writeLog('info', 'Applied mini window bounds', { bounds: mainWindow.getBounds() })
    return
  }

  const nextBounds = lastNormalModeBounds || { ...bounds, width: 980, height: 900 }
  mainWindow.setMinimumSize(760, 640)
  setWindowBounds(
    mainWindow,
    {
      x: Math.min(Math.max(nextBounds.x ?? bounds.x, area.x), area.x + area.width - 760),
      y: Math.min(Math.max(nextBounds.y ?? bounds.y, area.y), area.y + area.height - 640),
      width: Math.max(980, nextBounds.width ?? 980),
      height: Math.max(760, nextBounds.height ?? 900),
    },
    true,
  )
  currentAppMode = 'normal'
  void writeLog('info', 'Applied normal window bounds', { bounds: mainWindow.getBounds() })
}

function snapWindowToEdge(window) {
  if (!window || window.isDestroyed()) return
  if (Date.now() < suppressMoveHandlingUntil) return
  const bounds = window.getBounds()
  const display = screen.getDisplayMatching(bounds)
  const area = display.workArea
  const threshold = 32
  const nextBounds = { ...bounds }
  let snapped = false

  if (isDocked) {
    maybeRestoreDockedWindow(window, 'moved')
    return
  }

  if (Math.abs(bounds.x - area.x) <= threshold) {
    void dockWindowToEdge(window, 'left', area)
    return
  }
  if (Math.abs(bounds.x + bounds.width - (area.x + area.width)) <= threshold) {
    void dockWindowToEdge(window, 'right', area)
    return
  }
  if (Math.abs(bounds.y - area.y) <= threshold) {
    nextBounds.y = area.y
    snapped = true
  }
  if (Math.abs(bounds.y + bounds.height - (area.y + area.height)) <= threshold) {
    nextBounds.y = area.y + area.height - bounds.height
    snapped = true
  }

  if (snapped) {
    setWindowBounds(window, nextBounds, true)
  }
}

async function createMainWindow() {
  await ensureStorage()
  let data = await readData()
  if (data.settings.edgeDocked) {
    data = await saveData({
      ...data,
      settings: {
        ...data.settings,
        edgeDocked: false,
      },
    })
  }
  await startApiServer(data.settings)
  currentAppMode = data.settings.appMode === 'mini' ? 'mini' : 'normal'
  mainWindow = new BrowserWindow({
    width: currentAppMode === 'mini' ? miniWindowWidth : 980,
    height: currentAppMode === 'mini' ? miniWindowHeight : 900,
    minWidth: currentAppMode === 'mini' ? miniWindowMinWidth : 760,
    minHeight: currentAppMode === 'mini' ? miniWindowMinHeight : 640,
    title: 'Todo Desk',
    transparent: true,
    backgroundColor: transparentWindowBackground,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    frame: process.platform !== 'darwin',
    alwaysOnTop: Boolean(data.settings.keepOnTop),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  updateWindowButtonVisibility(mainWindow)

  mainWindow.on('moved', async () => {
    const current = await readData()
    if (current.settings.snapToEdge) snapWindowToEdge(mainWindow)
  })
  mainWindow.on('move', () => {
    maybeRestoreDockedWindow(mainWindow, 'move')
  })

  if (isDev) {
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    await mainWindow.loadFile(join(__dirname, '../dist/index.html'))
  }
}

app.whenReady().then(createMainWindow)

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow()
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    stopApiServer()
    app.quit()
  }
})

ipcMain.handle('data:load', async () => readData())

ipcMain.handle('data:save', async (_event, data) => {
  const saved = await saveData(data)
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (isDocked) {
      mainWindow.setAlwaysOnTop(true, 'floating')
    } else {
      mainWindow.setAlwaysOnTop(Boolean(saved.settings.keepOnTop))
    }
  }
  await startApiServer(saved.settings)
  return saved
})

ipcMain.handle('attachment:import', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择附加图片',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] },
    ],
  })

  if (result.canceled) return []
  await ensureStorage()

  const imported = []
  for (const source of result.filePaths) {
    const ext = extname(source)
    const safeName = `${Date.now()}-${crypto.randomUUID()}${ext || ''}`
    const destination = join(getPaths().attachmentDir, safeName)
    await copyFile(source, destination)
    imported.push({
      name: basename(source),
      path: destination,
      url: `file://${destination}`,
    })
  }
  return imported
})

ipcMain.handle('attachment:paste', async () => {
  const image = clipboard.readImage()
  if (image.isEmpty()) return []

  const buffer = image.toPNG()
  if (!buffer.byteLength) return []

  const saved = await saveAttachmentBuffer(buffer, `剪贴板图片 ${new Date().toLocaleString('zh-CN')}.png`)
  return [saved]
})

ipcMain.handle('attachment:save-data-url', async (_event, payload) => {
  const dataUrl = String(payload?.dataUrl || '')
  const match = dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i)
  if (!match) return []

  const mimeType = match[1].toLowerCase()
  const ext = mimeType.includes('jpeg') ? '.jpg' : mimeType.includes('webp') ? '.webp' : '.png'
  const buffer = Buffer.from(match[2], 'base64')
  if (!buffer.byteLength) return []

  const saved = await saveAttachmentBuffer(buffer, String(payload?.name || `粘贴图片 ${new Date().toLocaleString('zh-CN')}${ext}`), ext)
  return [saved]
})

ipcMain.handle('storage:reveal', async () => {
  await ensureStorage()
  shell.showItemInFolder(getPaths().dataFile)
  return getPaths()
})

ipcMain.handle('logs:reveal', async () => {
  await ensureStorage()
  const paths = getPaths()
  await writeLog('info', 'User opened Todo Desk log file')
  shell.showItemInFolder(paths.logFile)
  return paths
})

ipcMain.handle('calendar:open-task', async (_event, task) => {
  try {
    return await openTaskInCalendar(task)
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : '加入日历失败',
    }
  }
})

ipcMain.handle('agent:open-session', async (_event, task) => {
  try {
    const url = buildAgentSessionUrl(task)
    await shell.openExternal(url)
    await writeLog('info', 'Opened agent session link', {
      taskId: task?.id,
      agent: task?.origin?.agent?.name || task?.agent || task?.source || '',
      agentSessionId: task?.origin?.agent?.sessionId || task?.agentSessionId || '',
      url,
    })
    return { ok: true, url }
  } catch (error) {
    const message = error instanceof Error ? error.message : '打开 agent session 失败'
    await writeLog('warn', 'Open agent session failed', {
      taskId: task?.id,
      agent: task?.origin?.agent?.name || task?.agent || task?.source || '',
      agentSessionId: task?.origin?.agent?.sessionId || task?.agentSessionId || '',
      message,
    })
    return { ok: false, message }
  }
})

ipcMain.handle('dock:restore', async () => {
  restoreDockedWindow()
  return { ok: true }
})

ipcMain.handle('dock:to-edge', async (_event, edge) => {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false }
  if (isDocked) {
    restoreDockedWindow()
  }
  const display = screen.getDisplayMatching(mainWindow.getBounds())
  await dockWindowToEdge(mainWindow, edge === 'left' ? 'left' : 'right', display.workArea)
  return { ok: true }
})

ipcMain.handle('dock:detail-open', async (_event, open) => setDockDetailOpen(Boolean(open)))

ipcMain.handle('dock:set-passthrough', async (_event, enabled) => {
  setDockPassthrough(Boolean(enabled) && isDocked)
  return { ok: true }
})

ipcMain.handle('window:apply-mode', async (_event, mode) => {
  applyAppModeWindow(mode === 'mini' ? 'mini' : 'normal')
  return { ok: true }
})

ipcMain.handle('ai:parse-task', async (_event, payload) => {
  try {
    return await callAiTaskParser(payload.text, payload.settings, payload.images || [])
  } catch (error) {
    const localTasks = parseTasksWithLocalFallback(payload.text)
    if (localTasks.length) {
      await writeLog('warn', 'AI parse request used local fallback', {
        inputLength: String(payload.text || '').length,
        taskCount: localTasks.length,
        error: error instanceof Error ? error.message : 'AI 解析失败',
      })
      return {
        ok: true,
        task: localTasks[0],
        tasks: localTasks,
        usedLocalFallback: true,
        imageMode: 'local',
        imageCount: 0,
        message: 'AI 请求失败，已使用本地时间识别',
      }
    }
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'AI 解析失败',
    }
  }
})

ipcMain.handle('ai:merge-tasks', async (_event, payload) => {
  try {
    return await callAiTaskMerger(payload.tasks || [], payload.settings)
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'AI 合并失败',
    }
  }
})

ipcMain.handle('ai:test-connection', async (_event, payload) => {
  try {
    return await callAiConnectivityTest(payload.settings || {})
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'AI 连通性测试失败',
    }
  }
})

ipcMain.handle('lark:sync', async (_event, payload) => {
  const { data, completedTaskId } = payload
  const doc = data.settings?.larkDoc?.trim()
  if (!doc) {
    return {
      ok: false,
      skipped: true,
      message: '还没有配置飞书文档链接',
    }
  }

  const completedTask = data.tasks.find((task) => task.id === completedTaskId)
  const markdown = buildLarkMarkdown(data, completedTask)
  await runLarkUpdate(doc, markdown)

  const nextData = {
    ...data,
    syncLog: [
      {
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
        taskId: completedTaskId ?? '',
        title: completedTask?.title ?? '手动同步',
        status: 'ok',
      },
      ...(data.syncLog ?? []),
    ].slice(0, 50),
  }
  await saveData(nextData)
  return {
    ok: true,
    data: nextData,
  }
})
