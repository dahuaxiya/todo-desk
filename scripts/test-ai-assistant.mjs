#!/usr/bin/env node

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildAiMergeRequestPayload,
  detectTesseractLanguage,
  extractTextFromImagesWithOcr,
  normalizeMergedTask,
  parseTasksWithAi,
  parseTasksWithAiAndImages,
} from '../electron/ai-task-parser.js'

const defaultDataFile = join(homedir(), 'Library/Application Support/todo-desk/todo-desk-data.json')
const dataFile = process.env.TODO_DESK_DATA_FILE || defaultDataFile
const timeoutMs = Number(process.env.TODO_DESK_AI_TIMEOUT_MS || 45_000)

const testCases = [
  {
    name: '正在做的高优先级工作',
    input: '我现在正在修复 Todo Desk release 文本展示问题，归到 Todo Desk，优先级高，标签 codex release',
    expect: {
      status: 'doing',
      priority: 'high',
      projectIncludes: 'Todo Desk',
      tags: ['codex', 'release'],
      textIncludes: ['release'],
    },
  },
  {
    name: '明确截止时间和提醒时间',
    input:
      '2026年7月3日18:00前完成飞书同步验收，2026年7月3日17:30提醒我，项目飞书同步，优先级中，标签 feishu 验收',
    expect: {
      status: 'todo',
      priority: 'medium',
      projectIncludes: '飞书同步',
      tags: ['feishu', '验收'],
      dueAtLocal: '2026-07-03 18:00',
      reminderAtLocal: '2026-07-03 17:30',
    },
  },
  {
    name: '已完成事项识别',
    input: '已经完成 README 增加 UI 截图，项目 Todo Desk，低优先级，标签 文档 UI',
    expect: {
      status: 'done',
      priority: 'low',
      projectIncludes: 'Todo Desk',
      tags: ['文档', 'UI'],
      textIncludes: ['README', '截图'],
    },
  },
  {
    name: '项目分组和标签抽取',
    input: '整理客户反馈截图形成产品需求，放到产品反馈项目，优先级低，标签 图片 需求 用户反馈',
    expect: {
      status: 'todo',
      priority: 'low',
      projectIncludes: '产品反馈',
      tags: ['图片', '需求', '用户反馈'],
      textIncludes: ['客户反馈', '产品需求'],
    },
  },
  {
    name: '混合中英文输入',
    input: 'Working on Todo Desk agent skill integration, project AI 工作, priority medium, tags codex skill api',
    expect: {
      status: 'doing',
      priority: 'medium',
      projectIncludes: 'AI',
      tags: ['codex', 'skill', 'api'],
      textIncludes: ['skill'],
    },
  },
  {
    name: '一次输入多个任务',
    input:
      '今天正在做 release notes 美化，项目 Todo Desk，优先级高，标签 release；明天上午10点提醒我整理飞书同步测试用例，项目 QA，优先级中，标签 feishu test；已经完成 App icon 方案确认，项目 Todo Desk，低优先级，标签 icon',
    expectTasks: [
      {
        status: 'doing',
        priority: 'high',
        projectIncludes: 'Todo Desk',
        tags: ['release'],
        textIncludes: ['release'],
      },
      {
        status: 'todo',
        priority: 'medium',
        projectIncludes: 'QA',
        tags: ['feishu', 'test'],
        textIncludes: ['飞书同步', '测试用例'],
      },
      {
        status: 'done',
        priority: 'low',
        projectIncludes: 'Todo Desk',
        tags: ['icon'],
        textIncludes: ['icon'],
      },
    ],
  },
]

function loadSettings() {
  if (!existsSync(dataFile)) {
    throw new Error(`找不到 Todo Desk 数据文件：${dataFile}`)
  }

  const data = JSON.parse(readFileSync(dataFile, 'utf8'))
  const settings = data.settings || {}
  return {
    aiEnabled: Boolean(settings.aiEnabled),
    aiBaseUrl: process.env.TODO_DESK_AI_BASE_URL || settings.aiBaseUrl || '',
    aiModel: process.env.TODO_DESK_AI_MODEL || settings.aiModel || '',
    aiApiKey: process.env.TODO_DESK_AI_API_KEY || settings.aiApiKey || '',
  }
}

async function requestEndpoint(url, payload, settings) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(settings.aiApiKey ? { Authorization: `Bearer ${settings.aiApiKey}` } : {}),
      },
      body: JSON.stringify(payload),
    })
    return {
      response,
      rawBody: await response.text(),
      contentType: response.headers.get('content-type') || '',
    }
  } finally {
    clearTimeout(timer)
  }
}

async function parseTask(input, settings) {
  return parseTasksWithAi(input, settings, requestEndpoint)
}

async function runImagePayloadSmokeTest(settings) {
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAQAAAAAwCAYAAAB5XMOyAAAACXBIWXMAAAPoAAAD6AG1e1JrAAABJklEQVR4nO3ZQQ6CMBRF0UjvfzP0R2YSSIJq1NfUJnZsBOZn0WfKXEQEAAAAAAAAAAAAAAAAAAADgnT0r2e8m2/7y7jzr9c2LON3td9k91c4l9w7l3dtv1m7x4+jnnVLH7oHTZc+P56rVe/5uvB7q+7p4P9W7uvcfdhOeP6zvFdr3A9+/9HzdP2v7n8V5nXkD8v2r9vZx+3+8D2gG8AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADw6y0ZrQKJ1t3xNwAAAABJRU5ErkJggg=='
  const dir = mkdtempSync(join(tmpdir(), 'todo-desk-ai-image-'))
  const imagePath = join(dir, 'todo-image-test.png')
  writeFileSync(imagePath, Buffer.from(png, 'base64'))

  try {
    let sawImageUrl = false
    const result = await parseTasksWithAiAndImages(
      '从图片中识别任务',
      settings,
      async (_url, payload) => {
        const content = payload.messages?.[1]?.content
        sawImageUrl = Array.isArray(content) && content.some((part) => part.type === 'image_url')
        return {
          response: { ok: true, status: 200, statusText: 'OK' },
          contentType: 'application/json',
          rawBody: JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    tasks: [
                      {
                        title: '图片任务解析冒烟',
                        detail: '',
                        status: 'todo',
                        priority: 'medium',
                        project: '测试',
                        tags: ['image'],
                        dueAt: '',
                        reminderAt: '',
                      },
                    ],
                  }),
                },
              },
            ],
          }),
        }
      },
      { images: [{ name: 'todo-image-test.png', path: imagePath, url: `file://${imagePath}` }] },
    )

    if (!sawImageUrl) throw new Error('多模态请求 payload 中没有 image_url')
    if (result.imageMode !== 'vision') throw new Error(`imageMode 期望 vision，实际 ${result.imageMode}`)
    console.log('\n[PASS] image payload smoke test: Chat Completions image_url payload is generated')

    const ocrLanguage = await detectTesseractLanguage()
    console.log(`[INFO] OCR language selection: ${ocrLanguage}`)
    const ocrResults = await extractTextFromImagesWithOcr([{ name: 'todo-image-test.png', path: imagePath }])
    console.log(
      `[INFO] OCR smoke test: ${ocrResults[0]?.text ? 'recognized text' : 'no text recognized with installed language data'}`,
    )

    let callCount = 0
    const ocrFallbackResult = await parseTasksWithAiAndImages(
      '从图片中识别任务',
      settings,
      async (_url, payload) => {
        callCount += 1
        const content = payload.messages?.[1]?.content
        const isVisionCall = Array.isArray(content) && content.some((part) => part.type === 'image_url')
        if (isVisionCall) {
          return {
            response: { ok: false, status: 400, statusText: 'Bad Request' },
            contentType: 'application/json',
            rawBody: JSON.stringify({ error: { message: 'image_url is unsupported by this model' } }),
          }
        }

        const prompt = String(content || '')
        if (!prompt.includes('Review OCR fallback')) {
          throw new Error('OCR fallback prompt 没有包含注入的 OCR 文本')
        }

        return {
          response: { ok: true, status: 200, statusText: 'OK' },
          contentType: 'application/json',
          rawBody: JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    tasks: [
                      {
                        title: 'Review OCR fallback',
                        detail: '从图片 OCR 文本生成的测试任务',
                        status: 'todo',
                        priority: 'high',
                        project: 'Vision QA',
                        tags: ['image', 'ocr'],
                        dueAt: '',
                        reminderAt: '',
                      },
                    ],
                  }),
                },
              },
            ],
          }),
        }
      },
      {
        images: [{ name: 'todo-image-test.png', path: imagePath, url: `file://${imagePath}` }],
        extractOcr: async () => [
          {
            name: 'todo-image-test.png',
            path: imagePath,
            text: 'TODO: Review OCR fallback\nProject: Vision QA\nPriority: high\nTags: image ocr',
          },
        ],
      },
    )

    if (callCount !== 2) throw new Error(`OCR fallback 期望调用模型 2 次，实际 ${callCount}`)
    if (ocrFallbackResult.imageMode !== 'ocr') {
      throw new Error(`OCR fallback imageMode 期望 ocr，实际 ${ocrFallbackResult.imageMode}`)
    }
    if (ocrFallbackResult.tasks?.[0]?.title !== 'Review OCR fallback') {
      throw new Error('OCR fallback 未返回期望任务')
    }
    console.log('[PASS] OCR fallback smoke test: unsupported vision model falls back to OCR text')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function runAiMergeSmokeTest(settings) {
  const sourceTasks = [
    {
      title: '修复 AI 合并无反馈',
      detail: '点击 AI 合并后需要有明确状态提示',
      status: 'doing',
      priority: 'high',
      project: 'Todo Desk',
      tags: ['ai', 'merge'],
      dueAt: '',
      reminderAt: '',
      agent: 'codex',
      agentSessionId: 'session-merge-test',
      repository: 'todo-desk',
    },
    {
      title: '让 AI 合并成功落库',
      detail: '模型返回 title/detail 后创建合并任务，源任务进入回收箱',
      status: 'todo',
      priority: 'medium',
      project: 'Todo Desk',
      tags: ['merge'],
      dueAt: '',
      reminderAt: '',
      agent: 'codex',
      agentSessionId: 'session-merge-test',
      repository: 'todo-desk',
    },
  ]
  const payload = buildAiMergeRequestPayload(sourceTasks, settings)
  const prompt = payload.messages?.[1]?.content || ''
  if (!String(prompt).includes('Session:session-merge-test')) {
    throw new Error('AI merge prompt 没有带上 agent session 元数据')
  }

  const merged = normalizeMergedTask(
    '```json\n{"title":"修复 AI 合并链路","detail":"1. 点击后显示合并中\\n2. 请求成功后创建合并任务\\n3. 源任务进入回收箱"}\n```',
    sourceTasks,
  )
  if (merged.title !== '修复 AI 合并链路') throw new Error('AI merge title 解析失败')
  if (!merged.detail.includes('源任务进入回收箱')) throw new Error('AI merge detail 解析失败')
  console.log('[PASS] AI merge smoke test: merge prompt and fenced JSON response are handled')
}

async function runApiMetadataSmokeTest() {
  const task = {
    title: 'Agent session metadata',
    source: 'codex',
    agent: 'codex',
    agentSessionId: 'session-123',
    repository: 'todo-desk',
    repositoryPath: '/tmp/todo-desk',
    origin: {
      kind: 'agent',
      channel: 'todo-desk-skill',
      createdVia: 'todo-desk-skill/add_work',
      confidence: 'explicit',
      agent: {
        name: 'codex',
        sessionId: 'session-123',
        tool: 'codex',
      },
      repository: {
        name: 'todo-desk',
        path: '/tmp/todo-desk',
      },
    },
  }
  const required = ['agent', 'agentSessionId', 'repository', 'repositoryPath']
  for (const key of required) {
    if (!task[key]) throw new Error(`API metadata smoke test 缺少 ${key}`)
  }
  if (task.origin.kind !== 'agent' || task.origin.confidence !== 'explicit') {
    throw new Error('API metadata smoke test 缺少明确的 agent origin')
  }
  console.log('[PASS] API metadata smoke test: explicit origin plus legacy metadata are part of task payload contract')
}

function formatLocalDateMinute(value) {
  if (!value) return ''
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  return formatter.format(new Date(value))
}

function assertCase(testCase, parsedTask) {
  const failures = []
  const expect = testCase.expect
  const text = `${parsedTask.title}\n${parsedTask.detail}`
  const normalizedTags = parsedTask.tags.map((tag) => tag.toLowerCase())

  if (!parsedTask.title) failures.push('title 为空')
  if (!['doing', 'todo', 'done'].includes(parsedTask.status)) failures.push(`status 无效：${parsedTask.status || '<empty>'}`)
  if (!['high', 'medium', 'low'].includes(parsedTask.priority)) failures.push(`priority 无效：${parsedTask.priority || '<empty>'}`)

  if (expect.status && parsedTask.status !== expect.status) {
    failures.push(`status 期望 ${expect.status}，实际 ${parsedTask.status || '<empty>'}`)
  }
  if (expect.priority && parsedTask.priority !== expect.priority) {
    failures.push(`priority 期望 ${expect.priority}，实际 ${parsedTask.priority || '<empty>'}`)
  }
  if (expect.projectIncludes && !parsedTask.project.includes(expect.projectIncludes)) {
    failures.push(`project 未包含 ${expect.projectIncludes}，实际 ${parsedTask.project || '<empty>'}`)
  }

  for (const tag of expect.tags || []) {
    if (!normalizedTags.includes(String(tag).toLowerCase())) {
      failures.push(`tags 缺少 ${tag}，实际 [${parsedTask.tags.join(', ')}]`)
    }
  }

  for (const keyword of expect.textIncludes || []) {
    if (!text.includes(keyword)) {
      failures.push(`title/detail 未包含 ${keyword}`)
    }
  }

  if (expect.dueAtLocal) {
    const actual = formatLocalDateMinute(parsedTask.dueAt)
    if (actual !== expect.dueAtLocal) {
      failures.push(`dueAt 期望 ${expect.dueAtLocal}，实际 ${actual || '<empty>'}`)
    }
  }
  if (expect.reminderAtLocal) {
    const actual = formatLocalDateMinute(parsedTask.reminderAt)
    if (actual !== expect.reminderAtLocal) {
      failures.push(`reminderAt 期望 ${expect.reminderAtLocal}，实际 ${actual || '<empty>'}`)
    }
  }

  return failures
}

function assertCaseTasks(testCase, parsedTasks) {
  const expectations = testCase.expectTasks || [testCase.expect]
  const failures = []

  if (parsedTasks.length !== expectations.length) {
    failures.push(`任务数量期望 ${expectations.length}，实际 ${parsedTasks.length}`)
  }

  for (const [index, expectation] of expectations.entries()) {
    const task = parsedTasks[index]
    if (!task) {
      failures.push(`缺少第 ${index + 1} 个任务`)
      continue
    }
    failures.push(...assertCase({ ...testCase, expect: expectation }, task).map((message) => `第 ${index + 1} 个任务：${message}`))
  }

  return failures
}

function printCaseResult(index, testCase, result, failures) {
  const status = failures.length ? 'FAIL' : 'PASS'
  const tasks = result?.tasks || (result?.task ? [result.task] : [])
  console.log(`\n[${status}] ${index + 1}. ${testCase.name}`)
  console.log(`input: ${testCase.input}`)
  if (result) {
    console.log(`endpoint: ${result.endpoint}${result.usedFallback ? ' (fallback)' : ''}`)
    console.log(
      `tasks: ${JSON.stringify(
        tasks.map((task) => ({
          title: task.title,
          status: task.status,
          priority: task.priority,
          project: task.project,
          tags: task.tags,
          dueAt: task.dueAt,
          reminderAt: task.reminderAt,
        })),
        null,
        2,
      )}`,
    )
  }
  for (const failure of failures) console.log(`- ${failure}`)
}

async function main() {
  const settings = loadSettings()
  console.log(
    JSON.stringify(
      {
        dataFile,
        aiEnabled: settings.aiEnabled,
        aiBaseUrl: settings.aiBaseUrl,
        aiModel: settings.aiModel,
        hasApiKey: Boolean(settings.aiApiKey),
        timeoutMs,
        caseCount: testCases.length,
      },
      null,
      2,
    ),
  )

  if (!settings.aiEnabled) {
    throw new Error('Todo Desk 当前未启用 AI 解析')
  }
  if (!settings.aiBaseUrl || !settings.aiModel) {
    throw new Error('AI Base URL 或 Model 未配置')
  }

  await runImagePayloadSmokeTest(settings)
  await runAiMergeSmokeTest(settings)
  await runApiMetadataSmokeTest()

  let failed = 0
  let fallbackCount = 0

  for (const [index, testCase] of testCases.entries()) {
    try {
      const result = await parseTask(testCase.input, settings)
      const failures = assertCaseTasks(testCase, result.tasks || [result.task])
      if (result.usedFallback) fallbackCount += 1
      if (failures.length) failed += 1
      printCaseResult(index, testCase, result, failures)
    } catch (error) {
      failed += 1
      printCaseResult(index, testCase, null, [error instanceof Error ? error.message : String(error)])
    }
  }

  console.log(`\nAI assistant test summary: ${testCases.length - failed}/${testCases.length} passed, fallback used ${fallbackCount} time(s).`)
  if (failed > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
