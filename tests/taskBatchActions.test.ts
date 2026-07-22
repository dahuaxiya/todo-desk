import assert from 'node:assert/strict'
import test from 'node:test'
import { createSerialBackgroundQueue, enqueueCompletionSync } from '../src/completionSyncQueue.ts'
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

test('collects descendants when the target is a parent in the middle of the tree', () => {
  const tasks = [
    { id: 'root', status: 'doing' as const },
    { id: 'middle-parent', parentTaskId: 'root', status: 'doing' as const },
    { id: 'open-child', parentTaskId: 'middle-parent', status: 'todo' as const },
    { id: 'open-grandchild', parentTaskId: 'open-child', status: 'pending_acceptance' as const },
  ]

  assert.deepEqual(
    collectIncompleteDescendantTaskIds(tasks, ['middle-parent']),
    ['open-child', 'open-grandchild'],
  )
})

test('handles multiple targets and malformed cycles without returning targets twice', () => {
  const tasks = [
    { id: 'a', parentTaskId: 'c', status: 'doing' as const },
    { id: 'b', parentTaskId: 'a', status: 'todo' as const },
    { id: 'c', parentTaskId: 'b', status: 'todo' as const },
    { id: 'd', parentTaskId: 'c', status: 'done' as const },
  ]

  assert.deepEqual(collectIncompleteDescendantTaskIds(tasks, ['a']), ['b', 'c'])
  assert.deepEqual(collectIncompleteDescendantTaskIds(tasks, ['a', 'c']), ['b'])
})

test('queues one non-blocking cloud sync for a complete descendant batch', async () => {
  let releaseFirstJob = () => undefined
  const firstJobGate = new Promise<void>((resolve) => {
    releaseFirstJob = resolve
  })
  const calls: string[][] = []
  const queue = createSerialBackgroundQueue()

  const enqueued = enqueueCompletionSync(queue, ['parent', 'child', 'child'], async (taskIds) => {
    calls.push(taskIds)
    await firstJobGate
  })

  assert.equal(enqueued, true)
  assert.deepEqual(calls, [])
  await Promise.resolve()
  assert.deepEqual(calls, [['parent', 'child']])

  releaseFirstJob()
  await queue.whenIdle()
})

test('keeps later completion syncs ordered after an earlier failure', async () => {
  const calls: string[] = []
  const errors: string[] = []
  const queue = createSerialBackgroundQueue((error) => {
    errors.push(error instanceof Error ? error.message : String(error))
  })

  enqueueCompletionSync(queue, ['first'], async () => {
    calls.push('first')
    throw new Error('offline')
  })
  enqueueCompletionSync(queue, ['second'], async () => {
    calls.push('second')
  })

  await queue.whenIdle()
  assert.deepEqual(calls, ['first', 'second'])
  assert.deepEqual(errors, ['offline'])
})
