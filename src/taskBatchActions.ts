import type { Task } from './types'

type RelatedTask = Pick<Task, 'id' | 'parentTaskId' | 'status'>

export function resolveTaskActionIds(clickedTaskId: string, selectedTaskIds: Iterable<string>) {
  const selectedIds = [...new Set(selectedTaskIds)]
  return selectedIds.length > 1 && selectedIds.includes(clickedTaskId)
    ? selectedIds
    : [clickedTaskId]
}

export function collectIncompleteDescendantTaskIds(tasks: RelatedTask[], rootTaskIds: Iterable<string>) {
  const rootIds = new Set(rootTaskIds)
  const taskById = new Map(tasks.map((task) => [task.id, task]))
  const childrenByParentId = new Map<string, RelatedTask[]>()

  for (const task of tasks) {
    if (!task.parentTaskId) continue
    childrenByParentId.set(task.parentTaskId, [...(childrenByParentId.get(task.parentTaskId) ?? []), task])
  }

  const queue = [...rootIds].flatMap((taskId) => childrenByParentId.get(taskId) ?? [])
  const visited = new Set<string>()
  const incompleteDescendantIds: string[] = []

  // Traverse through completed descendants as well: inconsistent historical data can contain
  // an unfinished grandchild below a completed child, and "all descendants" must still find it.
  while (queue.length > 0) {
    const task = queue.shift()
    if (!task || visited.has(task.id) || rootIds.has(task.id) || !taskById.has(task.id)) continue
    visited.add(task.id)
    if (task.status !== 'done') incompleteDescendantIds.push(task.id)
    queue.push(...(childrenByParentId.get(task.id) ?? []))
  }

  return incompleteDescendantIds
}
