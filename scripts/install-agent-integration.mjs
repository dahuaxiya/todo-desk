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
  --repository-path "<repo-path>"
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

要求：
- \`session-id\` 必须来自当前运行时，不要编造；常见来源包括 \`CODEX_THREAD_ID\`、\`CLAUDE_SESSION_ID\`、\`KIMI_SESSION_ID\`、\`CURSOR_SESSION_ID\` 或该工具暴露的等价会话/线程 id。
- 创建任务时 \`tags\` 至少包含当前 \`agent\` 和 \`session-id\`，并同时传 \`--agent\` 与 \`--agent-session-id\`。
- 拿不到 \`session-id\`、Todo Desk 未启动或 API 不可用时，不要假装成功；直接告诉用户当前 Todo Desk 挂载阻塞。
- 只有用户明确同意完成时，才能把任务状态更新为 \`done\`。
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
