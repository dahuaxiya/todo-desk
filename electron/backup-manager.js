import { spawn } from 'node:child_process'
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { gzip, gunzip } from 'node:zlib'
import { promisify } from 'node:util'

const gzipAsync = promisify(gzip)
const gunzipAsync = promisify(gunzip)
const backupMagic = Buffer.from('TDBKUP01')
const cloudPartLimitBytes = 18 * 1024 * 1024

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function formatError(error, fallback) {
  return error instanceof Error ? error.message : fallback
}

async function listAttachmentFiles(attachmentDir) {
  if (!existsSync(attachmentDir)) return []
  const entries = await readdir(attachmentDir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const filePath = join(attachmentDir, entry.name)
    const body = await readFile(filePath)
    files.push({ name: entry.name, bytes: body.byteLength, sha256: sha256(body), data: body.toString('base64') })
  }
  return files
}

function encryptPayload(payload, key) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()])
  return Buffer.concat([backupMagic, iv, cipher.getAuthTag(), ciphertext])
}

function decryptPayload(container, key) {
  if (!container.subarray(0, backupMagic.length).equals(backupMagic)) throw new Error('不是有效的 Todo Desk 备份文件')
  const ivStart = backupMagic.length
  const tagStart = ivStart + 12
  const bodyStart = tagStart + 16
  const decipher = createDecipheriv('aes-256-gcm', key, container.subarray(ivStart, tagStart))
  decipher.setAuthTag(container.subarray(tagStart, bodyStart))
  return Buffer.concat([decipher.update(container.subarray(bodyStart)), decipher.final()])
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout: stdout.trim(), stderr: stderr.trim() })
      else reject(new Error(stderr.trim() || stdout.trim() || `${command} 执行失败（${code}）`))
    })
  })
}

function findFileToken(value) {
  if (!value || typeof value !== 'object') return ''
  for (const key of ['file_token', 'fileToken', 'token']) {
    if (typeof value[key] === 'string' && value[key]) return value[key]
  }
  for (const child of Object.values(value)) {
    const token = findFileToken(child)
    if (token) return token
  }
  return ''
}

async function uploadFile(cliPath, filePath, name, folderToken) {
  let parentToken = folderToken || 'root'
  if (parentToken === 'root') {
    const { stdout: rootOutput } = await runCommand(cliPath, ['api', 'GET', '/open-apis/drive/explorer/v2/root_folder/meta', '--as', 'user', '--format', 'json'])
    parentToken = JSON.parse(rootOutput)?.data?.token || ''
    if (!parentToken) throw new Error('无法读取飞书云盘根目录 token')
  }
  // lark-cli 拒绝工作目录之外的绝对路径，因此固定 cwd 后只传相对文件名。
  const { stdout } = await runCommand(cliPath, ['drive', '+upload', '--as', 'user', '--file', `./${basename(filePath)}`, '--name', name, '--folder-token', parentToken], { cwd: dirname(filePath) })
  const result = stdout ? JSON.parse(stdout) : {}
  const token = findFileToken(result)
  if (!token) throw new Error('飞书上传成功但未返回文件 token')
  return token
}

async function downloadFile(cliPath, token, output) {
  await runCommand(cliPath, ['drive', '+download', '--as', 'user', '--file-token', token, '--output', `./${basename(output)}`, '--overwrite'], { cwd: dirname(output) })
}

async function deleteCloudFile(cliPath, token) {
  // lark-cli 尚未提供删除快捷命令，使用同一登录态调用官方 Drive API。
  await runCommand(cliPath, ['api', 'DELETE', `/open-apis/drive/v1/files/${token}`, '--as', 'user', '--params', JSON.stringify({ type: 'file' })])
}

export function createBackupManager({ paths, getData, saveData, protectSecret, unprotectSecret, onDataRestored }) {
  const stateFile = join(paths.userData, 'cloud-backup-state.json')
  const keyFile = join(paths.userData, 'cloud-backup-key.json')
  const localBackupDir = join(paths.userData, 'backups')
  const cliPath = existsSync('/opt/homebrew/bin/lark-cli') ? '/opt/homebrew/bin/lark-cli' : 'lark-cli'

  async function readState() {
    try {
      return JSON.parse(await readFile(stateFile, 'utf8'))
    } catch {
      return { version: 1, backups: [], lastSuccessfulAt: '' }
    }
  }

  async function writeState(state) {
    await writeFile(stateFile, JSON.stringify(state, null, 2), 'utf8')
  }

  async function getKey() {
    if (!existsSync(keyFile)) {
      const key = randomBytes(32)
      const protectedValue = await protectSecret(key.toString('base64'))
      await writeFile(keyFile, JSON.stringify(protectedValue, null, 2), 'utf8')
      return key
    }
    const stored = JSON.parse(await readFile(keyFile, 'utf8'))
    const key = Buffer.from(await unprotectSecret(stored.value, stored.protected), 'base64')
    if (key.byteLength !== 32) throw new Error('本机云备份密钥损坏，请导入原恢复密钥')
    return key
  }

  async function exportRecoveryKey() {
    return (await getKey()).toString('base64url')
  }

  async function importRecoveryKey(value) {
    const key = Buffer.from(String(value || '').trim(), 'base64url')
    if (key.byteLength !== 32) throw new Error('恢复密钥格式不正确')
    const protectedValue = await protectSecret(key.toString('base64'))
    await writeFile(keyFile, JSON.stringify(protectedValue, null, 2), 'utf8')
    return { ok: true }
  }

  async function buildContainer() {
    const data = await getData()
    const dataRaw = Buffer.from(JSON.stringify(data, null, 2), 'utf8')
    const attachments = await listAttachmentFiles(paths.attachmentDir)
    const createdAt = new Date().toISOString()
    const payload = Buffer.from(JSON.stringify({ format: 'todo-desk-full-backup', version: 1, createdAt, data, attachments }), 'utf8')
    const compressed = await gzipAsync(payload, { level: 9 })
    const container = encryptPayload(compressed, await getKey())
    return {
      createdAt,
      container,
      rawBytes: dataRaw.byteLength + attachments.reduce((sum, item) => sum + item.bytes, 0),
      attachmentBytes: attachments.reduce((sum, item) => sum + item.bytes, 0),
      attachmentCount: attachments.length,
      taskCount: (data.tasks?.length || 0) + (data.trash?.length || 0),
      sha256: sha256(container),
    }
  }

  async function saveLocalContainer(container, id, suffix = '') {
    await mkdir(localBackupDir, { recursive: true })
    const filePath = join(localBackupDir, `${id}${suffix}.tdbackup`)
    await writeFile(filePath, container)
    return filePath
  }

  async function createBackup({ folderToken = 'root', retentionCount = 8, localOnly = false } = {}) {
    const built = await buildContainer()
    const id = built.createdAt.replace(/[:.]/g, '-')
    const localFile = await saveLocalContainer(built.container, id)
    const parts = []
    let manifestToken = ''
    let manifestBytes = 0
    try {
      for (let offset = 0, index = 0; offset < built.container.byteLength; offset += cloudPartLimitBytes, index += 1) {
        const body = built.container.subarray(offset, Math.min(offset + cloudPartLimitBytes, built.container.byteLength))
        const partName = built.container.byteLength > cloudPartLimitBytes
          ? `Todo-Desk-${id}.part${String(index + 1).padStart(3, '0')}.tdbackup`
          : `Todo-Desk-${id}.tdbackup`
        const partPath = join(localBackupDir, `${id}.upload-${index}`)
        await writeFile(partPath, body)
        const token = localOnly ? '' : await uploadFile(cliPath, partPath, partName, folderToken)
        await rm(partPath, { force: true })
        parts.push({ name: partName, token, bytes: body.byteLength })
      }

      if (!localOnly) {
        const manifestPath = join(localBackupDir, `${id}.manifest.json`)
        const manifest = { format: 'todo-desk-cloud-manifest', version: 1, id, createdAt: built.createdAt, sizeBytes: built.container.byteLength, rawBytes: built.rawBytes, attachmentBytes: built.attachmentBytes, attachmentCount: built.attachmentCount, taskCount: built.taskCount, sha256: built.sha256, parts }
        const manifestBody = JSON.stringify(manifest, null, 2)
        manifestBytes = Buffer.byteLength(manifestBody)
        await writeFile(manifestPath, manifestBody, 'utf8')
        manifestToken = await uploadFile(cliPath, manifestPath, `Todo-Desk-${id}.tdmanifest.json`, folderToken)
        await rm(manifestPath, { force: true })
      }

      const state = await readState()
      const record = { id, createdAt: built.createdAt, sizeBytes: built.container.byteLength, cloudBytes: built.container.byteLength + manifestBytes, manifestBytes, rawBytes: built.rawBytes, attachmentBytes: built.attachmentBytes, attachmentCount: built.attachmentCount, taskCount: built.taskCount, sha256: built.sha256, parts, manifestToken, localFile }
      const backups = [record, ...(state.backups || [])]
      const removed = backups.slice(Math.max(1, retentionCount))
      const kept = backups.slice(0, Math.max(1, retentionCount))
      for (const old of removed) {
        await rm(old.localFile, { force: true }).catch(() => {})
        if (!localOnly) {
          for (const part of old.parts || []) await deleteCloudFile(cliPath, part.token).catch(() => {})
          if (old.manifestToken) await deleteCloudFile(cliPath, old.manifestToken).catch(() => {})
        }
      }
      await writeState({ version: 1, lastSuccessfulAt: built.createdAt, backups: kept })
      return { ok: true, backup: record, status: await getStatus() }
    } catch (error) {
      await rm(localFile, { force: true }).catch(() => {})
      for (const part of parts) if (part.token) await deleteCloudFile(cliPath, part.token).catch(() => {})
      if (manifestToken) await deleteCloudFile(cliPath, manifestToken).catch(() => {})
      throw new Error(formatError(error, '创建云备份失败'))
    }
  }

  async function readBackupContainer(record) {
    if (record.localFile && existsSync(record.localFile)) return readFile(record.localFile)
    const buffers = []
    await mkdir(localBackupDir, { recursive: true })
    for (const [index, part] of (record.parts || []).entries()) {
      if (!part.token) throw new Error('备份缺少飞书文件 token')
      const output = join(localBackupDir, `${record.id}.download-${index}`)
      await downloadFile(cliPath, part.token, output)
      buffers.push(await readFile(output))
      await rm(output, { force: true })
    }
    return Buffer.concat(buffers)
  }

  async function restoreRecord(record) {
    const container = await readBackupContainer(record)
    if (sha256(container) !== record.sha256) throw new Error('备份文件校验失败，已停止恢复')

    // 覆盖前先保留当前完整状态；后续任一步失败都不会破坏正在使用的数据。
    const safety = await buildContainer()
    await saveLocalContainer(safety.container, `${safety.createdAt.replace(/[:.]/g, '-')}-before-restore`)
    const compressed = decryptPayload(container, await getKey())
    const payload = JSON.parse((await gunzipAsync(compressed)).toString('utf8'))
    if (payload.format !== 'todo-desk-full-backup' || !payload.data) throw new Error('备份内容格式不正确')

    const restoreDir = join(paths.userData, `.restore-${randomUUID()}`)
    const restoredAttachments = join(restoreDir, 'attachments')
    await mkdir(restoredAttachments, { recursive: true })
    for (const attachment of payload.attachments || []) {
      if (basename(attachment.name) !== attachment.name) throw new Error('备份中包含非法附件路径')
      const body = Buffer.from(attachment.data, 'base64')
      if (sha256(body) !== attachment.sha256) throw new Error(`附件校验失败：${attachment.name}`)
      await writeFile(join(restoredAttachments, attachment.name), body)
    }
    await writeFile(join(restoreDir, 'todo-desk-data.json'), JSON.stringify(payload.data, null, 2), 'utf8')
    const oldAttachmentDir = `${paths.attachmentDir}.before-restore`
    const oldDataFile = `${paths.dataFile}.before-restore`
    await rm(oldAttachmentDir, { recursive: true, force: true })
    await rm(oldDataFile, { force: true })
    // JSON 与附件不能真正跨文件原子替换；先把两份旧数据移开，任一步失败都按相反顺序回滚。
    try {
      if (existsSync(paths.dataFile)) await rename(paths.dataFile, oldDataFile)
      if (existsSync(paths.attachmentDir)) await rename(paths.attachmentDir, oldAttachmentDir)
      await rename(join(restoreDir, 'todo-desk-data.json'), paths.dataFile)
      await rename(restoredAttachments, paths.attachmentDir)
      const restoredData = await saveData(payload.data)
      onDataRestored?.(restoredData)
      await rm(oldAttachmentDir, { recursive: true, force: true })
      await rm(oldDataFile, { force: true })
      await rm(restoreDir, { recursive: true, force: true })
      return { ok: true, data: restoredData, status: await getStatus() }
    } catch (error) {
      await rm(paths.dataFile, { force: true }).catch(() => {})
      await rm(paths.attachmentDir, { recursive: true, force: true }).catch(() => {})
      if (existsSync(oldDataFile)) await rename(oldDataFile, paths.dataFile)
      if (existsSync(oldAttachmentDir)) await rename(oldAttachmentDir, paths.attachmentDir)
      await rm(restoreDir, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  }

  async function restoreBackup(id) {
    const state = await readState()
    const record = (state.backups || []).find((item) => item.id === id)
    if (!record) throw new Error('没有找到该备份版本')
    return restoreRecord(record)
  }

  async function restoreFromManifestToken(manifestToken) {
    const token = String(manifestToken || '').trim()
    if (!token) throw new Error('请输入飞书备份恢复码')
    await mkdir(localBackupDir, { recursive: true })
    const manifestPath = join(localBackupDir, `.manifest-${randomUUID()}.json`)
    await downloadFile(cliPath, token, manifestPath)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    await rm(manifestPath, { force: true })
    if (manifest.format !== 'todo-desk-cloud-manifest' || !Array.isArray(manifest.parts)) throw new Error('飞书备份恢复码无效')
    return restoreRecord({ ...manifest, manifestToken: token, localFile: '' })
  }

  async function getStatus() {
    const state = await readState()
    let rawBytes = 0
    if (existsSync(paths.dataFile)) rawBytes += (await stat(paths.dataFile)).size
    const attachments = await listAttachmentFiles(paths.attachmentDir)
    rawBytes += attachments.reduce((sum, item) => sum + item.bytes, 0)
    return {
      lastSuccessfulAt: state.lastSuccessfulAt || '',
      sourceBytes: rawBytes,
      attachmentBytes: attachments.reduce((sum, item) => sum + item.bytes, 0),
      attachmentCount: attachments.length,
      cloudBytes: (state.backups || []).reduce((sum, item) => sum + (item.cloudBytes || item.sizeBytes || 0), 0),
      backups: state.backups || [],
      hasRecoveryKey: existsSync(keyFile),
    }
  }

  return { createBackup, restoreBackup, restoreFromManifestToken, getStatus, exportRecoveryKey, importRecoveryKey }
}
