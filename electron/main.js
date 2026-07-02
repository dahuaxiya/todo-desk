import { app, BrowserWindow, clipboard, dialog, ipcMain, screen, shell } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { appendFile, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { basename, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildAiEndpoint, buildAiFallbackEndpoint, buildAiMergeRequestPayload, clipText, looksLikeHtml, normalizeMergedTask, parseTasksWithAiAndImages } from './ai-task-parser.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const isDev = Boolean(process.env.VITE_DEV_SERVER_URL)
const appDataVersion = 1
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

const dockCollapsedWidth = 152
const dockDetailWidth = 260
const dockDetailGap = 12
const dockExpandedWidth = dockCollapsedWidth + dockDetailGap + dockDetailWidth
const dockDetachThreshold = 96
const normalWindowBackground = '#f7f2e8'
const dockWindowBackground = '#f8edcf'
const aiRequestTimeoutMs = 45_000
const miniWindowWidth = 300
const miniWindowHeight = 350
const miniWindowMinWidth = 300
const miniWindowMinHeight = 350
const codexThreadIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
    tasks: Array.isArray(data.tasks) ? data.tasks : [],
    trash: Array.isArray(data.trash) ? data.trash : [],
    syncLog: Array.isArray(data.syncLog) ? data.syncLog : [],
  }
}

async function saveData(nextData) {
  const normalized = {
    ...nextData,
    version: appDataVersion,
  }
  await ensureStorage()
  await writeJson(getPaths().dataFile, normalized)
  return normalized
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
  const status = ['doing', 'todo', 'done'].includes(input.status) ? input.status : 'doing'
  const priority = ['low', 'medium', 'high'].includes(input.priority) ? input.priority : 'medium'
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

  return {
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
    source: String(input.source || 'api').trim(),
    agent: String(input.agent || input.agentName || '').trim(),
    agentSessionId: String(input.agentSessionId || input.sessionId || input.session || '').trim(),
    repository: String(input.repository || input.repo || '').trim(),
    repositoryPath: String(input.repositoryPath || input.repoPath || '').trim(),
  }
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
  if (['doing', 'todo', 'done'].includes(input.status)) {
    patch.status = input.status
    patch.completedAt = input.status === 'done' ? currentTask.completedAt || now : ''
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
  return patch
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

function escapeIcsText(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;')
}

function formatIcsDate(value) {
  return new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

function buildTaskCalendarEvent(task) {
  const eventAt = task.reminderAt || task.dueAt
  if (!eventAt) {
    throw new Error('这个任务没有提醒时间或截止时间，无法加入日历')
  }
  const start = new Date(eventAt)
  if (Number.isNaN(start.getTime())) {
    throw new Error('任务提醒时间无效')
  }
  const end = new Date(start.getTime() + 30 * 60_000)
  const description = [
    task.detail,
    task.project ? `项目：${task.project}` : '',
    task.tags?.length ? `标签：${task.tags.map((tag) => `#${tag}`).join(' ')}` : '',
    task.agent ? `Agent：${task.agent}` : '',
    task.agentSessionId ? `Session：${task.agentSessionId}` : '',
    task.repository ? `代码库：${task.repository}` : '',
  ].filter(Boolean).join('\n')
  const alarmMinutes = task.reminderAt ? 0 : 10

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Todo Desk//Reminder//CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${task.id || crypto.randomUUID()}@todo-desk.local`,
    `DTSTAMP:${formatIcsDate(new Date())}`,
    `DTSTART:${formatIcsDate(start)}`,
    `DTEND:${formatIcsDate(end)}`,
    `SUMMARY:${escapeIcsText(task.title || 'Todo Desk 提醒')}`,
    description ? `DESCRIPTION:${escapeIcsText(description)}` : '',
    'BEGIN:VALARM',
    `TRIGGER:-PT${alarmMinutes}M`,
    'ACTION:DISPLAY',
    `DESCRIPTION:${escapeIcsText(task.title || 'Todo Desk 提醒')}`,
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].filter((line) => line !== '').join('\r\n')
}

async function openTaskInCalendar(task) {
  await ensureStorage()
  const safeName = `${Date.now()}-${String(task.title || 'todo-desk').replace(/[^\p{L}\p{N}-]+/gu, '-').slice(0, 48) || 'todo-desk'}.ics`
  const filePath = join(getPaths().calendarDir, safeName)
  await writeFile(filePath, buildTaskCalendarEvent(task), 'utf8')
  await shell.openPath(filePath)
  await writeLog('info', 'Task calendar event exported', { taskId: task.id, title: task.title, filePath })
  return { ok: true, filePath }
}

function buildAgentSessionUrl(task) {
  const agent = String(task?.agent || task?.source || '').trim().toLowerCase()
  const sessionId = String(task?.agentSessionId || '').trim()
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

function buildLarkMarkdown(data, completedTask) {
  const doing = data.tasks.filter((task) => task.status === 'doing')
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
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setBackgroundColor(docked ? dockWindowBackground : normalWindowBackground)
    updateWindowButtonVisibility(mainWindow)
    mainWindow.webContents.send('dock:changed', { docked, edge })
  }
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

function dockWindowToEdge(window, edge, area) {
  if (!window || window.isDestroyed() || isDocked) return
  lastNormalBounds = window.getBounds()
  keepOnTopBeforeDock = window.isAlwaysOnTop()
  const width = dockCollapsedWidth
  const height = Math.min(520, Math.max(360, area.height - 160))
  const y = area.y + Math.round((area.height - height) / 2)
  const x = edge === 'left' ? area.x : area.x + area.width - width
  window.setMinimumSize(dockCollapsedWidth, 260)
  window.setBackgroundColor(dockWindowBackground)
  window.setAlwaysOnTop(true, 'floating')
  const dockedBounds = { x, y, width, height }
  dockDragStartBounds = dockedBounds
  setWindowBounds(window, dockedBounds, true)
  setDockState(true, edge)
}

function setDockDetailOpen(open) {
  if (!mainWindow || mainWindow.isDestroyed() || !isDocked) return { ok: false }
  const current = mainWindow.getBounds()
  const display = screen.getDisplayMatching(current)
  const area = display.workArea
  const width = Math.min(open ? dockExpandedWidth : dockCollapsedWidth, area.width)
  const height = Math.min(current.height, area.height)
  const x = currentDockEdge === 'left' ? area.x : area.x + area.width - width
  const y = Math.min(Math.max(current.y, area.y), area.y + area.height - height)
  const nextBounds = { x, y, width, height }
  mainWindow.setMinimumSize(dockCollapsedWidth, 260)
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
    dockWindowToEdge(window, 'left', area)
    return
  }
  if (Math.abs(bounds.x + bounds.width - (area.x + area.width)) <= threshold) {
    dockWindowToEdge(window, 'right', area)
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
    backgroundColor: normalWindowBackground,
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
      agent: task?.agent || task?.source || '',
      agentSessionId: task?.agentSessionId || '',
      url,
    })
    return { ok: true, url }
  } catch (error) {
    const message = error instanceof Error ? error.message : '打开 agent session 失败'
    await writeLog('warn', 'Open agent session failed', {
      taskId: task?.id,
      agent: task?.agent || task?.source || '',
      agentSessionId: task?.agentSessionId || '',
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
  dockWindowToEdge(mainWindow, edge === 'left' ? 'left' : 'right', display.workArea)
  return { ok: true }
})

ipcMain.handle('dock:detail-open', async (_event, open) => setDockDetailOpen(Boolean(open)))

ipcMain.handle('window:apply-mode', async (_event, mode) => {
  applyAppModeWindow(mode === 'mini' ? 'mini' : 'normal')
  return { ok: true }
})

ipcMain.handle('ai:parse-task', async (_event, payload) => {
  try {
    return await callAiTaskParser(payload.text, payload.settings, payload.images || [])
  } catch (error) {
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
