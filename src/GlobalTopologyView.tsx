import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import dagre from '@dagrejs/dagre'
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  applyNodeChanges,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './GlobalTopologyView.css'
import type { Task, TaskColumnStatus, TaskParentLink, TaskRelationshipState, TaskStatus, TopologyPosition } from './types'

type TopologyRelationType = TaskParentLink['type']
type TopologyStatusFilter = 'all' | TaskColumnStatus
type TopologyMode = 'select' | 'connect'
type TopologyRelationshipFilter = 'managed' | 'all' | 'unresolved' | 'independent_root'

interface GlobalTopologyViewProps {
  tasks: Task[]
  includedTaskIds: string[]
  expandRelatedTasks: boolean
  positions: Record<string, TopologyPosition>
  onSavePositions: (positions: Record<string, TopologyPosition>) => Promise<void> | void
  onLinkTasks: (parentTaskId: string, childTaskId: string, relationType: TopologyRelationType) => Promise<void> | void
  onLinkTasksBatch: (parentTaskId: string, childTaskIds: string[], relationType: TopologyRelationType) => Promise<void> | void
  onCreateParentTask: (childTaskIds: string[], title: string, relationType: TopologyRelationType) => Promise<void> | void
  onSetRelationshipState: (taskIds: string[], state: TaskRelationshipState) => Promise<void> | void
  onUnlinkTask: (taskId: string) => Promise<void> | void
  onChangeStatus: (taskId: string, status: TaskColumnStatus) => Promise<void> | void
  onToggleDone: (taskId: string) => Promise<void> | void
  onCopyTask: (task: Task) => Promise<void> | void
  canOpenAgentSession: (task: Task) => boolean
  onOpenAgentSession: (task: Task) => Promise<boolean> | void
  onOpenCalendar: (task: Task) => Promise<void> | void
  onEditTask: (task: Task) => void
  onDeleteTask: (taskId: string) => Promise<void> | void
  onAddTask: () => void
}

interface TaskNodeData extends Record<string, unknown> {
  task: Task
  childCount: number
  collapsed: boolean
  hiddenDescendantCount: number
  connectMode: boolean
  onChangeStatus: GlobalTopologyViewProps['onChangeStatus']
  onToggleDone: GlobalTopologyViewProps['onToggleDone']
  onToggleCollapse: (taskId: string) => void
}

type TaskFlowNode = Node<TaskNodeData, 'task'>
type TaskFlowEdge = Edge<{ childTaskId: string; relationType: TopologyRelationType }>

const nodeWidth = 236
const nodeHeight = 112
const minTopologyZoom = 0.08
const maxTopologyZoom = 1.8

const statusLabels: Record<TaskStatus, string> = {
  doing: '正在做',
  todo: 'Todo',
  pending_acceptance: '待确认',
  done: '已完成',
}

const priorityLabels = {
  high: '高',
  medium: '中',
  low: '低',
}

const priorityRanks = {
  high: 'P1',
  medium: 'P2',
  low: 'P3',
}

function isAgentTask(task: Task) {
  return task.origin?.kind === 'agent' || Boolean(task.agent || task.agentSessionId)
}

function getColumnStatus(status: TaskStatus): TaskColumnStatus {
  return status === 'pending_acceptance' ? 'doing' : status
}

function hasActiveCompletionGate(task: Task) {
  return task.status === 'pending_acceptance' && !task.completionAcceptance?.resolvedAt
}

function hasActiveSessionReview(task: Task) {
  return Boolean(task.sessionReview && !task.sessionReview.resolvedAt)
}

function hasActiveParentCompletionReview(task: Task) {
  return Boolean(task.parentCompletionReview && !task.parentCompletionReview.resolvedAt)
}

function isUnresolvedAgentTask(task: Task) {
  return isAgentTask(task) && !task.parentTaskId && task.relationshipState !== 'independent_root'
}

function TaskReviewDots({ task }: { task: Task }) {
  return (
    <span className="topology-review-dots" aria-label="需要用户处理的提醒">
      {hasActiveCompletionGate(task) && <i className="completion" title="等待确认完成" />}
      {hasActiveSessionReview(task) && <i className="session" title="本轮会话已结束，任务未完成" />}
      {hasActiveParentCompletionReview(task) && <i className="parent" title="等待复核父任务" />}
    </span>
  )
}

function createAutomaticLayout(tasks: Task[]): Record<string, TopologyPosition> {
  if (tasks.length === 0) return {}
  const taskIds = new Set(tasks.map((task) => task.id))
  const neighbors = new Map(tasks.map((task) => [task.id, new Set<string>()]))
  for (const task of tasks) {
    if (!task.parentTaskId || !taskIds.has(task.parentTaskId)) continue
    neighbors.get(task.id)?.add(task.parentTaskId)
    neighbors.get(task.parentTaskId)?.add(task.id)
  }

  const components: Task[][] = []
  const visited = new Set<string>()
  for (const task of tasks) {
    if (visited.has(task.id)) continue
    const component: Task[] = []
    const queue = [task.id]
    visited.add(task.id)
    while (queue.length > 0) {
      const taskId = queue.shift()
      const current = taskId ? tasks.find((item) => item.id === taskId) : undefined
      if (current) component.push(current)
      for (const neighbor of taskId ? neighbors.get(taskId) ?? [] : []) {
        if (visited.has(neighbor)) continue
        visited.add(neighbor)
        queue.push(neighbor)
      }
    }
    components.push(component)
  }

  // Dagre 对大量互不相连的根任务会排成一条很长的带状区域。先分别布局每棵关系树，
  // 再按接近画布宽高比的货架方式打包，避免少量筛选结果仍继承全量画布的巨大空白。
  const componentLayouts = components
    .map((component) => {
      const graph = new dagre.graphlib.Graph()
      graph.setDefaultEdgeLabel(() => ({}))
      graph.setGraph({ rankdir: 'LR', ranksep: 48, nodesep: 18, marginx: 8, marginy: 8 })
      for (const task of component) graph.setNode(task.id, { width: nodeWidth, height: nodeHeight })
      for (const task of component) {
        if (task.parentTaskId && graph.hasNode(task.parentTaskId)) graph.setEdge(task.parentTaskId, task.id)
      }
      dagre.layout(graph)
      const points = component.map((task) => ({ taskId: task.id, point: graph.node(task.id) }))
      const minX = Math.min(...points.map(({ point }) => point.x - nodeWidth / 2))
      const minY = Math.min(...points.map(({ point }) => point.y - nodeHeight / 2))
      const maxX = Math.max(...points.map(({ point }) => point.x + nodeWidth / 2))
      const maxY = Math.max(...points.map(({ point }) => point.y + nodeHeight / 2))
      return { points, minX, minY, width: maxX - minX, height: maxY - minY }
    })
    .sort((left, right) => right.height * right.width - left.height * left.width)

  const estimatedArea = tasks.length * (nodeWidth + 34) * (nodeHeight + 24)
  const rowWidth = Math.max(nodeWidth * 2, Math.sqrt(estimatedArea * 1.55))
  const positions: Record<string, TopologyPosition> = {}
  let cursorX = 24
  let cursorY = 24
  let rowHeight = 0

  for (const layout of componentLayouts) {
    if (cursorX > 24 && cursorX + layout.width > rowWidth) {
      cursorX = 24
      cursorY += rowHeight + 34
      rowHeight = 0
    }
    for (const { taskId, point } of layout.points) {
      positions[taskId] = {
        x: cursorX + point.x - nodeWidth / 2 - layout.minX,
        y: cursorY + point.y - nodeHeight / 2 - layout.minY,
      }
    }
    cursorX += layout.width + 34
    rowHeight = Math.max(rowHeight, layout.height)
  }
  return positions
}

function buildTaskPath(task: Task, taskLookup: Map<string, Task>) {
  const path: Task[] = []
  const visited = new Set<string>()
  let current: Task | undefined = task

  while (current && !visited.has(current.id)) {
    visited.add(current.id)
    path.unshift(current)
    current = current.parentTaskId ? taskLookup.get(current.parentTaskId) : undefined
  }
  return path
}

function collectDescendantIds(parentTaskId: string, childrenByParentId: Map<string, Task[]>) {
  const descendants = new Set<string>()
  const queue = [...(childrenByParentId.get(parentTaskId) ?? [])]
  while (queue.length > 0) {
    const child = queue.shift()
    if (!child || descendants.has(child.id)) continue
    descendants.add(child.id)
    queue.push(...(childrenByParentId.get(child.id) ?? []))
  }
  return descendants
}

function TaskNode({ data, selected }: NodeProps<TaskFlowNode>) {
  const { task, childCount, collapsed, hiddenDescendantCount, connectMode, onChangeStatus, onToggleDone, onToggleCollapse } = data
  const agentTask = isAgentTask(task)
  const columnStatus = getColumnStatus(task.status)

  return (
    <article className={`global-task-node ${agentTask ? 'agent-task' : 'human-task'} status-${columnStatus} relationship-${task.relationshipState || 'root'} ${selected ? 'selected' : ''}`}>
      <Handle className={connectMode ? 'visible' : ''} type="target" position={Position.Left} />
      <header>
        <button
          className={`global-task-check ${task.status === 'done' ? 'checked' : ''}`}
          type="button"
          title={task.status === 'done' ? '重新打开任务' : '完成任务'}
          onClick={(event) => {
            event.stopPropagation()
            void onToggleDone(task.id)
          }}
        >
          {task.status === 'done' ? '✓' : ''}
        </button>
        <span className="global-task-title">
          <strong title={task.title}>{task.title}</strong>
          <TaskReviewDots task={task} />
        </span>
      </header>
      <div className="global-task-node-meta">
        <span className={`topology-status-dot status-${columnStatus}`} />
        <select
          value={columnStatus}
          aria-label={`${task.title} 的状态`}
          onPointerDown={(event) => event.stopPropagation()}
          onChange={(event) => void onChangeStatus(task.id, event.target.value as TaskColumnStatus)}
        >
          <option value="doing">正在做</option>
          <option value="todo">Todo</option>
          <option value="done">已完成</option>
        </select>
        <span className={`priority priority-${task.priority}`}>{priorityRanks[task.priority]} · {priorityLabels[task.priority]}</span>
        {agentTask && <span className="task-origin">AI</span>}
        {task.relationshipState === 'unresolved' && <span className="relationship-tag unresolved">待归类</span>}
        {task.relationshipState === 'independent_root' && <span className="relationship-tag independent">独立任务</span>}
      </div>
      <footer>
        <span>{task.project || '未分组'}</span>
        {childCount > 0 ? (
          <button
            className="global-task-collapse"
            type="button"
            title={collapsed ? `展开 ${hiddenDescendantCount} 个后代任务` : `收起 ${hiddenDescendantCount} 个后代任务`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation()
              onToggleCollapse(task.id)
            }}
          >
            <span aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
            {collapsed ? `已收起 ${hiddenDescendantCount}` : `${childCount} 个子任务`}
          </button>
        ) : (
          <span>{task.tags[0] ? `#${task.tags[0]}` : '无标签'}</span>
        )}
      </footer>
      <Handle className={connectMode ? 'visible' : ''} type="source" position={Position.Right} />
    </article>
  )
}

const nodeTypes = { task: TaskNode }

export function GlobalTopologyView({
  tasks,
  includedTaskIds,
  expandRelatedTasks,
  positions,
  onSavePositions,
  onLinkTasks,
  onLinkTasksBatch,
  onCreateParentTask,
  onSetRelationshipState,
  onUnlinkTask,
  onChangeStatus,
  onToggleDone,
  onCopyTask,
  canOpenAgentSession,
  onOpenAgentSession,
  onOpenCalendar,
  onEditTask,
  onDeleteTask,
  onAddTask,
}: GlobalTopologyViewProps) {
  const [mode, setMode] = useState<TopologyMode>('select')
  const [statusFilter, setStatusFilter] = useState<TopologyStatusFilter>('all')
  const [relationshipFilter, setRelationshipFilter] = useState<TopologyRelationshipFilter>('managed')
  const [inboxOpen, setInboxOpen] = useState(false)
  const [selectedOrphanIds, setSelectedOrphanIds] = useState<Set<string>>(() => new Set())
  const [relationType, setRelationType] = useState<TopologyRelationType>('subtask_of')
  const [parentSearch, setParentSearch] = useState('')
  const [selectedParentId, setSelectedParentId] = useState('')
  const [parentPickerOpen, setParentPickerOpen] = useState(false)
  const [newParentTitle, setNewParentTitle] = useState('')
  const [collapsedTaskIds, setCollapsedTaskIds] = useState<Set<string>>(() => new Set())
  const [selectedTaskId, setSelectedTaskId] = useState('')
  const [selectedEdgeId, setSelectedEdgeId] = useState('')
  const [pendingConnection, setPendingConnection] = useState<Connection | null>(null)
  const [localPositions, setLocalPositions] = useState<Record<string, TopologyPosition>>(positions)
  const [filteredPositionOverrides, setFilteredPositionOverrides] = useState<Record<string, TopologyPosition>>({})
  const [nodes, setNodes] = useState<TaskFlowNode[]>([])
  const [historyVersion, setHistoryVersion] = useState(0)
  const undoStackRef = useRef<Record<string, TopologyPosition>[]>([])
  const redoStackRef = useRef<Record<string, TopologyPosition>[]>([])

  const taskLookup = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks])
  const externallyVisibleTaskIds = useMemo(() => {
    const visibleIds = new Set(includedTaskIds)
    if (!expandRelatedTasks) return visibleIds

    const childrenByParentId = new Map<string, string[]>()
    for (const task of tasks) {
      if (!task.parentTaskId) continue
      childrenByParentId.set(task.parentTaskId, [...(childrenByParentId.get(task.parentTaskId) ?? []), task.id])
    }

    // 搜索命中只是入口。这里同时向父级和子级递归补齐整条关系链，
    // 避免用户只看到孤立命中节点，却无法判断它在任务树中的上下文。
    const queue = [...visibleIds]
    while (queue.length > 0) {
      const taskId = queue.shift()
      if (!taskId) continue
      const parentTaskId = taskLookup.get(taskId)?.parentTaskId
      const relatedIds = [parentTaskId, ...(childrenByParentId.get(taskId) ?? [])].filter(Boolean) as string[]
      for (const relatedId of relatedIds) {
        if (visibleIds.has(relatedId)) continue
        visibleIds.add(relatedId)
        queue.push(relatedId)
      }
    }
    return visibleIds
  }, [expandRelatedTasks, includedTaskIds, taskLookup, tasks])
  const automaticPositions = useMemo(() => createAutomaticLayout(tasks), [tasks])
  const unresolvedAgentTasks = useMemo(() => tasks.filter(isUnresolvedAgentTask), [tasks])
  const unresolvedTaskIds = useMemo(() => new Set(unresolvedAgentTasks.map((task) => task.id)), [unresolvedAgentTasks])
  const filteredTasks = useMemo(
    () => tasks.filter((task) => {
      if (!externallyVisibleTaskIds.has(task.id)) return false
      if (statusFilter !== 'all' && getColumnStatus(task.status) !== statusFilter) return false
      if (relationshipFilter === 'managed') return expandRelatedTasks || !unresolvedTaskIds.has(task.id)
      if (relationshipFilter === 'unresolved') return unresolvedTaskIds.has(task.id)
      if (relationshipFilter === 'independent_root') return task.relationshipState === 'independent_root'
      return true
    }),
    [expandRelatedTasks, externallyVisibleTaskIds, relationshipFilter, statusFilter, tasks, unresolvedTaskIds],
  )
  const filteredChildrenByParentId = useMemo(() => {
    const filteredTaskIds = new Set(filteredTasks.map((task) => task.id))
    const grouped = new Map<string, Task[]>()
    for (const task of filteredTasks) {
      if (!task.parentTaskId || !filteredTaskIds.has(task.parentTaskId)) continue
      grouped.set(task.parentTaskId, [...(grouped.get(task.parentTaskId) ?? []), task])
    }
    return grouped
  }, [filteredTasks])
  const collapsibleTaskIds = useMemo(() => new Set(filteredChildrenByParentId.keys()), [filteredChildrenByParentId])
  const hiddenDescendantCountByTaskId = useMemo(() => new Map(
    [...collapsibleTaskIds].map((taskId) => [taskId, collectDescendantIds(taskId, filteredChildrenByParentId).size]),
  ), [collapsibleTaskIds, filteredChildrenByParentId])
  const hiddenTaskIds = useMemo(() => {
    const hidden = new Set<string>()
    for (const taskId of collapsedTaskIds) {
      for (const descendantId of collectDescendantIds(taskId, filteredChildrenByParentId)) hidden.add(descendantId)
    }
    return hidden
  }, [collapsedTaskIds, filteredChildrenByParentId])
  const visibleTasks = useMemo(() => filteredTasks.filter((task) => !hiddenTaskIds.has(task.id)), [filteredTasks, hiddenTaskIds])
  const visibleTaskIds = useMemo(() => new Set(visibleTasks.map((task) => task.id)), [visibleTasks])
  // 收缩只改变节点可见性，不能拿收缩后的节点集合重新跑布局，否则剩余卡片会跳到新位置。
  // 筛选布局以完整 filteredTasks 为基准，展开时也能精确恢复到收缩前坐标。
  const filteredAutomaticPositions = useMemo(() => createAutomaticLayout(filteredTasks), [filteredTasks])
  const externalFilterActive = includedTaskIds.length !== tasks.length
  const filteredView = statusFilter !== 'all'
    || externalFilterActive
    || relationshipFilter === 'unresolved'
    || relationshipFilter === 'independent_root'
  const allParentsCollapsed = collapsibleTaskIds.size > 0 && [...collapsibleTaskIds].every((taskId) => collapsedTaskIds.has(taskId))

  useEffect(() => {
    setLocalPositions((current) => ({ ...automaticPositions, ...current, ...positions }))
  }, [automaticPositions, positions])

  useEffect(() => {
    // 筛选变化需要重新采用对应任务集合的紧凑坐标，但不能自动缩放或平移画布。
    // 视口只允许由用户拖动、缩放或点击 React Flow 的恢复视口按钮来改变。
    setFilteredPositionOverrides({})
  }, [filteredAutomaticPositions, relationshipFilter, statusFilter])

  useEffect(() => {
    const unresolvedIds = new Set(unresolvedAgentTasks.map((task) => task.id))
    setSelectedOrphanIds((current) => new Set([...current].filter((taskId) => unresolvedIds.has(taskId))))
  }, [unresolvedAgentTasks])

  useEffect(() => {
    setNodes(visibleTasks.map((task) => ({
      id: task.id,
      type: 'task',
      position: filteredView
        ? filteredPositionOverrides[task.id] ?? filteredAutomaticPositions[task.id] ?? { x: 0, y: 0 }
        : localPositions[task.id] ?? automaticPositions[task.id] ?? { x: 0, y: 0 },
      data: {
        task,
        childCount: filteredChildrenByParentId.get(task.id)?.length ?? 0,
        collapsed: collapsedTaskIds.has(task.id),
        hiddenDescendantCount: hiddenDescendantCountByTaskId.get(task.id) ?? 0,
        connectMode: mode === 'connect',
        onChangeStatus,
        onToggleDone,
        onToggleCollapse: (taskId: string) => {
          setCollapsedTaskIds((current) => {
            const next = new Set(current)
            if (next.has(taskId)) next.delete(taskId)
            else next.add(taskId)
            return next
          })
        },
      },
      selected: task.id === selectedTaskId,
      draggable: mode === 'select',
      connectable: mode === 'connect',
    })))
  }, [automaticPositions, collapsedTaskIds, filteredAutomaticPositions, filteredChildrenByParentId, filteredPositionOverrides, filteredView, hiddenDescendantCountByTaskId, localPositions, mode, onChangeStatus, onToggleDone, selectedTaskId, visibleTasks])

  useEffect(() => {
    if (selectedTaskId && (!taskLookup.has(selectedTaskId) || !visibleTaskIds.has(selectedTaskId))) setSelectedTaskId('')
  }, [selectedTaskId, taskLookup, visibleTaskIds])

  const edges = useMemo<TaskFlowEdge[]>(() => visibleTasks.flatMap((task) => {
    if (!task.parentTaskId || !visibleTaskIds.has(task.parentTaskId)) return []
    const relationType = task.parentLink?.type === 'discovered_from' ? 'discovered_from' : 'subtask_of'
    const followUpOnly = task.parentLink?.affectsParentCompletion === false
    const color = relationType === 'discovered_from' ? '#7c5ce5' : '#7d8792'
    return [{
      id: `${task.parentTaskId}->${task.id}`,
      source: task.parentTaskId,
      target: task.id,
      type: 'smoothstep',
      animated: relationType === 'discovered_from',
      selected: selectedEdgeId === `${task.parentTaskId}->${task.id}`,
      markerEnd: { type: MarkerType.ArrowClosed, color },
      style: { stroke: color, strokeWidth: selectedEdgeId === `${task.parentTaskId}->${task.id}` ? 2.8 : 1.8, strokeDasharray: followUpOnly ? '7 5' : undefined },
      data: { childTaskId: task.id, relationType },
    }]
  }), [selectedEdgeId, visibleTaskIds, visibleTasks])

  const selectedTask = selectedTaskId ? taskLookup.get(selectedTaskId) : undefined
  const selectedTaskChildren = useMemo(
    () => selectedTask ? tasks.filter((task) => task.parentTaskId === selectedTask.id) : [],
    [selectedTask, tasks],
  )
  const selectedTaskPath = useMemo(
    () => selectedTask ? buildTaskPath(selectedTask, taskLookup) : [],
    [selectedTask, taskLookup],
  )
  const orphanGroups = useMemo(() => {
    const groups = new Map<string, { repository: string; session: string; tasks: Task[] }>()
    for (const task of unresolvedAgentTasks) {
      const repository = task.repository || task.origin?.repository?.name || task.repositoryPath || '未关联代码库'
      const session = task.agentSessionId || task.origin?.agent?.sessionId || '未记录 Session'
      const key = `${repository}\u0000${session}`
      const group = groups.get(key) ?? { repository, session, tasks: [] }
      group.tasks.push(task)
      groups.set(key, group)
    }
    return [...groups.values()]
      .map((group) => ({
        ...group,
        tasks: group.tasks.sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
      }))
      .sort((left, right) => (right.tasks[0]?.createdAt || '').localeCompare(left.tasks[0]?.createdAt || ''))
  }, [unresolvedAgentTasks])
  const selectedOrphanTasks = useMemo(
    () => unresolvedAgentTasks.filter((task) => selectedOrphanIds.has(task.id)),
    [selectedOrphanIds, unresolvedAgentTasks],
  )
  const parentCandidates = useMemo(() => {
    const query = parentSearch.trim().toLocaleLowerCase('zh-CN')
    return tasks
      .filter((task) => !selectedOrphanIds.has(task.id))
      // 未归类 AI 根任务不能充当新父级，否则只是把待处理关系继续藏到另一层。
      .filter((task) => !isUnresolvedAgentTask(task))
      .filter((task) => !query || [task.title, task.detail, task.project, task.repository].some((value) => String(value || '').toLocaleLowerCase('zh-CN').includes(query)))
      .sort((left, right) => Number(isAgentTask(left)) - Number(isAgentTask(right)) || right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 30)
  }, [parentSearch, selectedOrphanIds, tasks])
  const selectedParentTask = selectedParentId ? taskLookup.get(selectedParentId) : undefined

  const onNodesChange = useCallback((changes: NodeChange<TaskFlowNode>[]) => {
    setNodes((current) => applyNodeChanges(changes, current))
  }, [])

  function commitPositions(nextPositions: Record<string, TopologyPosition>) {
    undoStackRef.current.push(localPositions)
    redoStackRef.current = []
    setLocalPositions(nextPositions)
    setHistoryVersion((current) => current + 1)
    void onSavePositions(nextPositions)
  }

  function handleNodeDragStop(_: unknown, node: TaskFlowNode) {
    if (filteredView) {
      setFilteredPositionOverrides((current) => ({ ...current, [node.id]: node.position }))
      return
    }
    commitPositions({ ...localPositions, [node.id]: node.position })
  }

  function undoLayout() {
    const previous = undoStackRef.current.pop()
    if (!previous) return
    redoStackRef.current.push(localPositions)
    setLocalPositions(previous)
    setHistoryVersion((current) => current + 1)
    void onSavePositions(previous)
  }

  function redoLayout() {
    const next = redoStackRef.current.pop()
    if (!next) return
    undoStackRef.current.push(localPositions)
    setLocalPositions(next)
    setHistoryVersion((current) => current + 1)
    void onSavePositions(next)
  }

  function autoLayout() {
    if (filteredView) {
      setFilteredPositionOverrides({})
      return
    }
    commitPositions(createAutomaticLayout(tasks))
  }

  async function confirmConnection(relationType: TopologyRelationType) {
    const connection = pendingConnection
    setPendingConnection(null)
    if (!connection?.source || !connection.target) return
    await onLinkTasks(connection.source, connection.target, relationType)
    setSelectedTaskId(connection.target)
  }

  async function unlinkSelectedEdge() {
    const edge = edges.find((item) => item.id === selectedEdgeId)
    if (!edge?.data?.childTaskId) return
    await onUnlinkTask(edge.data.childTaskId)
    setSelectedEdgeId('')
  }

  function toggleOrphanSelection(taskId: string) {
    setSelectedOrphanIds((current) => {
      const next = new Set(current)
      if (next.has(taskId)) next.delete(taskId)
      else next.add(taskId)
      return next
    })
  }

  async function bindSelectedOrphans() {
    if (!selectedParentId || selectedOrphanIds.size === 0) return
    await onLinkTasksBatch(selectedParentId, [...selectedOrphanIds], relationType)
    setSelectedOrphanIds(new Set())
    setSelectedParentId('')
    setParentSearch('')
    setParentPickerOpen(false)
  }

  async function createParentForSelectedOrphans() {
    if (!newParentTitle.trim() || selectedOrphanIds.size === 0) return
    await onCreateParentTask([...selectedOrphanIds], newParentTitle, relationType)
    setSelectedOrphanIds(new Set())
    setNewParentTitle('')
  }

  async function markSelectedAsIndependent() {
    if (selectedOrphanIds.size === 0) return
    await onSetRelationshipState([...selectedOrphanIds], 'independent_root')
    setSelectedOrphanIds(new Set())
  }

  void historyVersion

  return (
    <section className="global-topology-view">
      <div className="global-topology-toolbar">
        <div className="global-topology-mode" role="group" aria-label="拓扑编辑模式">
          <button className={mode === 'select' ? 'active' : ''} type="button" onClick={() => setMode('select')}>选择</button>
          <button className={mode === 'connect' ? 'active' : ''} type="button" onClick={() => setMode('connect')}>连线</button>
        </div>
        <button type="button" onClick={onAddTask}>＋ 新增任务</button>
        <button
          className={`relationship-inbox-trigger ${inboxOpen ? 'active' : ''}`}
          type="button"
          onClick={() => setInboxOpen((current) => !current)}
        >
          待归类 AI <span>{unresolvedAgentTasks.length}</span>
        </button>
      </div>

      {inboxOpen && (
        <aside className="relationship-inbox" aria-label="AI 任务关系收件箱">
          <header>
            <div>
              <strong>AI 任务待归类</strong>
              <span>{unresolvedAgentTasks.length} 个任务尚未确认父级</span>
            </div>
            <button type="button" title="关闭" onClick={() => setInboxOpen(false)}>×</button>
          </header>
          <div className="relationship-inbox-list">
            {orphanGroups.length === 0 && <div className="relationship-inbox-empty">没有待归类的 AI 任务</div>}
            {orphanGroups.map((group) => (
              <section className="relationship-inbox-group" key={`${group.repository}-${group.session}`}>
                <div className="relationship-inbox-group-title">
                  <strong>{group.repository}</strong>
                  <span title={group.session}>{group.session}</span>
                  <button
                    type="button"
                    onClick={() => setSelectedOrphanIds((current) => {
                      const next = new Set(current)
                      const allSelected = group.tasks.every((task) => next.has(task.id))
                      for (const task of group.tasks) {
                        if (allSelected) next.delete(task.id)
                        else next.add(task.id)
                      }
                      return next
                    })}
                  >
                    {group.tasks.every((task) => selectedOrphanIds.has(task.id)) ? '取消本组' : '选择本组'}
                  </button>
                </div>
                {group.tasks.map((task) => (
                  <label className={`relationship-inbox-task ${selectedOrphanIds.has(task.id) ? 'selected' : ''}`} key={task.id}>
                    <input type="checkbox" checked={selectedOrphanIds.has(task.id)} onChange={() => toggleOrphanSelection(task.id)} />
                    <span>
                      <strong>{task.title}</strong>
                      <small>{task.agent || task.origin?.agent?.name || 'agent'} · {new Date(task.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</small>
                    </span>
                    <TaskReviewDots task={task} />
                  </label>
                ))}
              </section>
            ))}
          </div>
          <footer>
            <div className="relationship-selection-summary">
              <span>已选 {selectedOrphanTasks.length}</span>
              <div role="group" aria-label="关系类型">
                <button className={relationType === 'subtask_of' ? 'active' : ''} type="button" onClick={() => setRelationType('subtask_of')}>子任务</button>
                <button className={relationType === 'discovered_from' ? 'active' : ''} type="button" onClick={() => setRelationType('discovered_from')}>派生</button>
              </div>
            </div>
            <div className="relationship-parent-picker">
              <button
                className="relationship-parent-value"
                type="button"
                disabled={selectedOrphanIds.size === 0}
                onClick={() => setParentPickerOpen((current) => !current)}
              >
                {selectedParentTask?.title || '选择已有父任务'}
              </button>
              {parentPickerOpen && (
                <div className="relationship-parent-popover">
                  <input autoFocus value={parentSearch} placeholder="搜索标题、详情、项目或仓库" onChange={(event) => setParentSearch(event.target.value)} />
                  <div>
                    {parentCandidates.map((task) => (
                      <button
                        className={task.id === selectedParentId ? 'selected' : ''}
                        type="button"
                        key={task.id}
                        onClick={() => {
                          setSelectedParentId(task.id)
                          setParentPickerOpen(false)
                        }}
                      >
                        <strong>{task.title}</strong>
                        <small>{isAgentTask(task) ? 'AI' : '人工'} · {task.project || '未分组'}</small>
                      </button>
                    ))}
                    {parentCandidates.length === 0 && <span>没有匹配任务</span>}
                  </div>
                </div>
              )}
              <button className="primary" type="button" disabled={!selectedParentId || selectedOrphanIds.size === 0} onClick={() => void bindSelectedOrphans()}>绑定</button>
            </div>
            <div className="relationship-create-parent">
              <input value={newParentTitle} disabled={selectedOrphanIds.size === 0} placeholder="输入新的人工父任务标题" onChange={(event) => setNewParentTitle(event.target.value)} />
              <button type="button" disabled={!newParentTitle.trim() || selectedOrphanIds.size === 0} onClick={() => void createParentForSelectedOrphans()}>创建并绑定</button>
            </div>
            <button className="relationship-independent-action" type="button" disabled={selectedOrphanIds.size === 0} onClick={() => void markSelectedAsIndependent()}>标记为独立任务</button>
          </footer>
        </aside>
      )}

      <div className={`global-topology-body ${selectedTask ? 'has-selection' : ''}`}>
        <div className={`global-topology-canvas mode-${mode}`}>
          <ReactFlow<TaskFlowNode, TaskFlowEdge>
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onNodeClick={(_, node) => {
              setSelectedTaskId(node.id)
              setSelectedEdgeId('')
            }}
            onEdgeClick={(_, edge) => {
              setSelectedEdgeId(edge.id)
              setSelectedTaskId(edge.target)
            }}
            onPaneClick={() => {
              setSelectedTaskId('')
              setSelectedEdgeId('')
            }}
            onNodeDragStop={handleNodeDragStop}
            onConnect={(connection) => setPendingConnection(connection)}
            minZoom={minTopologyZoom}
            maxZoom={maxTopologyZoom}
            deleteKeyCode={null}
            proOptions={{ hideAttribution: true }}
            nodesConnectable={mode === 'connect'}
            nodesDraggable={mode === 'select'}
            selectionOnDrag={mode === 'select'}
            panOnDrag
            panOnScroll
            panOnScrollSpeed={0.8}
            zoomOnScroll={false}
            zoomOnPinch
          >
            <Background variant={BackgroundVariant.Lines} gap={24} size={1} color="#ece8df" />
            <Controls position="bottom-right" showInteractive={false} />
            <MiniMap
              position="bottom-right"
              pannable
              zoomable
              nodeColor={(node) => isAgentTask((node.data as TaskNodeData).task) ? '#d9cdfc' : '#f4dc93'}
              maskColor="rgba(248, 247, 242, 0.72)"
            />
          </ReactFlow>
          <div className="topology-floating-panel topology-layout-tools" role="toolbar" aria-label="画布布局工具">
            <button type="button" onClick={autoLayout} title="自动整理任务位置">
              <span aria-hidden="true">✣</span><b>自动整理</b>
            </button>
            <button
              type="button"
              disabled={collapsibleTaskIds.size === 0}
              title={allParentsCollapsed ? '展开所有父节点' : '收起所有父节点'}
              onClick={() => setCollapsedTaskIds(allParentsCollapsed ? new Set() : new Set(collapsibleTaskIds))}
            >
              <span aria-hidden="true">{allParentsCollapsed ? '▾' : '▸'}</span><b>{allParentsCollapsed ? '全部展开' : '全部收起'}</b>
            </button>
            <span className="floating-tool-divider" aria-hidden="true" />
            <button className="icon-only" type="button" title="撤销布局" disabled={undoStackRef.current.length === 0} onClick={undoLayout}>↶</button>
            <button className="icon-only" type="button" title="重做布局" disabled={redoStackRef.current.length === 0} onClick={redoLayout}>↷</button>
            {selectedEdgeId && (
              <>
                <span className="floating-tool-divider" aria-hidden="true" />
                <button className="danger-action" type="button" onClick={() => void unlinkSelectedEdge()}>解除关系</button>
              </>
            )}
          </div>
          <div className="topology-floating-panel topology-filter-tools" aria-label="拓扑筛选">
            <span className="global-topology-visible-count">当前 {visibleTasks.length}</span>
            <select value={statusFilter} aria-label="按状态筛选" onChange={(event) => setStatusFilter(event.target.value as TopologyStatusFilter)}>
              <option value="all">全部状态</option>
              <option value="doing">正在做</option>
              <option value="todo">Todo</option>
              <option value="done">已完成</option>
            </select>
            <select value={relationshipFilter} aria-label="按关系状态筛选" onChange={(event) => setRelationshipFilter(event.target.value as TopologyRelationshipFilter)}>
              <option value="managed">已管理</option>
              <option value="all">全部关系</option>
              <option value="unresolved">待归类</option>
              <option value="independent_root">独立任务</option>
            </select>
          </div>
          <div className="global-topology-legend">
            <span><i className="human" />人工任务</span>
            <span><i className="agent" />AI 任务</span>
            <span><i className="subtask" />子任务</span>
            <span><i className="derived" />派生</span>
            <span><i className="follow-up" />不阻塞父任务</span>
          </div>
          {pendingConnection && (
            <div className="topology-relation-menu" role="dialog" aria-label="选择任务关系">
              <strong>建立关系</strong>
              <p>连线方向：父任务 → 子任务</p>
              <button type="button" onClick={() => void confirmConnection('subtask_of')}>设为子任务</button>
              <button type="button" onClick={() => void confirmConnection('discovered_from')}>标记为派生</button>
              <button className="cancel" type="button" onClick={() => setPendingConnection(null)}>取消</button>
            </div>
          )}
          {visibleTasks.length === 0 && <div className="global-topology-empty">当前筛选条件下没有任务</div>}
        </div>

        {selectedTask && (
          <aside className="global-topology-inspector">
            <>
              <header>
                <div>
                  <span className={`topology-status-dot status-${getColumnStatus(selectedTask.status)}`} />
                  <strong>{selectedTask.title}</strong>
                  <TaskReviewDots task={selectedTask} />
                </div>
                <span className={`inspector-origin ${isAgentTask(selectedTask) ? 'agent' : 'human'}`}>{isAgentTask(selectedTask) ? 'AI 任务' : '人工任务'}</span>
              </header>
              <div className="global-topology-inspector-scroll">
                <div className="inspector-badges">
                  <span>{statusLabels[selectedTask.status]}</span>
                  <span>{priorityLabels[selectedTask.priority]}优先级</span>
                  {selectedTask.project && <span>{selectedTask.project}</span>}
                </div>
                <section>
                  <h3>任务内容</h3>
                  <p>{selectedTask.detail || '暂无任务详情'}</p>
                </section>
                <section>
                  <h3>关系与进度</h3>
                  <p>{selectedTaskPath.map((task) => task.title).join(' › ')}</p>
                  <div className="inspector-progress">
                    <span style={{ width: `${selectedTaskChildren.length === 0 ? 0 : (selectedTaskChildren.filter((task) => task.status === 'done').length / selectedTaskChildren.length) * 100}%` }} />
                  </div>
                  <small>{selectedTaskChildren.filter((task) => task.status === 'done').length} / {selectedTaskChildren.length} 个子任务已完成</small>
                </section>
                {(selectedTask.repository || selectedTask.repositoryPath || selectedTask.agentSessionId) && (
                  <section>
                    <h3>Agent 上下文</h3>
                    {selectedTask.repository && <p>{selectedTask.repository}</p>}
                    {selectedTask.repositoryPath && <p className="inspector-code">{selectedTask.repositoryPath}</p>}
                    {selectedTask.agentSessionId && <p className="inspector-code">{selectedTask.agent || 'agent'} · {selectedTask.agentSessionId}</p>}
                  </section>
                )}
              </div>
              <footer>
                {selectedTask.status !== 'done' && (
                  <button className="primary" type="button" onClick={() => void onToggleDone(selectedTask.id)}>
                    {selectedTask.status === 'pending_acceptance' ? '确认完成' : '完成'}
                  </button>
                )}
                {selectedTask.status === 'done' && <button type="button" onClick={() => void onChangeStatus(selectedTask.id, 'todo')}>转待办</button>}
                {selectedTask.status === 'done' && <button type="button" onClick={() => void onChangeStatus(selectedTask.id, 'doing')}>继续做</button>}
                {selectedTask.status !== 'done' && selectedTask.status !== 'doing' && <button type="button" onClick={() => void onChangeStatus(selectedTask.id, 'doing')}>开始</button>}
                {selectedTask.status !== 'done' && selectedTask.status !== 'todo' && <button type="button" onClick={() => void onChangeStatus(selectedTask.id, 'todo')}>待办</button>}
                <button type="button" onClick={() => void onCopyTask(selectedTask)}>复制</button>
                {canOpenAgentSession(selectedTask) && <button type="button" onClick={() => void onOpenAgentSession(selectedTask)}>会话</button>}
                {(selectedTask.reminderAt || selectedTask.dueAt) && <button type="button" onClick={() => void onOpenCalendar(selectedTask)}>日历</button>}
                <button type="button" onClick={() => onEditTask(selectedTask)}>编辑</button>
                {selectedTask.relationshipState === 'independent_root' && (
                  <button type="button" onClick={() => void onSetRelationshipState([selectedTask.id], 'unresolved')}>移回待归类</button>
                )}
                <button className="danger" type="button" onClick={() => void onDeleteTask(selectedTask.id)}>删除</button>
              </footer>
            </>
          </aside>
        )}
      </div>
    </section>
  )
}
