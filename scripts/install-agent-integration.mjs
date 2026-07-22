#!/usr/bin/env node

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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
  const searchScript = join(sharedSkillDir, 'scripts', 'search_tasks.py')
  const updateScript = join(sharedSkillDir, 'scripts', 'update_task.py')

  return `## Todo Desk 工作挂载

每次开始处理用户明确交办的工作时，先使用 Todo Desk 记录当前工作，并使用当前工具名作为 \`agent\`，例如 \`codex\`、\`claude\`、\`kimi\`、\`cursor\`。

Todo Desk 只提供通用任务搜索能力，是否存在父子关系以及如何关联由 agent 自己判断。创建 AI 任务前先查当前 session 已绑定的任务：

\`\`\`bash
python3 ${searchScript} \\
  --agent-session-id "<session-id>" \\
  --limit 10
\`\`\`

如果 session 查询不能明确找到相关任务，再由 agent 使用当前工作标题和有区分度的详情做模糊搜索；仓库、项目、状态、来源、agent 和标签只是可选过滤条件：

\`\`\`bash
python3 ${searchScript} \\
  --query "<当前工作标题和关键详情>" \\
  --repository-path "<repo-path>" \\
  --limit 12
\`\`\`

- 搜索接口只执行通用精确过滤和模糊匹配，返回少量任务摘要，不判断父任务。
- agent 必须结合搜索结果与当前对话自行判断最近一级直接父任务；session 命中和模糊分数不能单独证明父子关系。
- 过滤条件没有结果时应放宽条件重试；摘要不足时只读取 \`GET /tasks/<task-id>\` 的单条详情，不得读取完整任务列表进入模型上下文。
- 能明确判断时创建 AI 卡片传 \`--parent-task-id\`；计划内拆分使用 \`subtask_of\`，执行中发现的独立问题使用 \`discovered_from\`。无法可靠判断时不得强行关联。
- 每次创建必须明确三选一：\`--parent-task-id\`、\`--independent-root\` 或 \`--parent-unresolved\`。不能省略关系决策。
- 使用 \`--parent-decision-reason\` 记录判断依据；把实际查看过的候选任务 id 通过 \`--parent-candidate-ids\` 传入，多个 id 用逗号分隔。

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
  --parent-task-id "<明确的直接上级任务 id>" \\
  --relation-type "<subtask_of 或 discovered_from>" \\
  --relation-reason "<派生问题的来源说明>" \\
  --parent-decision-reason "<为什么它是直接父任务>" \\
  --parent-candidate-ids "<检索过的候选任务 id>" \\
  --affects-parent-completion
\`\`\`

没有父任务时必须明确选择一种根任务状态：

\`\`\`bash
# 明确属于独立根任务
python3 ${addScript} ... --independent-root --parent-decision-reason "<独立原因>" --parent-candidate-ids "<候选 id>"

# 已搜索但目前无法可靠判断，保留在待归类
python3 ${addScript} ... --parent-unresolved --parent-decision-reason "<无法判断的原因>" --parent-candidate-ids "<候选 id>"
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
- \`add_work.py\` 会拒绝没有关系三态、判断理由的创建请求；不要用原始 HTTP 请求绕过。
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

function upsertHashBlockContent(current, name, block) {
  const start = `# ${name}:start`
  const end = `# ${name}:end`
  const managed = `${start}\n${block.trim()}\n${end}`
  const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`)
  return pattern.test(current)
    ? current.replace(pattern, managed)
    : `${current.trimEnd()}${current.trim() ? '\n\n' : ''}${managed}\n`
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

function sessionCheckCommand(skillDir, source, port) {
  const scriptPath = join(skillDir, 'scripts', 'check_session.py')
  return ['python3', shellQuote(scriptPath), '--hook-source', source, '--agent', source, '--port', String(port)].join(' ')
}

async function readJsonObject(filePath, summary) {
  const raw = await readText(filePath)
  if (!raw.trim()) return {}
  try {
    const value = JSON.parse(raw)
    if (value && typeof value === 'object' && !Array.isArray(value)) return value
  } catch (error) {
    summary.warnings.push(`Cannot update invalid JSON config ${filePath}: ${error.message}`)
  }
  return null
}

function isTodoDeskHookCommand(value) {
  return typeof value === 'string' && value.includes('todo-desk') && value.includes('check_session.py')
}

async function upsertClaudeStopHook(homeDir, skillDir, options, summary) {
  const filePath = join(homeDir, '.claude', 'settings.json')
  const config = await readJsonObject(filePath, summary)
  if (!config) return
  const stopGroups = Array.isArray(config.hooks?.Stop) ? config.hooks.Stop : []
  const cleanedGroups = stopGroups
    .map((group) => ({
      ...group,
      hooks: Array.isArray(group.hooks)
        ? group.hooks.filter((hook) => !isTodoDeskHookCommand(hook?.command))
        : [],
    }))
    .filter((group) => group.hooks.length > 0)
  const hook = {
    hooks: [{
      type: 'command',
      command: sessionCheckCommand(skillDir, 'claude', options.port),
      timeout: 8,
    }],
  }
  const next = {
    ...config,
    hooks: {
      ...(config.hooks || {}),
      Stop: [...cleanedGroups, hook],
    },
  }
  summary.hooks.push({ target: 'claude', event: 'Stop', filePath })
  await writeTextIfChanged(filePath, `${JSON.stringify(next, null, 2)}\n`, options, summary)
}

async function upsertCursorStopHook(homeDir, skillDir, options, summary) {
  const filePath = join(homeDir, '.cursor', 'hooks.json')
  const config = await readJsonObject(filePath, summary)
  if (!config) return
  const stopHooks = Array.isArray(config.hooks?.stop) ? config.hooks.stop : []
  const hook = {
    type: 'command',
    command: sessionCheckCommand(skillDir, 'cursor', options.port),
    timeout: 8,
    failClosed: false,
    loop_limit: 1,
  }
  const next = {
    ...config,
    version: 1,
    hooks: {
      ...(config.hooks || {}),
      stop: [...stopHooks.filter((item) => !isTodoDeskHookCommand(item?.command)), hook],
    },
  }
  summary.hooks.push({ target: 'cursor', event: 'stop', filePath })
  await writeTextIfChanged(filePath, `${JSON.stringify(next, null, 2)}\n`, options, summary)
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function copySkillTo(destination, options, summary) {
  const source = join(repoRoot, 'skills', 'todo-desk')
  summary.skillCopies.push(destination)
  if (options.dryRun) return

  await mkdir(dirname(destination), { recursive: true })
  // Remove the superseded parent-specific helper so upgraded agents only see the generic search tool.
  await rm(join(destination, 'scripts', 'find_parent_candidates.py'), { force: true })
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

function parseTopLevelNotify(config) {
  const match = config.match(/^notify\s*=\s*(\[[^\n]*\])\s*$/m)
  if (!match) return { match: null, command: [] }
  return { match, command: parseTomlStringArray(match[1]) }
}

async function upsertCodexNotifyHook(homeDir, skillDir, options, summary) {
  const configPath = join(homeDir, '.codex', 'config.toml')
  const delegatePath = join(homeDir, '.codex', 'todo-desk-notify-delegate.json')
  const current = await readText(configPath)
  const notify = parseTopLevelNotify(current)
  if (/^notify\s*=/m.test(current) && (!notify.match || notify.command.length === 0)) {
    summary.warnings.push(`Cannot safely parse Codex notify in ${configPath}; Todo Desk notify hook was not installed.`)
    return
  }

  if (notify.command.length > 0 && !notify.command.some((item) => item.includes('check_session.py'))) {
    await writeTextIfChanged(delegatePath, `${JSON.stringify({ command: notify.command }, null, 2)}\n`, options, summary)
  }
  const scriptPath = join(skillDir, 'scripts', 'check_session.py')
  const command = [
    'python3',
    scriptPath,
    '--hook-source',
    'codex',
    '--agent',
    'codex',
    '--port',
    String(options.port),
    '--delegate-config',
    delegatePath,
  ]
  const line = `notify = ${JSON.stringify(command)}`
  const next = notify.match
    ? current.replace(notify.match[0], line)
    : `${line}\n${current}`
  summary.hooks.push({ target: 'codex', event: 'agent-turn-complete notify', filePath: configPath })
  await writeTextIfChanged(configPath, next, options, summary)
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

async function ensureKimiConfig(homeDir, skillDir, options, summary) {
  const { configPath, fallbackDir, dirs } = await getKimiExtraSkillDirs(homeDir)
  const current = await readText(configPath)
  const line = `extra_skill_dirs = [ ${dirs.map((item) => `"${item}"`).join(', ')} ]`
  const withSkillDirs = current.match(/^extra_skill_dirs\s*=\s*\[[^\]]*\]/m)
    ? current.replace(/^extra_skill_dirs\s*=\s*\[[^\]]*\]/m, line)
    : `${current.trimEnd()}${current.trim() ? '\n' : ''}${line}\n`
  // Older Kimi versions wrote an empty inline array. TOML forbids defining the same array again
  // with [[hooks]], so remove only the provably empty legacy declaration and preserve real hooks.
  const withoutEmptyLegacyHooks = withSkillDirs.replace(/^hooks\s*=\s*\[\s*\]\s*\n?/m, '')
  const hookBlock = `[[hooks]]
event = "Stop"
command = ${JSON.stringify(sessionCheckCommand(skillDir, 'kimi', options.port))}
timeout = 8`
  const next = upsertHashBlockContent(withoutEmptyLegacyHooks, 'todo-desk-session-hook', hookBlock)

  summary.hooks.push({ target: 'kimi', event: 'Stop', filePath: configPath })
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
  const summary = {
    homeDir,
    targets: options.targets,
    dryRun: options.dryRun,
    api: null,
    skillCopies: [],
    writes: [],
    unchanged: [],
    hooks: [],
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
    await upsertManagedBlock(join(homeDir, '.agents', 'AGENTS.md'), instructionBlock(sharedSkillDir), options, summary)
  }

  if (isTarget(options, 'codex')) {
    const codexSkillDir = join(homeDir, '.codex', 'skills', 'todo-desk')
    await copySkillTo(codexSkillDir, options, summary)
    await upsertManagedBlock(join(homeDir, '.codex', 'AGENTS.md'), instructionBlock(codexSkillDir), options, summary)
    await upsertCodexNotifyHook(homeDir, codexSkillDir, options, summary)
  }

  if (isTarget(options, 'claude')) {
    const claudeSkillDir = join(homeDir, '.claude', 'skills', 'todo-desk')
    await copySkillTo(claudeSkillDir, options, summary)
    await upsertManagedBlock(join(homeDir, '.claude', 'CLAUDE.md'), instructionBlock(claudeSkillDir), options, summary)
    await upsertClaudeStopHook(homeDir, claudeSkillDir, options, summary)
  }

  if (isTarget(options, 'kimi')) {
    const kimi = await getKimiExtraSkillDirs(homeDir)
    const kimiSkillDir = join(kimi.fallbackDir, 'todo-desk')
    for (const dir of kimi.dirs) {
      await copySkillTo(join(dir, 'todo-desk'), options, summary)
    }
    await ensureKimiConfig(homeDir, kimiSkillDir, options, summary)
    await upsertManagedBlock(join(homeDir, '.kimi-code', 'AGENTS.md'), instructionBlock(kimiSkillDir), options, summary)
  }

  if (isTarget(options, 'cursor')) {
    const cursorSkillDir = join(homeDir, '.cursor', 'skills-cursor', 'todo-desk')
    await copySkillTo(cursorSkillDir, options, summary)
    await writeTextIfChanged(join(homeDir, '.cursor', 'rules', 'todo-desk.mdc'), cursorRule(cursorSkillDir), options, summary)
    await upsertCursorStopHook(homeDir, cursorSkillDir, options, summary)
  }

  console.log(JSON.stringify(summary, null, 2))
}

main().catch((error) => {
  console.error(error.stack || error.message)
  process.exitCode = 1
})
