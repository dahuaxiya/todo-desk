import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createBackupManager } from '../electron/backup-manager.js'

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

  const created = await manager.createBackup({ localOnly: true, retentionCount: 8 })
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

test('本地备份轮转只保留最近数量', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'todo-desk-backup-retention-'))
  const paths = { userData, dataFile: join(userData, 'todo-desk-data.json'), attachmentDir: join(userData, 'attachments') }
  const data = { version: 2, settings: {}, tasks: [], trash: [], syncLog: [] }
  await mkdir(paths.attachmentDir, { recursive: true })
  await writeFile(paths.dataFile, JSON.stringify(data), 'utf8')
  const manager = createBackupManager({ paths, getData: async () => data, saveData: async (value) => value, protectSecret: async (value) => ({ protected: false, value }), unprotectSecret: async (value) => value })
  for (let index = 0; index < 4; index += 1) {
    await manager.createBackup({ localOnly: true, retentionCount: 3 })
    await new Promise((resolve) => setTimeout(resolve, 3))
  }
  assert.equal((await manager.getStatus()).backups.length, 3)
  await rm(userData, { recursive: true, force: true })
})
