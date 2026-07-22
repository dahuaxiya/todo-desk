import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const repoRoot = resolve(import.meta.dirname, '..')
const addWorkScript = join(repoRoot, 'skills', 'todo-desk', 'scripts', 'add_work.py')
const checkSessionScript = join(repoRoot, 'skills', 'todo-desk', 'scripts', 'check_session.py')
const installerScript = join(repoRoot, 'scripts', 'install-agent-integration.mjs')

async function run(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, { cwd: repoRoot, ...options })
    return { code: 0, ...result }
  } catch (error) {
    return { code: error.code, stdout: error.stdout || '', stderr: error.stderr || '' }
  }
}

async function withJsonServer(handler, callback) {
  const server = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
    const value = await handler(request, body)
    response.writeHead(value.status || 200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(value.body))
  })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  const port = server.address().port
  try {
    await callback(port)
  } finally {
    await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()))
  }
}

test('add_work requires one relationship mode and emits structured evidence', async () => {
  const missingMode = await run('python3', [addWorkScript, '--title', 'Missing relationship mode'])
  assert.notEqual(missingMode.code, 0)
  assert.match(missingMode.stderr, /one of the arguments --parent-task-id --independent-root --parent-unresolved is required/)

  const missingReason = await run('python3', [addWorkScript, '--title', 'Missing reason', '--independent-root'])
  assert.equal(missingReason.code, 2)
  assert.match(missingReason.stderr, /relationship decision reason is required/i)

  const emptyParent = await run('python3', [
    addWorkScript,
    '--title', 'Empty parent',
    '--parent-task-id', '',
    '--parent-decision-reason', 'Should not bypass the explicit root choices',
  ])
  assert.equal(emptyParent.code, 2)
  assert.match(emptyParent.stderr, /--parent-task-id cannot be empty/)

  let captured
  await withJsonServer(async (_request, body) => {
    captured = body
    return { status: 201, body: { ok: true, task: body } }
  }, async (port) => {
    const result = await run('python3', [
      addWorkScript,
      '--title', 'Explicit unresolved task',
      '--agent', 'codex',
      '--agent-session-id', 'session-v2',
      '--parent-unresolved',
      '--parent-decision-reason', 'Two candidates are equally plausible',
      '--parent-candidate-ids', 'candidate-a,candidate-b,candidate-a',
      '--port', String(port),
    ])
    assert.equal(result.code, 0, result.stderr)
  })

  assert.equal(captured.relationshipState, 'unresolved')
  assert.equal(captured.relationshipDecision.state, 'unresolved')
  assert.deepEqual(captured.relationshipDecision.candidateTaskIds, ['candidate-a', 'candidate-b'])
  assert.equal(captured.origin.client.version, '2')
})

test('session checker reports missing coverage once and accepts valid v2 decisions', async () => {
  const sessionId = `session-check-${Date.now()}`
  let searchTasks = []
  await withJsonServer(async (request, body) => {
    assert.equal(request.url, '/tasks/search')
    assert.equal(body.agentSessionId, sessionId)
    return { body: { ok: true, tasks: searchTasks } }
  }, async (port) => {
    const args = [checkSessionScript, '--hook-source', 'kimi', '--agent-session-id', sessionId, '--port', String(port)]
    const first = await run('python3', args)
    assert.equal(first.code, 2)
    assert.match(first.stderr, /没有任务/)
    const second = await run('python3', args)
    assert.equal(second.code, 0)

    searchTasks = [{
      id: 'task-1',
      title: 'Classified task',
      parentTaskId: '',
      relationshipState: 'independent_root',
      relationshipDecision: { state: 'independent_root', reason: 'Independent user request' },
      originClientVersion: '2',
    }]
    const valid = await run('python3', args)
    assert.equal(valid.code, 0, valid.stderr)
  })
})

test('installer preserves existing hooks and is idempotent', async () => {
  const home = await mkdtemp(join(os.tmpdir(), 'todo-desk-agent-home-'))
  try {
    await Promise.all([
      mkdir(join(home, '.codex'), { recursive: true }),
      mkdir(join(home, '.claude'), { recursive: true }),
      mkdir(join(home, '.cursor'), { recursive: true }),
      mkdir(join(home, '.kimi-code'), { recursive: true }),
    ])
    await Promise.all([
      writeFile(join(home, '.codex', 'config.toml'), 'model = "test"\nnotify = ["/usr/bin/printf", "existing"]\n'),
      writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'existing-claude-hook' }] }] } })),
      writeFile(join(home, '.cursor', 'hooks.json'), JSON.stringify({ version: 1, hooks: { afterFileEdit: [{ command: 'existing-cursor-hook' }] } })),
      writeFile(join(home, '.kimi-code', 'config.toml'), 'hooks = []\nextra_skill_dirs = []\n'),
    ])

    const args = [installerScript, '--home', home, '--skip-api-check']
    const first = await run('node', args)
    assert.equal(first.code, 0, first.stderr)
    const firstSummary = JSON.parse(first.stdout)
    assert.equal(firstSummary.hooks.length, 4)

    const codexConfig = await readFile(join(home, '.codex', 'config.toml'), 'utf8')
    const delegate = JSON.parse(await readFile(join(home, '.codex', 'todo-desk-notify-delegate.json'), 'utf8'))
    assert.match(codexConfig, /check_session\.py/)
    assert.deepEqual(delegate.command, ['/usr/bin/printf', 'existing'])

    const claude = JSON.parse(await readFile(join(home, '.claude', 'settings.json'), 'utf8'))
    assert.ok(claude.hooks.Stop.some((group) => group.hooks.some((hook) => hook.command === 'existing-claude-hook')))
    assert.equal(claude.hooks.Stop.flatMap((group) => group.hooks).filter((hook) => hook.command.includes('check_session.py')).length, 1)

    const cursor = JSON.parse(await readFile(join(home, '.cursor', 'hooks.json'), 'utf8'))
    assert.equal(cursor.hooks.afterFileEdit[0].command, 'existing-cursor-hook')
    assert.equal(cursor.hooks.stop.filter((hook) => hook.command.includes('check_session.py')).length, 1)

    const kimi = await readFile(join(home, '.kimi-code', 'config.toml'), 'utf8')
    assert.doesNotMatch(kimi, /^hooks\s*=\s*\[\s*\]/m)
    assert.match(kimi, /\[\[hooks\]\][\s\S]*event = "Stop"[\s\S]*check_session\.py/)

    const trackedFiles = [
      join(home, '.codex', 'config.toml'),
      join(home, '.claude', 'settings.json'),
      join(home, '.cursor', 'hooks.json'),
      join(home, '.kimi-code', 'config.toml'),
    ]
    const beforeSecondRun = await Promise.all(trackedFiles.map((file) => readFile(file, 'utf8')))
    const second = await run('node', args)
    assert.equal(second.code, 0, second.stderr)
    const afterSecondRun = await Promise.all(trackedFiles.map((file) => readFile(file, 'utf8')))
    assert.deepEqual(afterSecondRun, beforeSecondRun)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
