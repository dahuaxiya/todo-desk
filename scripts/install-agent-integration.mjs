#!/usr/bin/env node

import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')
const markerName = 'todo-desk-agent-bootstrap'
const defaultTargets = ['generic', 'codex', 'claude', 'kimi', 'cursor']

function parseArgs(argv) {
  const options = {
    dryRun: false,
    skipApiCheck: false,
    home: os.homedir(),
    port: 47731,
    targets: defaultTargets,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--skip-api-check') options.skipApiCheck = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--home') options.home = argv[++index]
    else if (arg === '--port') options.port = Number(argv[++index])
    else if (arg === '--targets') options.targets = argv[++index].split(',').map((item) => item.trim()).filter(Boolean)
    else throw new Error(`Unknown option: ${arg}`)
  }

  return options
}

function usage() {
  return `Usage: node scripts/install-agent-integration.mjs [options]

Options:
  --dry-run            Print planned changes without writing files.
  --targets <list>     Comma list: generic,codex,claude,kimi,cursor.
  --home <path>        Override home directory for testing.
  --port <number>      Todo Desk API port. Default: 47731.
  --skip-api-check     Do not check http://127.0.0.1:<port>/health.
  -h, --help           Show this help.
`
}

function expandHome(value, homeDir) {
  if (!value) return value
  if (value === '~') return homeDir
  if (value.startsWith('~/')) return join(homeDir, value.slice(2))
  return value
}

function isTarget(options, name) {
  return options.targets.includes(name)
}

function instructionBlock(sharedSkillDir) {
  const addScript = join(sharedSkillDir, 'scripts', 'add_work.py')
  const updateScript = join(sharedSkillDir, 'scripts', 'update_task.py')

  return `## Todo Desk 工作挂载

每次开始处理用户明确交办的工作时，先使用 Todo Desk 记录当前工作，并使用当前工具名作为 \`agent\`，例如 \`codex\`、\`claude\`、\`kimi\`、\`cursor\`。

优先使用本机脚本：

\`\`\`bash
python3 ${addScript} \\
  --title "<当前工作标题>" \\
  --detail "<用户要求、当前判断和下一步>" \\
  --status doing \\
  --priority medium \\
  --project "<项目或仓库名>" \\
  --tags "<agent>,<session-id>,todo-desk" \\
  --agent "<agent>" \\
  --agent-session-id "<session-id>" \\
  --repository "<repo-name>" \\
  --repository-path "<repo-path>" \\
  --parent-task-id "<可选：明确的直接上级任务 id>" \\
  --relation-type "<subtask_of 或 discovered_from>" \\
  --relation-reason "<派生问题的来源说明>" \\
  --affects-parent-completion
\`\`\`

推进工作时更新同一个任务：

\`\`\`bash
python3 ${updateScript} \\
  --task-id "<todo-desk-task-id>" \\
  --status doing \\
  --append-detail "<进展或验证结果>" \\
  --agent "<agent>" \\
  --agent-session-id "<session-id>" \\
  --repository "<repo-name>" \\
  --repository-path "<repo-path>"
\`\`\`

执行过程中自动识别派生任务：
- 发现新的独立问题时立即判断，不必等用户要求拆分。只有该问题有独立交付结果、不是当前任务的常规步骤，并且可以单独分配/延期/完成或会影响父任务验收时，才自动创建派生卡片。
- 当前任务的 Todo Desk task id 必须保留自首次 \`add_work.py\` 返回值，并作为 \`--parent-task-id\`。拿不到明确 id 时不得根据标题、仓库、标签或 session 猜父子关系。
- 创建前先通过 \`GET /tasks\` 检查当前父任务已有的未完成子卡；同一问题已经存在时更新原卡，不重复创建。
- 立即处理的新问题使用 \`--status doing\`，暂不处理使用 \`--status todo\`；固定传 \`--relation-type discovered_from\` 和具体的 \`--relation-reason\`。
- 父任务不解决该问题就不能验收时传 \`--affects-parent-completion\`；可以独立后续处理时传 \`--follow-up-only\`。
- 不要为同一问题的改代码、补测试、跑构建、常规重构、根因记录或即时解决的临时错误创建派生卡片。

实现完成但用户还没有确认时，请求完成审批，不要直接写 \`done\`：

\`\`\`bash
python3 ${updateScript} \\
  --task-id "<todo-desk-task-id>" \\
  --request-completion \\
  --append-detail "实现已完成，等待用户确认是否标记 done" \\
  --agent "<agent>" \\
  --agent-session-id "<session-id>" \\
  --repository "<repo-name>" \\
  --repository-path "<repo-path>"
\`\`\`

当前 session 本轮输出已经完成，但 agent 判断任务尚未完成时，请求未完成提醒，不要把它当作完成审批：

\`\`\`bash
python3 ${updateScript} \\
  --task-id "<todo-desk-task-id>" \\
  --request-session-review \\
  --session-review-message "本轮 session 输出完成，但任务尚未完成" \\
  --agent "<agent>" \\
  --agent-session-id "<session-id>" \\
  --repository "<repo-name>" \\
  --repository-path "<repo-path>"
\`\`\`

用户明确确认完成后，才允许写入 \`done\`：

\`\`\`bash
python3 ${updateScript} \\
  --task-id "<todo-desk-task-id>" \\
  --status done \\
  --user-confirmed-completion \\
  --append-detail "<用户已确认完成>" \\
  --agent "<agent>" \\
  --agent-session-id "<session-id>" \\
  --repository "<repo-name>" \\
  --repository-path "<repo-path>"
\`\`\`

要求：
- \`session-id\` 必须来自当前运行时，不要编造；常见来源包括 \`CODEX_THREAD_ID\`、\`CLAUDE_SESSION_ID\`、\`KIMI_SESSION_ID\`、\`CURSOR_SESSION_ID\` 或该工具暴露的等价会话/线程 id。
- 创建任务时 \`tags\` 至少包含当前 \`agent\` 和 \`session-id\`，并同时传 \`--agent\` 与 \`--agent-session-id\`。
- \`add_work.py\` 会显式写入 \`origin.kind=agent\` 和 \`origin.channel=todo-desk-skill\`；不要只靠 \`source\`、\`repository\` 等上下文字段表达任务来源。
- 计划内拆分使用 \`--parent-task-id <当前任务 id> --relation-type subtask_of\`；处理中自动识别出的独立新问题使用 \`--relation-type discovered_from --relation-reason <派生原因>\`。
- 是否影响父任务完成必须按验收条件判断：阻塞父任务验收使用 \`--affects-parent-completion\`，可独立后续处理使用 \`--follow-up-only\`。
- 只有直接上级任务 id 明确可得时才建立关系，不要根据标题、项目、标签、仓库或相同 session 猜测。session id 只记录执行来源，不表达任务层级。
- 拿不到 \`session-id\`、Todo Desk 未启动或 API 不可用时，不要假装成功；直接告诉用户当前 Todo Desk 挂载阻塞。
- 只有用户明确同意完成时，才能把任务状态更新为 \`done\`，并且必须传 \`--user-confirmed-completion\`。
- 未获确认但实现已经完成时，只能传 \`--request-completion\`；Todo Desk 会显示红色提醒点，等待用户确认完成。
- 本轮 session 输出完成但任务尚未完成时，传 \`--request-session-review\`；Todo Desk 会显示非红色提醒点，直到用户点击“已查看”或“查看会话”。
`
}

function cursorRule(sharedSkillDir) {
  return `---
description: Use Todo Desk to track explicit user-assigned agent work
alwaysApply: true
---

${instructionBlock(sharedSkillDir)}
`
}

async function readText(filePath) {
  try {
    return await readFile(filePath, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return ''
    throw error
  }
}

async function writeTextIfChanged(filePath, content, options, summary) {
  const current = await readText(filePath)
  if (current === content) {
    summary.unchanged.push(filePath)
    return
  }

  summary.writes.push(filePath)
  if (options.dryRun) return

  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, content, 'utf8')
}

async function upsertManagedBlock(filePath, block, options, summary) {
  const start = `<!-- ${markerName}:start -->`
  const end = `<!-- ${markerName}:end -->`
  const managed = `${start}\n${block.trim()}\n${end}`
  const current = await readText(filePath)
  const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`)
  const next = pattern.test(current)
    ? current.replace(pattern, managed)
    : `${current.trimEnd()}${current.trim() ? '\n\n' : ''}${managed}\n`

  await writeTextIfChanged(filePath, next, options, summary)
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function copySkillTo(destination, options, summary) {
  const source = join(repoRoot, 'skills', 'todo-desk')
  summary.skillCopies.push(destination)
  if (options.dryRun) return

  await mkdir(dirname(destination), { recursive: true })
  await cp(source, destination, { recursive: true, force: true })
}

async function checkApi(port) {
  return new Promise((resolve) => {
    const request = http.get(
      {
        host: '127.0.0.1',
        port,
        path: '/health',
        timeout: 1600,
      },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          body += chunk
        })
        response.on('end', () => {
          resolve({ ok: response.statusCode === 200, status: response.statusCode, body })
        })
      },
    )
    request.on('timeout', () => {
      request.destroy(new Error('timeout'))
    })
    request.on('error', (error) => {
      resolve({ ok: false, error: error.message })
    })
  })
}

function parseTomlStringArray(value) {
  const matches = [...value.matchAll(/"([^"]+)"/g)]
  return matches.map((match) => match[1])
}

async function getKimiExtraSkillDirs(homeDir) {
  const configPath = join(homeDir, '.kimi-code', 'config.toml')
  const fallbackDir = join(homeDir, '.kimi', 'extra-skills')
  const config = await readText(configPath)
  const match = config.match(/^extra_skill_dirs\s*=\s*\[([^\]]*)\]/m)
  const configuredDirs = match ? parseTomlStringArray(match[1]).map((item) => expandHome(item, homeDir)) : []
  return {
    configPath,
    fallbackDir,
    dirs: [...new Set([...configuredDirs, fallbackDir])],
  }
}

async function ensureKimiConfig(homeDir, options, summary) {
  const { configPath, fallbackDir, dirs } = await getKimiExtraSkillDirs(homeDir)
  const current = await readText(configPath)
  const line = `extra_skill_dirs = [ ${dirs.map((item) => `"${item}"`).join(', ')} ]`
  const next = current.match(/^extra_skill_dirs\s*=\s*\[[^\]]*\]/m)
    ? current.replace(/^extra_skill_dirs\s*=\s*\[[^\]]*\]/m, line)
    : `${current.trimEnd()}${current.trim() ? '\n' : ''}${line}\n`

  await writeTextIfChanged(configPath, next, options, summary)
  return { fallbackDir, dirs }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(usage())
    return
  }

  const homeDir = resolve(expandHome(options.home, os.homedir()))
  const sharedSkillDir = join(homeDir, '.agents', 'skills', 'todo-desk')
  const block = instructionBlock(sharedSkillDir)
  const summary = {
    homeDir,
    targets: options.targets,
    dryRun: options.dryRun,
    api: null,
    skillCopies: [],
    writes: [],
    unchanged: [],
    warnings: [],
  }

  if (!options.skipApiCheck) {
    summary.api = await checkApi(options.port)
    if (!summary.api.ok) {
      summary.warnings.push(`Todo Desk API is not healthy on 127.0.0.1:${options.port}; config can be installed, but agents cannot create tasks until the app/API is running.`)
    }
  }

  if (isTarget(options, 'generic')) {
    await copySkillTo(sharedSkillDir, options, summary)
    await upsertManagedBlock(join(homeDir, '.agents', 'AGENTS.md'), block, options, summary)
  }

  if (isTarget(options, 'codex')) {
    await copySkillTo(join(homeDir, '.codex', 'skills', 'todo-desk'), options, summary)
    await upsertManagedBlock(join(homeDir, '.codex', 'AGENTS.md'), block, options, summary)
  }

  if (isTarget(options, 'claude')) {
    await copySkillTo(join(homeDir, '.claude', 'skills', 'todo-desk'), options, summary)
    await upsertManagedBlock(join(homeDir, '.claude', 'CLAUDE.md'), block, options, summary)
  }

  if (isTarget(options, 'kimi')) {
    const kimi = await ensureKimiConfig(homeDir, options, summary)
    for (const dir of kimi.dirs) {
      await copySkillTo(join(dir, 'todo-desk'), options, summary)
    }
    await upsertManagedBlock(join(homeDir, '.kimi-code', 'AGENTS.md'), block, options, summary)
  }

  if (isTarget(options, 'cursor')) {
    await copySkillTo(join(homeDir, '.cursor', 'skills-cursor', 'todo-desk'), options, summary)
    await writeTextIfChanged(join(homeDir, '.cursor', 'rules', 'todo-desk.mdc'), cursorRule(sharedSkillDir), options, summary)
  }

  console.log(JSON.stringify(summary, null, 2))
}

main().catch((error) => {
  console.error(error.stack || error.message)
  process.exitCode = 1
})
