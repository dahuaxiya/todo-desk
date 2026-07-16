const defaultCandidateLimit = 12
const maxCandidateLimit = 30
const detailSnippetLength = 240
const searchStopTokens = new Set([
  'task', 'tasks', 'todo', 'desk', 'work', 'current', 'create', 'created', 'creating', 'support', 'fix', 'issue',
  '任务', '当前', '工作', '创建', '新增', '修改', '修复', '支持', '功能', '问题', '使用', '进行', '实现', '处理', '优化', '调整',
])

function normalizeText(value) {
  return String(value || '').normalize('NFKC').toLowerCase().trim()
}

function tokenize(value) {
  const text = normalizeText(value)
  if (!text) return new Set()

  const tokens = new Set(text.match(/[a-z0-9][a-z0-9._/-]*/g) || [])
  const cjkRuns = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu) || []
  for (const run of cjkRuns) {
    if (run.length <= 8) tokens.add(run)
    for (let index = 0; index < run.length - 1; index += 1) {
      tokens.add(run.slice(index, index + 2))
    }
  }
  for (const token of searchStopTokens) tokens.delete(token)
  return tokens
}

function tokenCoverage(queryTokens, candidateTokens) {
  if (queryTokens.size === 0 || candidateTokens.size === 0) return 0
  let matches = 0
  for (const token of queryTokens) {
    if (candidateTokens.has(token)) matches += 1
  }
  return matches / queryTokens.size
}

function sameNormalized(left, right) {
  const normalizedLeft = normalizeText(left)
  return Boolean(normalizedLeft) && normalizedLeft === normalizeText(right)
}

function taskSessionId(task) {
  return normalizeText(task.agentSessionId || task.origin?.agent?.sessionId)
}

function recencyScore(updatedAt, now) {
  const updatedTime = Date.parse(updatedAt || '')
  if (!Number.isFinite(updatedTime)) return 0
  const ageDays = Math.max(0, (now - updatedTime) / 86_400_000)
  return Math.max(0, 5 - ageDays / 6)
}

function clipDetail(value) {
  const text = String(value || '').trim()
  if (text.length <= detailSnippetLength) return text
  return `${text.slice(0, detailSnippetLength - 1).trimEnd()}…`
}

function summarizeCandidate(task, score, reasons) {
  return {
    id: task.id,
    title: task.title,
    detailSnippet: clipDetail(task.detail),
    status: task.status,
    priority: task.priority,
    project: task.project,
    tags: Array.isArray(task.tags) ? task.tags : [],
    updatedAt: task.updatedAt,
    completedAt: task.completedAt,
    parentTaskId: task.parentTaskId || '',
    parentLink: task.parentLink,
    originKind: task.origin?.kind || '',
    agent: task.agent || task.origin?.agent?.name || '',
    agentSessionId: task.agentSessionId || task.origin?.agent?.sessionId || '',
    repository: task.repository || task.origin?.repository?.name || '',
    repositoryPath: task.repositoryPath || task.origin?.repository?.path || '',
    score: Math.round(score * 100) / 100,
    reasons,
  }
}

export function findParentTaskCandidates(tasks, input = {}, now = Date.now()) {
  const limit = Math.min(maxCandidateLimit, Math.max(1, Number(input.limit) || defaultCandidateLimit))
  const sessionId = normalizeText(input.agentSessionId || input.sessionId)
  const queryTokens = tokenize([input.title, input.detail, input.tags].flat().filter(Boolean).join(' '))
  const queryTitleTokens = tokenize(input.title)
  const queryDetailTokens = tokenize(input.detail)
  const excludeTaskId = normalizeText(input.excludeTaskId)

  const ranked = []
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!task?.id || normalizeText(task.id) === excludeTaskId) continue

    const reasons = []
    let score = 0
    const sessionMatch = Boolean(sessionId) && taskSessionId(task) === sessionId
    if (sessionMatch) {
      // Session identity is the strongest signal because it records the task already being handled in this conversation.
      score += 60
      reasons.push('current-session')
    }

    const titleCoverage = tokenCoverage(queryTitleTokens.size ? queryTitleTokens : queryTokens, tokenize(task.title))
    const detailCoverage = tokenCoverage(queryDetailTokens.size ? queryDetailTokens : queryTokens, tokenize(task.detail))
    const tagCoverage = tokenCoverage(queryTokens, tokenize(task.tags))
    let semanticScore = 0

    if (titleCoverage > 0) {
      semanticScore += titleCoverage * 42
      reasons.push('title')
    }
    if (detailCoverage > 0) {
      semanticScore += detailCoverage * 24
      reasons.push('detail')
    }
    if (tagCoverage > 0) {
      semanticScore += tagCoverage * 8
      reasons.push('tags')
    }
    score += semanticScore

    const taskRepositoryPath = task.repositoryPath || task.origin?.repository?.path
    const taskRepository = task.repository || task.origin?.repository?.name
    if (sameNormalized(input.repositoryPath, taskRepositoryPath)) {
      score += 14
      reasons.push('repository-path')
    } else if (sameNormalized(input.repository, taskRepository)) {
      score += 7
      reasons.push('repository')
    }
    if (sameNormalized(input.project, task.project)) {
      score += 9
      reasons.push('project')
    }

    if (task.status === 'doing') score += 5
    else if (task.status === 'pending_acceptance') score += 4
    else if (task.status === 'todo') score += 3
    else if (task.status === 'done') score -= 2
    score += recencyScore(task.updatedAt, now)

    // Do not fill the result with unrelated tasks just because they are recent or active.
    const hasRelationshipSignal = sessionMatch || semanticScore >= 10
    if (!hasRelationshipSignal) continue
    ranked.push(summarizeCandidate(task, score, reasons))
  }

  return ranked
    .sort((left, right) => right.score - left.score || String(right.updatedAt).localeCompare(String(left.updatedAt)))
    .slice(0, limit)
}
