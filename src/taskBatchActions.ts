import type { Task } from './types'

type RelatedTask = Pick<Task, 'id' | 'parentTaskId' | 'status'>

export function resolveTaskActionIds(clickedTaskId: string, selectedTaskIds: Iterable<string>) {
  const selectedIds = [...new Set(selectedTaskIds)]
  return selectedIds.length > 1 && selectedIds.includes(clickedTaskId)
    ? selectedIds
    : [clickedTaskId]
}

export function collectIncompleteDescendantTaskIds(tasks: RelatedTask[], targetTaskIds: Iterable<string>) {
  const targetIds = new Set(targetTaskIds)
  const taskById = new Map(tasks.map((task) => [task.id, task]))
  const childrenByParentId = new Map<string, RelatedTask[]>()

  for (const task of tasks) {
    if (!task.parentTaskId) continue
    childrenByParentId.set(task.parentTaskId, [...(childrenByParentId.get(task.parentTaskId) ?? []), task])
  }

  // A target is any task the user is completing, including a middle node that also has a parent.
  // Descendant traversal therefore starts from relationships, never from a "root task" flag.
  const queue = [...targetIds].flatMap((taskId) => childrenByParentId.get(taskId) ?? [])
  const visited = new Set<string>()
  const incompleteDescendantIds: string[] = []

  // Traverse through completed descendants as well: inconsistent historical data can contain
  // an unfinished grandchild below a completed child, and "all descendants" must still find it.
  while (queue.length > 0) {
    const task = queue.shift()
    if (!task || visited.has(task.id) || targetIds.has(task.id) || !taskById.has(task.id)) continue
    visited.add(task.id)
    if (task.status !== 'done') incompleteDescendantIds.push(task.id)
    queue.push(...(childrenByParentId.get(task.id) ?? []))
  }

  return incompleteDescendantIds
}
