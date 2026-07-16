import assert from 'node:assert/strict'
import { searchTasks } from '../electron/task-search.js'

const now = Date.parse('2026-07-16T12:00:00+08:00')
const tasks = [
  {
    id: 'session-task',
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
    id: 'topology-task',
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

const sessionResults = searchTasks(tasks, { agentSessionId: 'session-1', limit: 5 }, now)
assert.deepEqual(sessionResults.map((task) => task.id), ['session-task'])
assert.ok(sessionResults[0].reasons.includes('exact-filter'))

const fuzzyResults = searchTasks(tasks, {
  query: '拓扑卡片父子连线和派生关系',
  repositoryPath: '/repo/todo-desk',
  limit: 5,
}, now)
assert.deepEqual(fuzzyResults.map((task) => task.id), ['topology-task'])
assert.ok(fuzzyResults[0].reasons.includes('title'))
assert.ok(!fuzzyResults.some((task) => task.id === 'generic-task-words'))

const noMatch = searchTasks(tasks, { query: 'zqv isolated phrase', limit: 5 }, now)
assert.equal(noMatch.length, 0)
assert.throws(() => searchTasks(tasks, {}, now), /at least one search query or exact filter is required/)

console.log('task search tests passed')
