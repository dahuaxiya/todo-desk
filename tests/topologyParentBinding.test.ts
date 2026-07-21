import assert from 'node:assert/strict'
import test from 'node:test'
import { collectInvalidTopologyParentIds, getTopologyParentCandidates } from '../src/topologyParentBinding.ts'
import type { Task } from '../src/types.ts'

function createTask(id: string, parentTaskId = '', status: Task['status'] = 'doing'): Task {
  return {
    id,
    title: `任务 ${id}`,
    detail: '',
    status,
    priority: 'medium',
    project: 'Todo Desk',
    tags: [],
    imagePaths: [],
    createdAt: `2026-07-21T00:00:0${id.length}.000Z`,
    updatedAt: `2026-07-21T00:00:0${id.length}.000Z`,
    parentTaskId: parentTaskId || undefined,
  }
}

test('父任务候选排除自己和全部后代', () => {
  const tasks = [createTask('root'), createTask('child', 'root'), createTask('grandchild', 'child'), createTask('other')]
  const invalidIds = collectInvalidTopologyParentIds(tasks, ['root'])

  assert.deepEqual([...invalidIds].sort(), ['child', 'grandchild', 'root'])
  assert.deepEqual(getTopologyParentCandidates(tasks, ['root'], '').map((task) => task.id), ['other'])
})

test('批量绑定排除整个选择集及每个任务的后代', () => {
  const tasks = [createTask('a'), createTask('a-child', 'a'), createTask('b'), createTask('b-child', 'b'), createTask('parent')]

  assert.deepEqual(
    getTopologyParentCandidates(tasks, ['a', 'b'], '').map((task) => task.id),
    ['parent'],
  )
})

test('空搜索只展示全部进行中任务，主动搜索允许其他状态并限制数量', () => {
  const tasks = [
    createTask('doing-old'),
    { ...createTask('doing-new'), updatedAt: '2026-07-21T02:00:00.000Z' },
    { ...createTask('done-match', '', 'done'), title: '历史父任务' },
    { ...createTask('todo-match', '', 'todo'), title: '历史待办父任务', updatedAt: '2026-07-21T03:00:00.000Z' },
  ]

  assert.deepEqual(getTopologyParentCandidates(tasks, [], '').map((task) => task.id), ['doing-new', 'doing-old'])
  assert.deepEqual(getTopologyParentCandidates(tasks, [], '历史', 1).map((task) => task.id), ['todo-match'])
})
