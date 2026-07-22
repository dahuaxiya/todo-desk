import assert from 'node:assert/strict'
import test from 'node:test'
import { collectIncompleteDescendantTaskIds, resolveTaskActionIds } from '../src/taskBatchActions.ts'

test('an action on a selected task targets the complete multi-selection', () => {
  assert.deepEqual(resolveTaskActionIds('b', ['a', 'b', 'c', 'b']), ['a', 'b', 'c'])
})

test('an action outside the selection only targets the clicked task', () => {
  assert.deepEqual(resolveTaskActionIds('outside', ['a', 'b']), ['outside'])
  assert.deepEqual(resolveTaskActionIds('only', ['only']), ['only'])
})

test('collects every unfinished descendant across all levels', () => {
  const tasks = [
    { id: 'root', status: 'doing' as const },
    { id: 'done-child', parentTaskId: 'root', status: 'done' as const },
    { id: 'open-child', parentTaskId: 'root', status: 'todo' as const },
    { id: 'open-grandchild', parentTaskId: 'done-child', status: 'pending_acceptance' as const },
    { id: 'other-root', status: 'todo' as const },
  ]

  assert.deepEqual(
    collectIncompleteDescendantTaskIds(tasks, ['root']),
    ['open-child', 'open-grandchild'],
  )
})

test('handles multiple roots and malformed cycles without returning roots twice', () => {
  const tasks = [
    { id: 'a', parentTaskId: 'c', status: 'doing' as const },
    { id: 'b', parentTaskId: 'a', status: 'todo' as const },
    { id: 'c', parentTaskId: 'b', status: 'todo' as const },
    { id: 'd', parentTaskId: 'c', status: 'done' as const },
  ]

  assert.deepEqual(collectIncompleteDescendantTaskIds(tasks, ['a']), ['b', 'c'])
  assert.deepEqual(collectIncompleteDescendantTaskIds(tasks, ['a', 'c']), ['b'])
})
