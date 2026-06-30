import { app, BrowserWindow, dialog, ipcMain, screen, shell } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { basename, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const isDev = Boolean(process.env.VITE_DEV_SERVER_URL)
const appDataVersion = 1
let mainWindow = null
let apiServer = null
let apiPort = null
let lastNormalBounds = null
let isDocked = false

function getPaths() {
  const userData = app.getPath('userData')
  return {
    userData,
    dataFile: join(userData, 'todo-desk-data.json'),
    attachmentDir: join(userData, 'attachments'),
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
    syncLog: [],
  }
}

async function ensureStorage() {
  const paths = getPaths()
  await mkdir(paths.attachmentDir, { recursive: true })
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
    },
    tasks: Array.isArray(data.tasks) ? data.tasks : [],
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

function sendJson(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': 'http://127.0.0.1',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
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
    imagePaths: [],
    createdAt: now,
    updatedAt: now,
    completedAt: status === 'done' ? now : '',
    source: String(input.source || 'api').trim(),
  }
}

async function addTaskFromApi(input) {
  const task = normalizeExternalTask(input)
  if (!task.title) {
    throw new Error('title is required')
  }

  const data = await readData()
  const nextData = await saveData({
    ...data,
    tasks: [task, ...data.tasks],
  })

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('data:updated', nextData)
  }

  return { task, data: nextData }
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
      const result = await addTaskFromApi(body)
      sendJson(response, 201, {
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

function formatTaskLine(task) {
  const tags = task.tags?.length ? ` #${task.tags.join(' #')}` : ''
  const due = task.dueAt ? ` 截止:${formatDateTime(task.dueAt)}` : ''
  const project = task.project ? ` [${task.project}]` : ''
  return `- ${task.title}${project}${due}${tags}`
}

function extractJsonObject(text) {
  const trimmed = String(text || '').trim()
  if (!trimmed) return {}
  try {
    return JSON.parse(trimmed)
  } catch {
    const cleaned = trimmed.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
    try {
      return JSON.parse(cleaned)
    } catch {
      // Continue below and pull the first JSON-looking object out of a chatty model response.
    }
    const match = cleaned.match(/\{[\s\S]*\}/) || trimmed.match(/\{[\s\S]*\}/)
    if (!match) return {}
    return JSON.parse(match[0])
  }
}

async function callAiTaskParser(text, settings) {
  if (!settings.aiEnabled) {
    return { ok: false, skipped: true, message: 'AI 未启用' }
  }
  if (!settings.aiBaseUrl || !settings.aiModel) {
    return { ok: false, skipped: true, message: 'AI Base URL 或 Model 未配置' }
  }

  const endpoint = `${settings.aiBaseUrl.replace(/\/$/, '')}/chat/completions`
  const today = new Date().toISOString()
  const prompt = [
    '你是 Todo 元数据解析器。只返回 JSON，不要解释。',
    '根据用户输入识别任务字段：title, detail, status, priority, project, tags, dueAt, reminderAt。',
    'status 只能是 doing/todo/done，默认 todo。',
    'priority 只能是 high/medium/low，默认 medium。',
    'tags 是字符串数组。',
    'dueAt/reminderAt 必须是 ISO 8601 字符串；没有就返回空字符串。',
    `当前时间：${today}`,
    `用户输入：${text}`,
  ].join('\n')

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(settings.aiApiKey ? { Authorization: `Bearer ${settings.aiApiKey}` } : {}),
    },
    body: JSON.stringify({
      model: settings.aiModel,
      messages: [
        {
          role: 'system',
          content: 'Extract todo metadata as strict JSON.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 0.1,
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`AI 请求失败 ${response.status}: ${body.slice(0, 240)}`)
  }

  const body = await response.json()
  const content = body?.choices?.[0]?.message?.content ?? ''
  const parsed = extractJsonObject(content)
  const task = {
    title: typeof parsed.title === 'string' ? parsed.title : text,
    detail: typeof parsed.detail === 'string' ? parsed.detail : '',
    status: ['doing', 'todo', 'done'].includes(parsed.status) ? parsed.status : 'todo',
    priority: ['high', 'medium', 'low'].includes(parsed.priority) ? parsed.priority : 'medium',
    project: typeof parsed.project === 'string' ? parsed.project : '',
    tags: Array.isArray(parsed.tags) ? parsed.tags.map((tag) => String(tag)).filter(Boolean) : [],
    dueAt: parsed.dueAt ? new Date(parsed.dueAt).toISOString() : '',
    reminderAt: parsed.reminderAt ? new Date(parsed.reminderAt).toISOString() : '',
  }

  return { ok: true, task }
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
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('dock:changed', { docked, edge })
  }
}

function dockWindowToEdge(window, edge, area) {
  if (!window || window.isDestroyed() || isDocked) return
  lastNormalBounds = window.getBounds()
  const width = 136
  const height = Math.min(520, Math.max(360, area.height - 160))
  const y = area.y + Math.round((area.height - height) / 2)
  const x = edge === 'left' ? area.x : area.x + area.width - width
  window.setMinimumSize(96, 260)
  window.setBounds({ x, y, width, height }, true)
  setDockState(true, edge)
}

function restoreDockedWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const current = mainWindow.getBounds()
  const nextBounds = lastNormalBounds
    ? { ...lastNormalBounds }
    : { x: current.x - 844, y: current.y, width: 980, height: 900 }
  mainWindow.setMinimumSize(760, 640)
  mainWindow.setBounds(nextBounds, true)
  setDockState(false)
}

function snapWindowToEdge(window) {
  if (!window || window.isDestroyed()) return
  const bounds = window.getBounds()
  const display = screen.getDisplayMatching(bounds)
  const area = display.workArea
  const threshold = 32
  const nextBounds = { ...bounds }
  let snapped = false

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
    window.setBounds(nextBounds, true)
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
  mainWindow = new BrowserWindow({
    width: 980,
    height: 900,
    minWidth: 760,
    minHeight: 640,
    title: 'Todo Desk',
    backgroundColor: '#f7f2e8',
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

  mainWindow.on('moved', async () => {
    const current = await readData()
    if (current.settings.snapToEdge) snapWindowToEdge(mainWindow)
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
    mainWindow.setAlwaysOnTop(Boolean(saved.settings.keepOnTop))
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

ipcMain.handle('storage:reveal', async () => {
  await ensureStorage()
  shell.showItemInFolder(getPaths().dataFile)
  return getPaths()
})

ipcMain.handle('dock:restore', async () => {
  restoreDockedWindow()
  return { ok: true }
})

ipcMain.handle('ai:parse-task', async (_event, payload) => {
  try {
    return await callAiTaskParser(payload.text, payload.settings)
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'AI 解析失败',
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
