import type { Task } from './types'

type ParentCandidateTask = Pick<
  Task,
  'id' | 'parentTaskId' | 'status' | 'title' | 'detail' | 'project' | 'repository' | 'tags' | 'agent' | 'createdAt' | 'updatedAt'
>

function normalizeSearchText(value: unknown) {
  return String(value || '').trim().toLocaleLowerCase('zh-CN')
}

function collectDescendantIds(tasks: ParentCandidateTask[], rootTaskId: string) {
  const childrenByParentId = new Map<string, string[]>()
  for (const task of tasks) {
    if (!task.parentTaskId) continue
    childrenByParentId.set(task.parentTaskId, [...(childrenByParentId.get(task.parentTaskId) ?? []), task.id])
  }

  const descendants = new Set<string>()
  const queue = [...(childrenByParentId.get(rootTaskId) ?? [])]
  while (queue.length > 0) {
    const taskId = queue.shift()
    if (!taskId || descendants.has(taskId)) continue
    descendants.add(taskId)
    queue.push(...(childrenByParentId.get(taskId) ?? []))
  }
  return descendants
}

export function collectInvalidTopologyParentIds(tasks: ParentCandidateTask[], childTaskIds: Iterable<string>) {
  const childIds = new Set(childTaskIds)
  const invalidIds = new Set(childIds)

  // 把任何待改绑任务的后代设为非法父级，否则批量操作可能在一次提交中制造关系环。
  for (const childTaskId of childIds) {
    for (const descendantId of collectDescendantIds(tasks, childTaskId)) invalidIds.add(descendantId)
  }
  return invalidIds
}

export function getTopologyParentCandidates<T extends ParentCandidateTask>(
  tasks: T[],
  childTaskIds: Iterable<string>,
  searchValue: string,
  searchLimit = 30,
): T[] {
  const invalidIds = collectInvalidTopologyParentIds(tasks, childTaskIds)
  const query = normalizeSearchText(searchValue)

  return tasks
    .filter((task) => !invalidIds.has(task.id))
    // 空搜索聚焦眼下仍在进行的工作；主动搜索时允许找历史或待办任务作为父级。
    .filter((task) => query || task.status === 'doing')
    .filter((task) => {
      if (!query) return true
      const fields = [task.title, task.detail, task.project, task.repository, task.agent, task.tags.join(' ')]
      return fields.some((field) => normalizeSearchText(field).includes(query))
    })
    .sort((left, right) => String(right.updatedAt || right.createdAt).localeCompare(String(left.updatedAt || left.createdAt)))
    .slice(0, query ? searchLimit : undefined)
}
