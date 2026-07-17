import type { Task } from './types'

type RelationshipTask = Pick<Task, 'id' | 'parentTaskId'>

export function collectRelationshipNetworkIds(tasks: RelationshipTask[], seedTaskIds: Iterable<string>) {
  const neighbors = new Map(tasks.map((task) => [task.id, new Set<string>()]))
  for (const task of tasks) {
    if (!task.parentTaskId || !neighbors.has(task.parentTaskId)) continue
    neighbors.get(task.id)?.add(task.parentTaskId)
    neighbors.get(task.parentTaskId)?.add(task.id)
  }

  const networkIds = new Set([...seedTaskIds].filter((taskId) => neighbors.has(taskId)))
  const queue = [...networkIds]

  // 筛选命中的卡片只是入口。父子边必须双向遍历，才能同时补齐祖先、后代和兄弟分支；
  // networkIds 也承担 visited 集合的职责，避免损坏数据中的循环关系导致无限遍历。
  while (queue.length > 0) {
    const taskId = queue.shift()
    if (!taskId) continue
    for (const relatedTaskId of neighbors.get(taskId) ?? []) {
      if (networkIds.has(relatedTaskId)) continue
      networkIds.add(relatedTaskId)
      queue.push(relatedTaskId)
    }
  }

  return networkIds
}
