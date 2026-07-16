import assert from 'node:assert/strict'
import { findParentTaskCandidates } from '../electron/task-parent-search.js'

const now = Date.parse('2026-07-16T12:00:00+08:00')
const tasks = [
  {
    id: 'session-parent',
    title: '处理客户反馈',
    detail: '继续跟进当前会话里的问题',
    status: 'doing',
    priority: 'medium',
    project: '客户支持',
    tags: [],
    updatedAt: '2026-07-16T11:50:00+08:00',
    agentSessionId: 'session-1',
    origin: { kind: 'agent' },
  },
  {
    id: 'fuzzy-parent',
    title: '拓扑模式支持拖动连线',
    detail: '允许通过连线指定父子任务和派生关系',
    status: 'todo',
    priority: 'high',
    project: 'Todo Desk',
    tags: ['拓扑', '父子关系'],
    updatedAt: '2026-07-15T10:00:00+08:00',
    repositoryPath: '/repo/todo-desk',
    origin: { kind: 'human' },
  },
  {
    id: 'unrelated',
    title: '同步飞书文档',
    detail: '完成任务后追加 Markdown',
    status: 'doing',
    priority: 'medium',
    project: 'Todo Desk',
    tags: ['飞书'],
    updatedAt: '2026-07-16T11:59:00+08:00',
    origin: { kind: 'human' },
  },
  {
    id: 'generic-task-words',
    title: '删除任务日历事件',
    detail: '处理任务完成后的日历同步问题',
    status: 'doing',
    priority: 'medium',
    project: 'Todo Desk',
    tags: [],
    updatedAt: '2026-07-16T11:58:00+08:00',
    repositoryPath: '/repo/todo-desk',
    origin: { kind: 'agent' },
  },
]

const candidates = findParentTaskCandidates(tasks, {
  title: '修复拓扑卡片父子连线',
  detail: '连线位置错误，需要调整派生任务关系',
  project: 'Todo Desk',
  repositoryPath: '/repo/todo-desk',
  agentSessionId: 'session-1',
  limit: 2,
}, now)

assert.equal(candidates.length, 2)
assert.equal(candidates[0].id, 'session-parent')
assert.ok(candidates[0].reasons.includes('current-session'))
assert.equal(candidates[1].id, 'fuzzy-parent')
assert.ok(candidates[1].reasons.includes('title'))
assert.ok(!candidates.some((candidate) => candidate.id === 'unrelated'))
assert.ok(!candidates.some((candidate) => candidate.id === 'generic-task-words'))

const noContext = findParentTaskCandidates(tasks, { title: 'zqv isolated phrase', limit: 5 }, now)
assert.equal(noContext.length, 0)

console.log('parent candidate search tests passed')
