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
    parentToken = await resolveRootFolderToken(cliPath)
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

function findDocToken(value) {
  if (!value || typeof value !== 'object') return ''
  for (const key of ['doc_id', 'document_id', 'doc_token']) {
    if (typeof value[key] === 'string' && value[key]) return value[key]
  }
  for (const child of Object.values(value)) {
    const token = findDocToken(child)
    if (token) return token
  }
  return ''
}

async function resolveRootFolderToken(cliPath) {
  const { stdout } = await runCommand(cliPath, ['api', 'GET', '/open-apis/drive/explorer/v2/root_folder/meta', '--as', 'user', '--format', 'json'])
  const token = JSON.parse(stdout)?.data?.token || ''
  if (!token) throw new Error('无法读取飞书云盘根目录 token')
  return token
}

async function createCloudFolder(cliPath, name, parentToken) {
  const { stdout } = await runCommand(cliPath, [
    'api',
    'POST',
    '/open-apis/drive/v1/files/create_folder',
    '--as',
    'user',
    '--data',
    JSON.stringify({ name, folder_token: parentToken }),
    '--format',
    'json',
  ])
  const body = JSON.parse(stdout)
  const token = body?.data?.token || ''
  if (!token) throw new Error('飞书专用备份目录创建成功但未返回 token')
  return { token, url: body?.data?.url || '' }
}

async function createRepositoryDocument(cliPath, folderToken, markdown) {
  const { stdout } = await runCommand(cliPath, [
    'docs',
    '+create',
    '--as',
    'user',
    '--folder-token',
    folderToken,
    '--title',
    'Todo Desk Backup Repository',
    '--markdown',
    markdown,
  ])
  const body = JSON.parse(stdout)
  const token = findDocToken(body)
  if (!token) throw new Error('飞书备份仓库索引创建成功但未返回文档 token')
  return { token, url: body?.data?.doc_url || '' }
}

async function updateRepositoryDocument(cliPath, docToken, markdown) {
  await runCommand(cliPath, ['docs', '+update', '--as', 'user', '--doc', docToken, '--mode', 'overwrite', '--markdown', markdown])
}

export function parseRepositoryMarkdown(markdown) {
  const match = markdown.match(/```json\s*([\s\S]*?)```/i)
  if (!match) throw new Error('飞书备份仓库索引格式不正确')
  const repository = JSON.parse(match[1].trim())
  if (repository.format !== 'todo-desk-repository' || !Array.isArray(repository.backups)) {
    throw new Error('飞书备份仓库恢复码无效')
  }
  return repository
}

async function fetchRepositoryDocument(cliPath, docToken) {
  const { stdout } = await runCommand(cliPath, ['docs', '+fetch', '--as', 'user', '--doc', docToken, '--format', 'json'])
  const markdown = JSON.parse(stdout)?.data?.markdown || ''
  return parseRepositoryMarkdown(markdown)
}

function repositoryMarkdown(repository) {
  const metadata = JSON.stringify(repository)
  return [
    '# Todo Desk Backup Repository',
    '',
    '此文档由 Todo Desk 自动维护。恢复时请在 App 中粘贴本页文档 token，不要手动修改以下数据。',
    '',
    '```json',
    metadata,
    '```',
  ].join('\n')
}

function localDayKey(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function uniqueCloudDeletes(items) {
  const byToken = new Map()
  for (const item of items || []) {
    if (item?.token) byToken.set(item.token, { token: item.token, type: item.type || 'file' })
  }
  return [...byToken.values()]
}

export function selectRetainedBackups(backups, recentCount = 4, dailyCount = 2, now = new Date()) {
  const sorted = [...backups].sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
  const recent = sorted.slice(0, Math.max(1, recentCount))
  const retainedIds = new Set(recent.map((backup) => backup.id))
  const todayKey = localDayKey(now.toISOString())
  const representedDays = new Set()

  // 每日版本只从今天之前选择，避免“今天的最新四份”又额外占一个每日名额。
  for (const backup of sorted) {
    if (retainedIds.has(backup.id)) continue
    const dayKey = localDayKey(backup.createdAt)
    if (!dayKey || dayKey === todayKey || representedDays.has(dayKey)) continue
    retainedIds.add(backup.id)
    representedDays.add(dayKey)
    if (representedDays.size >= Math.max(0, dailyCount)) break
  }

  return sorted.filter((backup) => retainedIds.has(backup.id))
}

export function createBackupManager({ paths, getData, saveData, protectSecret, unprotectSecret, onDataRestored }) {
  const stateFile = join(paths.userData, 'cloud-backup-state.json')
  const keyFile = join(paths.userData, 'cloud-backup-key.json')
  const localBackupDir = join(paths.userData, 'backups')
  const cliPath = existsSync('/opt/homebrew/bin/lark-cli') ? '/opt/homebrew/bin/lark-cli' : 'lark-cli'
  let operationTail = Promise.resolve()

  function runExclusive(operation) {
    // 手动备份、定时备份、恢复和校验都会改写同一份仓库状态，必须串行执行，
    // 否则两个操作可能基于旧索引各自提交，造成刚上传的版本从索引中丢失。
    const current = operationTail.catch(() => {}).then(operation)
    operationTail = current.catch(() => {})
    return current
  }

  async function readState() {
    try {
      const state = JSON.parse(await readFile(stateFile, 'utf8'))
      return {
        version: 2,
        repository: state.repository || null,
        backups: Array.isArray(state.backups) ? state.backups : [],
        lastSuccessfulAt: state.lastSuccessfulAt || '',
        lastCheckedAt: state.lastCheckedAt || state.lastSuccessfulAt || '',
        lastContentSha256: state.lastContentSha256 || '',
        lastVerificationAttemptAt: state.lastVerificationAttemptAt || state.lastVerifiedAt || '',
        lastVerifiedAt: state.lastVerifiedAt || '',
        lastVerificationMessage: state.lastVerificationMessage || '',
        pendingCloudDeletes: uniqueCloudDeletes(state.pendingCloudDeletes),
        lastCleanupMessage: state.lastCleanupMessage || '',
      }
    } catch {
      return {
        version: 2,
        repository: null,
        backups: [],
        lastSuccessfulAt: '',
        lastCheckedAt: '',
        lastContentSha256: '',
        lastVerificationAttemptAt: '',
        lastVerifiedAt: '',
        lastVerificationMessage: '',
        pendingCloudDeletes: [],
        lastCleanupMessage: '',
      }
    }
  }

  async function writeState(state) {
    await writeFile(stateFile, JSON.stringify(state, null, 2), 'utf8')
  }

  async function ensureRepository(state, preferredFolderToken = '') {
    if (state.repository?.folderToken && state.repository?.indexDocToken) return state.repository

    let folder = null
    let createdFolder = false
    if (preferredFolderToken && preferredFolderToken !== 'root') {
      folder = { token: preferredFolderToken, url: '' }
    } else {
      folder = await createCloudFolder(cliPath, 'Todo Desk Backups', await resolveRootFolderToken(cliPath))
      createdFolder = true
    }

    try {
      const emptyRepository = {
        format: 'todo-desk-repository',
        version: 1,
        updatedAt: new Date().toISOString(),
        folderToken: folder.token,
        backups: [],
      }
      const index = await createRepositoryDocument(cliPath, folder.token, repositoryMarkdown(emptyRepository))
      return {
        folderToken: folder.token,
        folderUrl: folder.url,
        indexDocToken: index.token,
        indexDocUrl: index.url,
        createdAt: new Date().toISOString(),
      }
    } catch (error) {
      if (createdFolder) {
        await runCommand(cliPath, ['api', 'DELETE', `/open-apis/drive/v1/files/${folder.token}`, '--as', 'user', '--params', JSON.stringify({ type: 'folder' })]).catch(() => {})
      }
      throw error
    }
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
    const content = { data, attachments }
    const contentSha256 = sha256(Buffer.from(JSON.stringify(content), 'utf8'))
    const payload = Buffer.from(JSON.stringify({ format: 'todo-desk-full-backup', version: 1, createdAt, ...content }), 'utf8')
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
      contentSha256,
    }
  }

  async function saveLocalContainer(container, id, suffix = '') {
    await mkdir(localBackupDir, { recursive: true })
    const filePath = join(localBackupDir, `${id}${suffix}.tdbackup`)
    await writeFile(filePath, container)
    return filePath
  }

  async function createBackup({ folderToken = '', recentCount = 4, dailyCount = 2, localOnly = false, force = false } = {}) {
    const built = await buildContainer()
    const state = await readState()
    if (!force && state.lastContentSha256 === built.contentSha256 && state.backups.length > 0) {
      await writeState({ ...state, lastCheckedAt: built.createdAt })
      return { ok: true, skipped: true, message: '数据没有变化，已跳过重复备份', status: await getStatus() }
    }

    const repository = localOnly ? state.repository : await ensureRepository(state, folderToken)
    const targetFolderToken = repository?.folderToken || folderToken
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
        const token = localOnly ? '' : await uploadFile(cliPath, partPath, partName, targetFolderToken)
        await rm(partPath, { force: true })
        parts.push({ name: partName, token, bytes: body.byteLength })
      }

      if (!localOnly) {
        const manifestPath = join(localBackupDir, `${id}.manifest.json`)
        const manifest = { format: 'todo-desk-cloud-manifest', version: 1, id, createdAt: built.createdAt, sizeBytes: built.container.byteLength, rawBytes: built.rawBytes, attachmentBytes: built.attachmentBytes, attachmentCount: built.attachmentCount, taskCount: built.taskCount, sha256: built.sha256, contentSha256: built.contentSha256, parts }
        const manifestBody = JSON.stringify(manifest, null, 2)
        manifestBytes = Buffer.byteLength(manifestBody)
        await writeFile(manifestPath, manifestBody, 'utf8')
        manifestToken = await uploadFile(cliPath, manifestPath, `Todo-Desk-${id}.tdmanifest.json`, targetFolderToken)
        await rm(manifestPath, { force: true })
      }

      const record = { id, createdAt: built.createdAt, sizeBytes: built.container.byteLength, cloudBytes: built.container.byteLength + manifestBytes, manifestBytes, rawBytes: built.rawBytes, attachmentBytes: built.attachmentBytes, attachmentCount: built.attachmentCount, taskCount: built.taskCount, sha256: built.sha256, contentSha256: built.contentSha256, parts, manifestToken, localFile }
      const backups = [record, ...(state.backups || [])]
      const kept = selectRetainedBackups(backups, recentCount, dailyCount)
      const keptIds = new Set(kept.map((backup) => backup.id))
      const removed = backups.filter((backup) => !keptIds.has(backup.id))
      const removedCloudFiles = removed.flatMap((backup) => [
        ...(backup.parts || []).map((part) => ({ token: part.token, type: 'file' })),
        ...(backup.manifestToken ? [{ token: backup.manifestToken, type: 'file' }] : []),
      ])

      if (!localOnly) {
        const cloudBackups = kept.map(({ localFile: _localFile, ...backup }) => backup)
        await updateRepositoryDocument(cliPath, repository.indexDocToken, repositoryMarkdown({
          format: 'todo-desk-repository',
          version: 1,
          updatedAt: built.createdAt,
          folderToken: repository.folderToken,
          backups: cloudBackups,
        }))
      }

      const nextState = {
        ...state,
        version: 2,
        repository,
        lastSuccessfulAt: built.createdAt,
        lastCheckedAt: built.createdAt,
        lastContentSha256: built.contentSha256,
        backups: kept,
        pendingCloudDeletes: localOnly
          ? state.pendingCloudDeletes
          : uniqueCloudDeletes([...(state.pendingCloudDeletes || []), ...removedCloudFiles]),
      }
      await writeState(nextState)

      // 新索引已经提交成功后再清理旧文件，避免上传中断导致最后一个可恢复版本被提前删除。
      for (const old of removed) {
        await rm(old.localFile, { force: true }).catch(() => {})
      }

      if (!localOnly && nextState.pendingCloudDeletes.length > 0) {
        const remainingDeletes = []
        for (const item of nextState.pendingCloudDeletes) {
          try {
            await deleteCloudFile(cliPath, item.token)
          } catch {
            remainingDeletes.push(item)
          }
        }
        // 删除失败的 token 必须保留下来供下次重试，不能因为索引已轮转就永久丢失。
        nextState.pendingCloudDeletes = remainingDeletes
        nextState.lastCleanupMessage = remainingDeletes.length > 0
          ? `有 ${remainingDeletes.length} 个过期云文件等待清理，请检查飞书删除权限`
          : '过期云文件已清理'
        await writeState(nextState)
      }
      return { ok: true, backup: record, repository, cleanupPendingCount: nextState.pendingCloudDeletes.length, status: await getStatus() }
    } catch (error) {
      await rm(localFile, { force: true }).catch(() => {})
      const failedDeletes = []
      for (const part of parts) {
        if (!part.token) continue
        try {
          await deleteCloudFile(cliPath, part.token)
        } catch {
          failedDeletes.push({ token: part.token, type: 'file' })
        }
      }
      if (manifestToken) {
        try {
          await deleteCloudFile(cliPath, manifestToken)
        } catch {
          failedDeletes.push({ token: manifestToken, type: 'file' })
        }
      }
      if (failedDeletes.length > 0) {
        await writeState({
          ...state,
          repository: repository || state.repository,
          pendingCloudDeletes: uniqueCloudDeletes([...(state.pendingCloudDeletes || []), ...failedDeletes]),
          lastCleanupMessage: `有 ${failedDeletes.length} 个上传残留文件等待清理，请检查飞书删除权限`,
        }).catch(() => {})
      }
      throw new Error(formatError(error, '创建云备份失败'))
    }
  }

  async function readBackupContainer(record, { preferCloud = false } = {}) {
    if (!preferCloud && record.localFile && existsSync(record.localFile)) return readFile(record.localFile)
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

  async function connectRepository(recoveryCode) {
    const token = String(recoveryCode || '').trim()
    if (!token) throw new Error('请输入备份仓库恢复码')
    const repositoryIndex = await fetchRepositoryDocument(cliPath, token)
    const state = await readState()
    await writeState({
      ...state,
      version: 2,
      repository: {
        folderToken: repositoryIndex.folderToken || '',
        folderUrl: '',
        indexDocToken: token,
        indexDocUrl: '',
        createdAt: state.repository?.createdAt || new Date().toISOString(),
      },
      backups: repositoryIndex.backups.map((backup) => ({ ...backup, localFile: '' })),
      lastSuccessfulAt: repositoryIndex.backups[0]?.createdAt || state.lastSuccessfulAt || '',
      lastContentSha256: repositoryIndex.backups[0]?.contentSha256 || '',
    })
    return { ok: true, status: await getStatus() }
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

  async function verifyBackup(id = '') {
    const state = await readState()
    const record = id
      ? state.backups.find((backup) => backup.id === id)
      : [...state.backups].sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())[0]
    if (!record) return { ok: true, skipped: true, message: '还没有可校验的云备份' }
    const attemptedAt = new Date().toISOString()
    try {
      const container = await readBackupContainer(record, { preferCloud: true })
      if (sha256(container) !== record.sha256) throw new Error('云端备份整体哈希校验失败')
      const compressed = decryptPayload(container, await getKey())
      const payload = JSON.parse((await gunzipAsync(compressed)).toString('utf8'))
      if (payload.format !== 'todo-desk-full-backup' || !payload.data || !Array.isArray(payload.attachments)) {
        throw new Error('云端备份解密后的结构不完整')
      }
      for (const attachment of payload.attachments) {
        const body = Buffer.from(attachment.data, 'base64')
        if (sha256(body) !== attachment.sha256) throw new Error(`云端附件校验失败：${attachment.name}`)
      }
      await writeState({ ...state, lastVerificationAttemptAt: attemptedAt, lastVerifiedAt: attemptedAt, lastVerificationMessage: `已验证 ${record.id}` })
      return { ok: true, verifiedAt: attemptedAt, backupId: record.id, status: await getStatus() }
    } catch (error) {
      const message = formatError(error, '云端备份校验失败')
      await writeState({ ...state, lastVerificationAttemptAt: attemptedAt, lastVerificationMessage: message })
      throw error
    }
  }

  async function getStatus() {
    const state = await readState()
    let rawBytes = 0
    if (existsSync(paths.dataFile)) rawBytes += (await stat(paths.dataFile)).size
    const attachments = await listAttachmentFiles(paths.attachmentDir)
    rawBytes += attachments.reduce((sum, item) => sum + item.bytes, 0)
    return {
      lastSuccessfulAt: state.lastSuccessfulAt || '',
      lastCheckedAt: state.lastCheckedAt || '',
      sourceBytes: rawBytes,
      attachmentBytes: attachments.reduce((sum, item) => sum + item.bytes, 0),
      attachmentCount: attachments.length,
      cloudBytes: (state.backups || []).reduce((sum, item) => sum + (item.cloudBytes || item.sizeBytes || 0), 0),
      backups: state.backups || [],
      hasRecoveryKey: existsSync(keyFile),
      repository: state.repository || null,
      recoveryCode: state.repository?.indexDocToken || '',
      lastVerificationAttemptAt: state.lastVerificationAttemptAt || '',
      lastVerifiedAt: state.lastVerifiedAt || '',
      lastVerificationMessage: state.lastVerificationMessage || '',
      pendingCleanupCount: state.pendingCloudDeletes.length,
      lastCleanupMessage: state.lastCleanupMessage || '',
    }
  }

  return {
    createBackup: (options) => runExclusive(() => createBackup(options)),
    restoreBackup: (id) => runExclusive(() => restoreBackup(id)),
    restoreFromManifestToken: (token) => runExclusive(() => restoreFromManifestToken(token)),
    connectRepository: (code) => runExclusive(() => connectRepository(code)),
    verifyBackup: (id) => runExclusive(() => verifyBackup(id)),
    getStatus,
    exportRecoveryKey,
    importRecoveryKey: (value) => runExclusive(() => importRecoveryKey(value)),
  }
}
