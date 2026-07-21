import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createBackupManager, parseRepositoryMarkdown, selectRetainedBackups } from '../electron/backup-manager.js'

test('加密完整备份可以恢复数据、密钥设置和附件', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'todo-desk-backup-test-'))
  const paths = {
    userData,
    dataFile: join(userData, 'todo-desk-data.json'),
    attachmentDir: join(userData, 'attachments'),
  }
  const original = {
    version: 2,
    settings: { aiApiKey: 'secret-key', larkDoc: 'doc-token' },
    tasks: [{ id: 'task-1', title: '原始任务' }],
    trash: [],
    syncLog: [],
  }
  let currentData = original
  await mkdir(paths.attachmentDir, { recursive: true })
  await writeFile(paths.dataFile, JSON.stringify(original), 'utf8')
  await writeFile(join(paths.attachmentDir, 'proof.png'), Buffer.from('image-body'))

  const manager = createBackupManager({
    paths,
    getData: async () => currentData,
    saveData: async (data) => {
      currentData = data
      await writeFile(paths.dataFile, JSON.stringify(data), 'utf8')
      return data
    },
    protectSecret: async (value) => ({ protected: false, value }),
    unprotectSecret: async (value) => value,
  })

  const created = await manager.createBackup({ localOnly: true, force: true })
  currentData = { ...original, settings: { aiApiKey: 'changed' }, tasks: [] }
  await writeFile(paths.dataFile, JSON.stringify(currentData), 'utf8')
  await writeFile(join(paths.attachmentDir, 'proof.png'), Buffer.from('changed-image'))

  const restored = await manager.restoreBackup(created.backup.id)
  assert.equal(restored.ok, true)
  assert.equal(currentData.settings.aiApiKey, 'secret-key')
  assert.equal(currentData.tasks[0].title, '原始任务')
  assert.equal((await readFile(join(paths.attachmentDir, 'proof.png'))).toString(), 'image-body')
  assert.ok((await manager.exportRecoveryKey()).length > 30)
  await rm(userData, { recursive: true, force: true })
})

test('本地备份轮转保留最近数量并跳过未变化数据', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'todo-desk-backup-retention-'))
  const paths = { userData, dataFile: join(userData, 'todo-desk-data.json'), attachmentDir: join(userData, 'attachments') }
  const data = { version: 2, settings: {}, tasks: [], trash: [], syncLog: [] }
  await mkdir(paths.attachmentDir, { recursive: true })
  await writeFile(paths.dataFile, JSON.stringify(data), 'utf8')
  const manager = createBackupManager({ paths, getData: async () => data, saveData: async (value) => value, protectSecret: async (value) => ({ protected: false, value }), unprotectSecret: async (value) => value })
  const first = await manager.createBackup({ localOnly: true, recentCount: 3, dailyCount: 0 })
  const skipped = await manager.createBackup({ localOnly: true, recentCount: 3, dailyCount: 0 })
  assert.equal(first.skipped, undefined)
  assert.equal(skipped.skipped, true)
  for (let index = 0; index < 4; index += 1) {
    await manager.createBackup({ localOnly: true, recentCount: 3, dailyCount: 0, force: true })
    await new Promise((resolve) => setTimeout(resolve, 3))
  }
  assert.equal((await manager.getStatus()).backups.length, 3)
  await rm(userData, { recursive: true, force: true })
})

test('分层保留选择 4 个近期版本和前 2 天的每日版本', () => {
  const records = [
    ['today-4', '2026-07-21T09:00:00+08:00'],
    ['today-3', '2026-07-21T08:30:00+08:00'],
    ['today-2', '2026-07-21T08:00:00+08:00'],
    ['today-1', '2026-07-21T07:30:00+08:00'],
    ['day-1-new', '2026-07-20T22:00:00+08:00'],
    ['day-1-old', '2026-07-20T09:00:00+08:00'],
    ['day-2-new', '2026-07-19T21:00:00+08:00'],
    ['day-3-new', '2026-07-18T21:00:00+08:00'],
  ].map(([id, createdAt]) => ({ id, createdAt }))
  const kept = selectRetainedBackups(records, 4, 2, new Date('2026-07-21T12:00:00+08:00'))
  assert.deepEqual(kept.map((item) => item.id), ['today-4', 'today-3', 'today-2', 'today-1', 'day-1-new', 'day-2-new'])
})

test('稳定仓库恢复码文档可以解析版本索引', () => {
  const parsed = parseRepositoryMarkdown([
    '# Todo Desk Backup Repository',
    '```json',
    JSON.stringify({ format: 'todo-desk-repository', version: 1, folderToken: 'folder-token', backups: [{ id: 'backup-1' }] }),
    '```',
  ].join('\n'))
  assert.equal(parsed.folderToken, 'folder-token')
  assert.equal(parsed.backups[0].id, 'backup-1')
})
