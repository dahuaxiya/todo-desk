const defaultSearchLimit = 20
const maxSearchLimit = 50
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
  return task.agentSessionId || task.origin?.agent?.sessionId || ''
}

function taskAgent(task) {
  return task.agent || task.origin?.agent?.name || ''
}

function taskRepository(task) {
  return task.repository || task.origin?.repository?.name || ''
}

function taskRepositoryPath(task) {
  return task.repositoryPath || task.origin?.repository?.path || ''
}

function parseList(value) {
  if (Array.isArray(value)) return value.map(normalizeText).filter(Boolean)
  return String(value || '').split(/[\s,，、]+/).map(normalizeText).filter(Boolean)
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

function summarizeTask(task, score, reasons) {
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
    agent: taskAgent(task),
    agentSessionId: taskSessionId(task),
    repository: taskRepository(task),
    repositoryPath: taskRepositoryPath(task),
    score: Math.round(score * 100) / 100,
    reasons,
  }
}

function matchesExactFilters(task, input) {
  const statuses = parseList(input.status)
  if (statuses.length && !statuses.includes(normalizeText(task.status))) return false
  if (input.project && !sameNormalized(input.project, task.project)) return false
  if (input.agent && !sameNormalized(input.agent, taskAgent(task))) return false
  if (input.agentSessionId && !sameNormalized(input.agentSessionId, taskSessionId(task))) return false
  if (input.repository && !sameNormalized(input.repository, taskRepository(task))) return false
  if (input.repositoryPath && !sameNormalized(input.repositoryPath, taskRepositoryPath(task))) return false
  if (input.originKind && !sameNormalized(input.originKind, task.origin?.kind)) return false

  const requiredTags = parseList(input.tags)
  if (requiredTags.length) {
    const taskTags = new Set(parseList(task.tags))
    if (!requiredTags.every((tag) => taskTags.has(tag))) return false
  }
  return true
}

function hasSearchCriteria(input) {
  return ['query', 'q', 'status', 'project', 'tags', 'agent', 'agentSessionId', 'repository', 'repositoryPath', 'originKind', 'excludeTaskId']
    .some((key) => parseList(input[key]).length > 0)
}

export function searchTasks(tasks, input = {}, now = Date.now()) {
  if (!hasSearchCriteria(input)) throw new Error('at least one search query or exact filter is required')
  const limit = Math.min(maxSearchLimit, Math.max(1, Number(input.limit) || defaultSearchLimit))
  const queryTokens = tokenize(input.query || input.q)
  const excludeTaskId = normalizeText(input.excludeTaskId)
  const ranked = []

  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!task?.id || normalizeText(task.id) === excludeTaskId || !matchesExactFilters(task, input)) continue

    const reasons = []
    let score = 0
    if (queryTokens.size) {
      const titleCoverage = tokenCoverage(queryTokens, tokenize(task.title))
      const detailCoverage = tokenCoverage(queryTokens, tokenize(task.detail))
      const tagCoverage = tokenCoverage(queryTokens, tokenize(task.tags))
      const projectCoverage = tokenCoverage(queryTokens, tokenize(task.project))
      const semanticScore = titleCoverage * 50 + detailCoverage * 25 + tagCoverage * 15 + projectCoverage * 10

      if (titleCoverage > 0) reasons.push('title')
      if (detailCoverage > 0) reasons.push('detail')
      if (tagCoverage > 0) reasons.push('tags')
      if (projectCoverage > 0) reasons.push('project')
      // Weak matches on generic text add noise, so fuzzy queries require a minimum semantic score.
      if (semanticScore < 10) continue
      score += semanticScore
    } else {
      reasons.push('exact-filter')
    }

    if (task.status === 'doing') score += 5
    else if (task.status === 'pending_acceptance') score += 4
    else if (task.status === 'todo') score += 3
    else if (task.status === 'done') score -= 2
    score += recencyScore(task.updatedAt, now)
    ranked.push(summarizeTask(task, score, reasons))
  }

  return ranked
    .sort((left, right) => right.score - left.score || String(right.updatedAt).localeCompare(String(left.updatedAt)))
    .slice(0, limit)
}
