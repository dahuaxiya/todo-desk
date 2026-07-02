import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'

const taskStatuses = new Set(['doing', 'todo', 'done'])
const priorities = new Set(['high', 'medium', 'low'])
const defaultImageLimitBytes = 6 * 1024 * 1024

function normalizeTags(value) {
  const rawTags = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  return rawTags.flatMap((tag) =>
    String(tag)
      .split(/[,\s，、]+/)
      .map((item) => item.trim())
      .filter(Boolean),
  )
}

export function buildAiEndpoint(baseUrl) {
  return `${String(baseUrl || '').replace(/\/$/, '')}/chat/completions`
}

export function buildAiFallbackEndpoint(baseUrl) {
  const normalized = String(baseUrl || '').replace(/\/$/, '')
  if (!normalized || /\/v1$/i.test(normalized)) return ''
  return `${normalized}/v1/chat/completions`
}

export function looksLikeHtml(text, contentType) {
  return /text\/html/i.test(contentType) || /^\s*</.test(String(text || ''))
}

export function clipText(value, size = 800) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, size)
}

function getImageMimeType(filePath) {
  const ext = extname(filePath || '').toLowerCase()
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.png') return 'image/png'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.bmp') return 'image/bmp'
  return 'application/octet-stream'
}

export function shouldUseOcrFallback(error) {
  const message = error instanceof Error ? error.message : String(error || '')
  return /image|vision|multimodal|multi-modal|image_url|unsupported|not support|content.*array|modalit|图片|图像|视觉|available channel|可用渠道|渠道不存在|get_channel_failed|distributor/i.test(
    message,
  )
}

export function buildAiTaskParserPrompt(text, now = new Date().toISOString()) {
  return [
    '你是 Todo 元数据解析器。只返回 JSON，不要解释。',
    '根据用户输入识别一个或多个任务。用户一次输入多个事项时，必须拆成多条任务。',
    '如果提供了图片，请读取图片里的文字、表格、截图、便签或看板内容，并把其中表达的事项拆成任务。',
    '返回格式必须是 {"tasks":[{"title":"","detail":"","status":"todo","priority":"medium","project":"","tags":[],"dueAt":"","reminderAt":""}]}。',
    'tasks 按用户输入顺序排列；不要合并互相独立的事项；不要编造用户没有表达的任务。',
    'title 要短，detail 放补充上下文；没有 detail 就返回空字符串。',
    'status 只能是 doing/todo/done；正在做、当前在做、working on、in progress 返回 doing；已完成、done、completed 返回 done；其他默认 todo。',
    'priority 只能是 high/medium/low，默认 medium。',
    'tags 是字符串数组。',
    'dueAt/reminderAt 必须是 ISO 8601 字符串；用户未指定时区时按 Asia/Shanghai 输出 +08:00，不要用 Z；没有就返回空字符串。',
    `当前时间：${now}`,
    `用户输入：${text}`,
  ].join('\n')
}

function buildMessageContent(prompt, images = []) {
  if (!images.length) return prompt
  return [
    { type: 'text', text: prompt },
    ...images.map((image) => ({
      type: 'image_url',
      image_url: {
        url: image.dataUrl,
        detail: 'high',
      },
    })),
  ]
}

export function buildAiRequestPayload(text, settings, now, images = []) {
  const prompt = buildAiTaskParserPrompt(text, now)
  return {
    model: settings.aiModel,
    messages: [
      {
        role: 'system',
        content: 'Extract one or more todo items as strict JSON.',
      },
      {
        role: 'user',
        content: buildMessageContent(prompt, images),
      },
    ],
    temperature: 0.1,
  }
}

export function buildAiMergePrompt(tasks) {
  const lines = tasks.map((task, index) => {
    const meta = [
      task.project ? `项目:${task.project}` : '',
      task.tags?.length ? `标签:${task.tags.join(',')}` : '',
      task.dueAt ? `截止:${task.dueAt}` : '',
      task.reminderAt ? `提醒:${task.reminderAt}` : '',
      task.agent ? `Agent:${task.agent}` : '',
      task.agentSessionId ? `Session:${task.agentSessionId}` : '',
      task.repository ? `代码库:${task.repository}` : '',
    ].filter(Boolean)
    return [
      `任务 ${index + 1}: ${task.title}`,
      task.detail ? `详情: ${task.detail}` : '',
      meta.length ? `元数据: ${meta.join('；')}` : '',
    ].filter(Boolean).join('\n')
  })

  return [
    '你是 Todo 任务合并助手。只返回 JSON，不要解释。',
    '把多个相关任务合并成一个任务，保留关键上下文、下一步动作、约束和时间信息。',
    '返回格式必须是 {"title":"","detail":""}。',
    'title 要短而可执行；detail 用中文整理成清晰的多行内容。',
    '不要编造原任务里没有的信息。',
    '',
    lines.join('\n\n'),
  ].join('\n')
}

export function buildAiMergeRequestPayload(tasks, settings) {
  return {
    model: settings.aiModel,
    messages: [
      { role: 'system', content: 'Merge multiple todo items into one strict JSON object.' },
      { role: 'user', content: buildAiMergePrompt(tasks) },
    ],
    temperature: 0.2,
  }
}

export function normalizeMergedTask(value, tasks = []) {
  const parsed = typeof value === 'string' ? extractJsonObject(value) : value && typeof value === 'object' ? value : {}
  return {
    title: typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : tasks.map((task) => task.title).join(' / '),
    detail: typeof parsed.detail === 'string' && parsed.detail.trim()
      ? parsed.detail.trim()
      : typeof parsed.description === 'string' && parsed.description.trim()
        ? parsed.description.trim()
        : tasks.map((task) => [task.title, task.detail].filter(Boolean).join('\n')).join('\n\n'),
  }
}

export async function loadImageInputs(images = [], options = {}) {
  const maxBytes = options.maxBytes ?? defaultImageLimitBytes
  const loaded = []

  for (const image of images) {
    const source = image?.path || image?.filePath || ''
    if (!source || !existsSync(source)) continue

    const bytes = await readFile(source)
    if (bytes.byteLength > maxBytes) {
      throw new Error(`图片过大，无法发送给 AI：${basename(source)} ${(bytes.byteLength / 1024 / 1024).toFixed(1)}MB`)
    }

    const mimeType = image.mimeType || getImageMimeType(source)
    if (!mimeType.startsWith('image/')) continue

    loaded.push({
      name: image.name || basename(source),
      path: source,
      mimeType,
      dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}`,
    })
  }

  return loaded
}

export function extractJsonObject(text) {
  const trimmed = String(text || '').trim()
  if (!trimmed) return {}

  try {
    return JSON.parse(trimmed)
  } catch {
    const cleaned = trimmed.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
    try {
      return JSON.parse(cleaned)
    } catch {
      const objectMatch = cleaned.match(/\{[\s\S]*\}/) || trimmed.match(/\{[\s\S]*\}/)
      if (objectMatch) return JSON.parse(objectMatch[0])

      const arrayMatch = cleaned.match(/\[[\s\S]*\]/) || trimmed.match(/\[[\s\S]*\]/)
      if (arrayMatch) return JSON.parse(arrayMatch[0])

      return {}
    }
  }
}

function readTaskCandidates(value) {
  if (Array.isArray(value)) return value
  if (!value || typeof value !== 'object') return []

  if (Array.isArray(value.tasks)) return value.tasks
  if (Array.isArray(value.todos)) return value.todos
  if (Array.isArray(value.items)) return value.items
  return [value]
}

function normalizeParsedTask(value, fallbackTitle) {
  const record = value && typeof value === 'object' ? value : {}
  const title = typeof record.title === 'string' ? record.title.trim() : ''
  const detail = typeof record.detail === 'string' ? record.detail : typeof record.description === 'string' ? record.description : ''
  const rawStatus = typeof record.status === 'string' ? record.status : ''
  const rawPriority = typeof record.priority === 'string' ? record.priority : ''
  const rawProject =
    typeof record.project === 'string' ? record.project : typeof record.group === 'string' ? record.group : ''
  const tags = normalizeTags(record.tags)

  return {
    title: title || fallbackTitle,
    detail: detail.trim(),
    status: taskStatuses.has(rawStatus) ? rawStatus : 'todo',
    priority: priorities.has(rawPriority) ? rawPriority : 'medium',
    project: rawProject.trim(),
    tags,
    dueAt: record.dueAt ? new Date(String(record.dueAt)).toISOString() : '',
    reminderAt: record.reminderAt ? new Date(String(record.reminderAt)).toISOString() : '',
  }
}

export function normalizeParsedTasks(value, fallbackTitle) {
  const normalizedFallbackTitle = fallbackTitle?.trim() || '图片中的任务'
  const candidates = readTaskCandidates(value)
  const tasks = candidates
    .map((candidate) => normalizeParsedTask(candidate, normalizedFallbackTitle))
    .filter((task) => Boolean(task.title?.trim()))
  return tasks.length ? tasks : [normalizeParsedTask({}, normalizedFallbackTitle)]
}

export async function parseTasksWithAi(text, settings, requestEndpoint, options = {}) {
  if (!settings.aiEnabled) {
    return { ok: false, skipped: true, message: 'AI 未启用' }
  }
  if (!settings.aiBaseUrl || !settings.aiModel) {
    return { ok: false, skipped: true, message: 'AI Base URL 或 Model 未配置' }
  }

  const requestPayload = buildAiRequestPayload(text, settings, undefined, options.images || [])
  const endpoint = buildAiEndpoint(settings.aiBaseUrl)
  let usedEndpoint = endpoint
  let usedFallback = false

  let aiResponse = await requestEndpoint(endpoint, requestPayload, settings)
  let { response, rawBody, contentType } = aiResponse

  if (response.ok && looksLikeHtml(rawBody, contentType)) {
    const fallbackEndpoint = buildAiFallbackEndpoint(settings.aiBaseUrl)
    if (fallbackEndpoint) {
      usedEndpoint = fallbackEndpoint
      usedFallback = true
      aiResponse = await requestEndpoint(fallbackEndpoint, requestPayload, settings)
      response = aiResponse.response
      rawBody = aiResponse.rawBody
      contentType = aiResponse.contentType
    }
  }

  if (!response.ok) {
    throw new Error(`AI 请求失败 ${response.status} ${response.statusText || ''}：${clipText(rawBody, 180)}`)
  }
  if (looksLikeHtml(rawBody, contentType)) {
    throw new Error(`AI 返回的不是 JSON，可能 Base URL 填错或被重定向：${clipText(rawBody, 180)}`)
  }

  const body = JSON.parse(rawBody)
  const content = body?.choices?.[0]?.message?.content ?? ''
  const parsed = extractJsonObject(content)
  const tasks = normalizeParsedTasks(parsed, text)

  return {
    ok: true,
    task: tasks[0],
    tasks,
    endpoint: usedEndpoint,
    usedFallback,
    contentType,
    imageMode: options.images?.length ? 'vision' : 'none',
    imageCount: options.images?.length ?? 0,
  }
}

function runCommand(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${command} timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }
      reject(new Error(stderr.trim() || `${command} exited with code ${code}`))
    })
  })
}

function resolveTesseractCommand() {
  if (existsSync('/opt/homebrew/bin/tesseract')) return '/opt/homebrew/bin/tesseract'
  if (existsSync('/usr/local/bin/tesseract')) return '/usr/local/bin/tesseract'
  return 'tesseract'
}

export async function detectTesseractLanguage() {
  try {
    const { stdout } = await runCommand(resolveTesseractCommand(), ['--list-langs'], { timeoutMs: 5_000 })
    const languages = new Set(
      stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('List of available languages')),
    )
    const preferred = ['chi_sim', 'chi_tra', 'eng'].filter((language) => languages.has(language))
    if (preferred.length) return preferred.join('+')
  } catch {
    // If Tesseract is missing or language listing fails, let the real OCR call surface the error.
  }
  return 'eng'
}

export async function extractTextFromImagesWithOcr(images = [], options = {}) {
  const results = []
  const language = options.language || (await detectTesseractLanguage())

  for (const image of images) {
    if (!image.path || !existsSync(image.path)) continue
    try {
      const { stdout } = await runCommand(resolveTesseractCommand(), [image.path, 'stdout', '-l', language, '--psm', '6'])
      const text = stdout.trim()
      if (text) {
        results.push({
          name: image.name || basename(image.path),
          path: image.path,
          text,
        })
      }
    } catch (error) {
      results.push({
        name: image.name || basename(image.path),
        path: image.path,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return results
}

function formatOcrContext(results) {
  return results
    .filter((result) => result.text)
    .map((result, index) => `图片 ${index + 1}（${result.name}）OCR 内容：\n${result.text}`)
    .join('\n\n')
}

export async function parseTasksWithAiAndImages(text, settings, requestEndpoint, options = {}) {
  const images = await loadImageInputs(options.images || [])
  const extractOcr = options.extractOcr || extractTextFromImagesWithOcr

  try {
    return await parseTasksWithAi(text, settings, requestEndpoint, { images })
  } catch (error) {
    if (!images.length || !shouldUseOcrFallback(error)) throw error

    const ocrResults = await extractOcr(images)
    const ocrContext = formatOcrContext(ocrResults)
    if (!ocrContext.trim()) {
      throw new Error(`模型不支持图片解析，OCR 也没有识别出可用文字：${error instanceof Error ? error.message : error}`)
    }

    const retryText = [text.trim(), ocrContext].filter(Boolean).join('\n\n')
    const result = await parseTasksWithAi(retryText, settings, requestEndpoint)
    return {
      ...result,
      imageMode: 'ocr',
      imageCount: images.length,
      ocrText: clipText(ocrContext, 1200),
      ocrErrors: ocrResults.filter((result) => result.error).map((result) => `${result.name}: ${result.error}`),
    }
  }
}
