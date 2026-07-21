import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import dagre from '@dagrejs/dagre'
import { Link2, MousePointer2, Redo2, Search, Undo2, X } from 'lucide-react'
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  SelectionMode,
  applyNodeChanges,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
  type OnConnectEnd,
  type ReactFlowInstance,
  type Viewport,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './GlobalTopologyView.css'
import { collectInvalidTopologyParentIds, getTopologyParentCandidates } from './topologyParentBinding'
import { collectRelationshipNetworkIds, normalizeTopologyProject } from './topologyNetwork'
import type { Task, TaskColumnStatus, TaskParentLink, TaskRelationshipState, TaskStatus, TopologyFocusRequest, TopologyPosition, TopologyTaskCreateRequest } from './types'

type TopologyRelationType = TaskParentLink['type']
type TopologyStatusFilter = 'all' | TaskColumnStatus
type TopologyRelationshipFilter = 'managed' | 'all' | 'unresolved' | 'independent_root'

export interface GlobalTopologyViewMemory {
  statusFilter: TopologyStatusFilter
  projectFilter: string
  relationshipFilter: TopologyRelationshipFilter
  inboxOpen: boolean
  selectedOrphanIds: string[]
  relationType: TopologyRelationType
  parentSearch: string
  selectedParentId: string
  parentPickerOpen: boolean
  newParentTitle: string
  collapsedTaskIds: string[]
  selectedTaskId: string
  selectedTaskIds: string[]
  selectedEdgeId: string
  filteredPositionOverrides: Record<string, TopologyPosition>
  viewport: Viewport
}

interface GlobalTopologyViewProps {
  tasks: Task[]
  includedTaskIds: string[]
  focusRequest: TopologyFocusRequest | null
  onFocusRequestHandled: (requestId: number) => void
  positions: Record<string, TopologyPosition>
  onSavePositions: (positions: Record<string, TopologyPosition>) => Promise<void> | void
  onLinkTasks: (parentTaskId: string, childTaskId: string, relationType: TopologyRelationType) => Promise<void> | void
  onLinkTasksBatch: (parentTaskId: string, childTaskIds: string[], relationType: TopologyRelationType) => Promise<void> | void
  onCreateParentTask: (childTaskIds: string[], title: string, relationType: TopologyRelationType) => Promise<void> | void
  onCreateTask: (request: TopologyTaskCreateRequest) => void
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
  initialMemory?: GlobalTopologyViewMemory
  onMemoryChange: (memory: GlobalTopologyViewMemory) => void
}

interface TaskNodeData extends Record<string, unknown> {
  task: Task
  childCount: number
  collapsed: boolean
  hiddenDescendantCount: number
  parentPickState: '' | 'child' | 'eligible' | 'invalid'
  onChangeStatus: GlobalTopologyViewProps['onChangeStatus']
  onToggleDone: GlobalTopologyViewProps['onToggleDone']
  onToggleCollapse: (taskId: string) => void
}

type TaskFlowNode = Node<TaskNodeData, 'task'>
type TaskFlowEdge = Edge<{ childTaskId: string; relationType: TopologyRelationType }>

interface ParentBindingSnapshot {
  childTaskId: string
  parentTaskId: string
  relationType: TopologyRelationType
}

interface ParentBindingNotice {
  message: string
  previousBindings?: ParentBindingSnapshot[]
}

interface TopologyParentPickerProps {
  tasks: Task[]
  childTaskIds: string[]
  searchValue: string
  relationType: TopologyRelationType
  onSearchChange: (value: string) => void
  onRelationTypeChange: (value: TopologyRelationType) => void
  onSelectParent: (parentTaskId: string) => void
  onSelectFromCanvas: () => void
  onUnlink: () => void
  onClose: () => void
}

const nodeWidth = 236
const nodeHeight = 112
const minTopologyZoom = 0.08
const maxTopologyZoom = 1.8
const ungroupedProjectFilter = '__ungrouped__'

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

function setsEqual(left: Set<string>, right: Set<string>) {
  return left.size === right.size && [...left].every((value) => right.has(value))
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
  // 关系收件箱只处理当前仍在执行的 AI 任务。Todo、待确认和已完成任务继续保留在
  // 拓扑中，但不占用待归类入口，避免历史任务淹没用户眼下需要整理的工作。
  return task.status === 'doing'
    && isAgentTask(task)
    && !task.parentTaskId
    && task.relationshipState !== 'independent_root'
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
  const { task, childCount, collapsed, hiddenDescendantCount, parentPickState, onChangeStatus, onToggleDone, onToggleCollapse } = data
  const agentTask = isAgentTask(task)
  const columnStatus = getColumnStatus(task.status)

  return (
    <article className={`global-task-node ${agentTask ? 'agent-task' : 'human-task'} status-${columnStatus} relationship-${task.relationshipState || 'root'} ${selected ? 'selected' : ''} ${parentPickState ? `parent-pick-${parentPickState}` : ''}`}>
      <Handle id="parent" type="target" position={Position.Left} title="拖到空白处创建父任务" />
      {parentPickState === 'eligible' && (
        <span className="parent-pick-candidate-icon" title="设为父任务">
          <Link2 aria-hidden="true" size={13} strokeWidth={2} />
        </span>
      )}
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
      <Handle id="child" type="source" position={Position.Right} title="拖到空白处创建子任务" />
    </article>
  )
}

function TopologyParentPicker({
  tasks,
  childTaskIds,
  searchValue,
  relationType,
  onSearchChange,
  onRelationTypeChange,
  onSelectParent,
  onSelectFromCanvas,
  onUnlink,
  onClose,
}: TopologyParentPickerProps) {
  const childTaskIdSet = useMemo(() => new Set(childTaskIds), [childTaskIds])
  const childTasks = useMemo(() => tasks.filter((task) => childTaskIdSet.has(task.id)), [childTaskIdSet, tasks])
  const candidates = useMemo(
    () => getTopologyParentCandidates(tasks, childTaskIds, searchValue),
    [childTaskIds, searchValue, tasks],
  )
  const hasParent = childTasks.some((task) => Boolean(task.parentTaskId))

  return (
    <div className="topology-parent-picker" role="dialog" aria-label="选择父任务" onPointerDown={(event) => event.stopPropagation()}>
      <header>
        <div>
          <strong>{childTaskIds.length > 1 ? `为 ${childTaskIds.length} 个任务选择父任务` : '选择父任务'}</strong>
          <span>点击候选后立即保存</span>
        </div>
        <button className="icon-button" type="button" title="关闭" aria-label="关闭父任务选择器" onClick={onClose}>
          <X aria-hidden="true" size={15} />
        </button>
      </header>
      <div className="topology-parent-picker-tools">
        <label>
          <Search aria-hidden="true" size={14} />
          <input
            autoFocus
            aria-label="搜索父任务"
            value={searchValue}
            placeholder="搜索标题、项目、标签"
            onChange={(event) => onSearchChange(event.target.value)}
          />
        </label>
        <div className="topology-parent-relation-type" role="group" aria-label="关系类型">
          <button className={relationType === 'subtask_of' ? 'active' : ''} type="button" onClick={() => onRelationTypeChange('subtask_of')}>子任务</button>
          <button className={relationType === 'discovered_from' ? 'active' : ''} type="button" onClick={() => onRelationTypeChange('discovered_from')}>派生</button>
        </div>
        <button className="topology-parent-canvas-action" type="button" onClick={onSelectFromCanvas}>
          <MousePointer2 aria-hidden="true" size={14} />
          从画布中选择
        </button>
      </div>
      <div className="topology-parent-candidate-list" role="listbox" aria-label="父任务候选">
        {candidates.map((candidate) => {
          const currentCount = childTasks.filter((task) => task.parentTaskId === candidate.id).length
          return (
            <button
              className={currentCount === childTasks.length ? 'current' : ''}
              type="button"
              role="option"
              aria-selected={currentCount === childTasks.length}
              key={candidate.id}
              onClick={() => onSelectParent(candidate.id)}
            >
              <span>
                <strong>{candidate.title}</strong>
                <small>{statusLabels[candidate.status]} · {candidate.project || '未分组'}{isAgentTask(candidate) ? ` · ${candidate.agent || 'AI'}` : ''}</small>
              </span>
              {currentCount > 0 && <em>{currentCount === childTasks.length ? '当前' : `${currentCount} 个已绑定`}</em>}
            </button>
          )
        })}
        {candidates.length === 0 && <p>没有匹配的父任务</p>}
      </div>
      {hasParent && (
        <footer>
          <button type="button" onClick={onUnlink}>移除父任务</button>
        </footer>
      )}
    </div>
  )
}

const nodeTypes = { task: TaskNode }

export function GlobalTopologyView({
  tasks,
  includedTaskIds,
  focusRequest,
  onFocusRequestHandled,
  positions,
  onSavePositions,
  onLinkTasks,
  onLinkTasksBatch,
  onCreateParentTask,
  onCreateTask,
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
  initialMemory,
  onMemoryChange,
}: GlobalTopologyViewProps) {
  const [statusFilter, setStatusFilter] = useState<TopologyStatusFilter>(initialMemory?.statusFilter ?? 'all')
  const [projectFilter, setProjectFilter] = useState(initialMemory?.projectFilter ?? 'all')
  const [relationshipFilter, setRelationshipFilter] = useState<TopologyRelationshipFilter>(initialMemory?.relationshipFilter ?? 'managed')
  const [inboxOpen, setInboxOpen] = useState(initialMemory?.inboxOpen ?? false)
  const [selectedOrphanIds, setSelectedOrphanIds] = useState<Set<string>>(() => new Set(initialMemory?.selectedOrphanIds))
  const [relationType, setRelationType] = useState<TopologyRelationType>(initialMemory?.relationType ?? 'subtask_of')
  const [parentSearch, setParentSearch] = useState(initialMemory?.parentSearch ?? '')
  const [selectedParentId, setSelectedParentId] = useState(initialMemory?.selectedParentId ?? '')
  const [parentPickerOpen, setParentPickerOpen] = useState(initialMemory?.parentPickerOpen ?? false)
  const [newParentTitle, setNewParentTitle] = useState(initialMemory?.newParentTitle ?? '')
  const [collapsedTaskIds, setCollapsedTaskIds] = useState<Set<string>>(() => new Set(initialMemory?.collapsedTaskIds))
  const [selectedTaskId, setSelectedTaskId] = useState(initialMemory?.selectedTaskId ?? '')
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(() => new Set(initialMemory?.selectedTaskIds))
  const [selectedEdgeId, setSelectedEdgeId] = useState(initialMemory?.selectedEdgeId ?? '')
  const [parentBindingTaskIds, setParentBindingTaskIds] = useState<string[]>([])
  const [quickParentPickerOpen, setQuickParentPickerOpen] = useState(false)
  const [quickParentSearch, setQuickParentSearch] = useState('')
  const [canvasParentPickActive, setCanvasParentPickActive] = useState(false)
  const [hoveredParentCandidateId, setHoveredParentCandidateId] = useState('')
  const [parentBindingNotice, setParentBindingNotice] = useState<ParentBindingNotice | null>(null)
  const [parentBindingBusy, setParentBindingBusy] = useState(false)
  const [localPositions, setLocalPositions] = useState<Record<string, TopologyPosition>>(positions)
  const [filteredPositionOverrides, setFilteredPositionOverrides] = useState<Record<string, TopologyPosition>>(initialMemory?.filteredPositionOverrides ?? {})
  const [nodes, setNodes] = useState<TaskFlowNode[]>([])
  const [historyVersion, setHistoryVersion] = useState(0)
  const selectedTaskIdsRef = useRef<Set<string>>(new Set(initialMemory?.selectedTaskIds))
  const undoStackRef = useRef<Record<string, TopologyPosition>[]>([])
  const redoStackRef = useRef<Record<string, TopologyPosition>[]>([])
  const parentBindingBusyRef = useRef(false)
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance<TaskFlowNode, TaskFlowEdge> | null>(null)
  const preparedFocusRequestIdRef = useRef(0)
  const handledFocusRequestIdRef = useRef(0)
  const reactFlowRef = useRef<ReactFlowInstance<TaskFlowNode, TaskFlowEdge> | null>(null)
  const viewportRef = useRef<Viewport>(initialMemory?.viewport ?? { x: 0, y: 0, zoom: 1 })
  const memoryRef = useRef<GlobalTopologyViewMemory | undefined>(undefined)
  const onMemoryChangeRef = useRef(onMemoryChange)
  const filterResetReadyRef = useRef(false)

  onMemoryChangeRef.current = onMemoryChange
  memoryRef.current = {
    statusFilter,
    projectFilter,
    relationshipFilter,
    inboxOpen,
    selectedOrphanIds: [...selectedOrphanIds],
    relationType,
    parentSearch,
    selectedParentId,
    parentPickerOpen,
    newParentTitle,
    collapsedTaskIds: [...collapsedTaskIds],
    selectedTaskId,
    selectedTaskIds: [...selectedTaskIds],
    selectedEdgeId,
    filteredPositionOverrides,
    viewport: viewportRef.current,
  }

  useEffect(() => () => {
    // 主视图使用条件渲染，切到看板或日历会卸载整个拓扑组件。卸载前把纯 UI 状态
    // 提升到 App 层，下一次挂载时恢复；正在拖线属于半完成操作，故意不进入快照。
    if (memoryRef.current) onMemoryChangeRef.current(memoryRef.current)
  }, [])

  const taskLookup = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks])
  const parentBindingTaskIdSet = useMemo(() => new Set(parentBindingTaskIds), [parentBindingTaskIds])
  const invalidParentCandidateIds = useMemo(
    () => collectInvalidTopologyParentIds(tasks, parentBindingTaskIds),
    [parentBindingTaskIds, tasks],
  )
  const eligibleParentCandidateIds = useMemo(
    () => new Set(tasks.filter((task) => !invalidParentCandidateIds.has(task.id)).map((task) => task.id)),
    [invalidParentCandidateIds, tasks],
  )
  const automaticPositions = useMemo(() => createAutomaticLayout(tasks), [tasks])
  const unresolvedAgentTasks = useMemo(() => tasks.filter(isUnresolvedAgentTask), [tasks])
  const unresolvedTaskIds = useMemo(() => new Set(unresolvedAgentTasks.map((task) => task.id)), [unresolvedAgentTasks])
  const projectOptions = useMemo(() => [...new Set(tasks.map((task) => normalizeTopologyProject(task.project, ungroupedProjectFilter)))]
    .sort((left, right) => {
      if (left === ungroupedProjectFilter) return 1
      if (right === ungroupedProjectFilter) return -1
      return left.localeCompare(right, 'zh-CN')
    }), [tasks])
  useEffect(() => {
    if (projectFilter !== 'all' && !projectOptions.includes(projectFilter)) setProjectFilter('all')
  }, [projectFilter, projectOptions])
  const directlyMatchedTaskIds = useMemo(() => {
    const includedIds = new Set(includedTaskIds)
    return new Set(tasks.filter((task) => {
      if (!includedIds.has(task.id)) return false
      if (projectFilter !== 'all' && normalizeTopologyProject(task.project, ungroupedProjectFilter) !== projectFilter) return false
      if (statusFilter !== 'all' && getColumnStatus(task.status) !== statusFilter) return false
      if (relationshipFilter === 'managed') return !unresolvedTaskIds.has(task.id)
      if (relationshipFilter === 'unresolved') return unresolvedTaskIds.has(task.id)
      if (relationshipFilter === 'independent_root') return task.relationshipState === 'independent_root'
      return true
    }).map((task) => task.id))
  }, [includedTaskIds, projectFilter, relationshipFilter, statusFilter, tasks, unresolvedTaskIds])
  const filteredTasks = useMemo(() => {
    const completeNetworkIds = collectRelationshipNetworkIds(tasks, directlyMatchedTaskIds)
    return tasks.filter((task) => completeNetworkIds.has(task.id))
  }, [directlyMatchedTaskIds, tasks])
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
    || projectFilter !== 'all'
    || relationshipFilter === 'unresolved'
    || relationshipFilter === 'independent_root'
  const allParentsCollapsed = collapsibleTaskIds.size > 0 && [...collapsibleTaskIds].every((taskId) => collapsedTaskIds.has(taskId))

  useEffect(() => {
    setLocalPositions((current) => ({ ...automaticPositions, ...current, ...positions }))
  }, [automaticPositions, positions])

  useEffect(() => {
    // 筛选变化需要重新采用对应任务集合的紧凑坐标，但不能自动缩放或平移画布。
    // 视口只允许由用户拖动、缩放或点击 React Flow 的恢复视口按钮来改变。
    // 首次挂载可能正在恢复筛选视图，不能把快照中的临时节点位置立即清空。
    if (!filterResetReadyRef.current) {
      filterResetReadyRef.current = true
      return
    }
    setFilteredPositionOverrides({})
  }, [filteredAutomaticPositions, projectFilter, relationshipFilter, statusFilter])

  useEffect(() => {
    const unresolvedIds = new Set(unresolvedAgentTasks.map((task) => task.id))
    setSelectedOrphanIds((current) => new Set([...current].filter((taskId) => unresolvedIds.has(taskId))))
  }, [unresolvedAgentTasks])

  useEffect(() => {
    if (!parentBindingNotice) return undefined
    const timeout = window.setTimeout(() => setParentBindingNotice(null), parentBindingNotice.previousBindings ? 7000 : 3500)
    return () => window.clearTimeout(timeout)
  }, [parentBindingNotice])

  useEffect(() => {
    if (!quickParentPickerOpen && !canvasParentPickActive) return undefined
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setQuickParentPickerOpen(false)
      setCanvasParentPickActive(false)
      setHoveredParentCandidateId('')
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [canvasParentPickActive, quickParentPickerOpen])

  useEffect(() => {
    const existingTaskIds = new Set(tasks.map((task) => task.id))
    const nextTaskIds = parentBindingTaskIds.filter((taskId) => existingTaskIds.has(taskId))
    if (nextTaskIds.length !== parentBindingTaskIds.length) setParentBindingTaskIds(nextTaskIds)
    if (nextTaskIds.length === 0) {
      setQuickParentPickerOpen(false)
      setCanvasParentPickActive(false)
      setHoveredParentCandidateId('')
    }
  }, [parentBindingTaskIds, tasks])

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
        parentPickState: !canvasParentPickActive
          ? ''
          : parentBindingTaskIdSet.has(task.id)
            ? 'child'
            : !eligibleParentCandidateIds.has(task.id)
              ? 'invalid'
              : 'eligible',
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
      selected: selectedTaskIdsRef.current.has(task.id),
      draggable: !canvasParentPickActive,
      connectable: !canvasParentPickActive,
    })))
  }, [automaticPositions, canvasParentPickActive, collapsedTaskIds, eligibleParentCandidateIds, filteredAutomaticPositions, filteredChildrenByParentId, filteredPositionOverrides, filteredView, hiddenDescendantCountByTaskId, localPositions, onChangeStatus, onToggleDone, parentBindingTaskIdSet, visibleTasks])

  useEffect(() => {
    const current = selectedTaskIdsRef.current
    const next = new Set([...current].filter((taskId) => visibleTaskIds.has(taskId)))
    if (!setsEqual(current, next)) {
      selectedTaskIdsRef.current = next
      setSelectedTaskIds(next)
    }
    if (selectedTaskId && (!taskLookup.has(selectedTaskId) || !visibleTaskIds.has(selectedTaskId))) setSelectedTaskId('')
  }, [selectedTaskId, taskLookup, visibleTaskIds])

  useEffect(() => {
    if (!focusRequest || preparedFocusRequestIdRef.current >= focusRequest.requestId) return
    preparedFocusRequestIdRef.current = focusRequest.requestId

    const targetTask = taskLookup.get(focusRequest.taskId)
    if (!targetTask) {
      handledFocusRequestIdRef.current = focusRequest.requestId
      onFocusRequestHandled(focusRequest.requestId)
      return
    }

    // Explicit cross-view navigation is the one action allowed to override filters and collapsed
    // ancestors. Without this preparation a valid target could remain hidden even after switching
    // to topology. Normal view switching never runs this path, so the user's viewport stays intact.
    setStatusFilter('all')
    setProjectFilter('all')
    setRelationshipFilter('all')
    const targetPathIds = new Set(buildTaskPath(targetTask, taskLookup).map((task) => task.id))
    setCollapsedTaskIds((current) => {
      const next = new Set([...current].filter((taskId) => !targetPathIds.has(taskId)))
      return setsEqual(current, next) ? current : next
    })
  }, [focusRequest, onFocusRequestHandled, taskLookup])

  useEffect(() => {
    if (!focusRequest
      || handledFocusRequestIdRef.current >= focusRequest.requestId
      || preparedFocusRequestIdRef.current < focusRequest.requestId
      || statusFilter !== 'all'
      || projectFilter !== 'all'
      || relationshipFilter !== 'all'
      || !visibleTaskIds.has(focusRequest.taskId)) return undefined

    const targetNode = nodes.find((node) => node.id === focusRequest.taskId)
    if (!targetNode || !flowInstance) return undefined

    selectSingleTask(focusRequest.taskId)
    const frame = requestAnimationFrame(() => {
      const liveNode = flowInstance.getNode(focusRequest.taskId)
      if (!liveNode) return

      const position = liveNode.position
      const currentZoom = flowInstance.getViewport().zoom
      void flowInstance.setCenter(
        position.x + nodeWidth / 2,
        position.y + nodeHeight / 2,
        { zoom: Math.max(currentZoom, 0.9), duration: 0 },
      )
      handledFocusRequestIdRef.current = focusRequest.requestId
      onFocusRequestHandled(focusRequest.requestId)
    })
    return () => cancelAnimationFrame(frame)
  }, [flowInstance, focusRequest, nodes, onFocusRequestHandled, projectFilter, relationshipFilter, statusFilter, visibleTaskIds])

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
  const parentPreviewEdges = useMemo<TaskFlowEdge[]>(() => {
    if (!canvasParentPickActive || !hoveredParentCandidateId || !eligibleParentCandidateIds.has(hoveredParentCandidateId)) return []
    return parentBindingTaskIds.flatMap((childTaskId) => {
      const childTask = taskLookup.get(childTaskId)
      if (!childTask || !visibleTaskIds.has(childTaskId) || childTask.parentTaskId === hoveredParentCandidateId) return []
      return [{
        id: `parent-preview-${hoveredParentCandidateId}->${childTaskId}`,
        source: hoveredParentCandidateId,
        target: childTaskId,
        type: 'smoothstep',
        className: 'parent-preview-edge',
        interactionWidth: 0,
        selectable: false,
        focusable: false,
        animated: false,
        markerEnd: { type: MarkerType.ArrowClosed, color: '#246cf0' },
        style: { stroke: '#246cf0', strokeWidth: 2, strokeDasharray: '6 5' },
        data: { childTaskId, relationType },
      }]
    })
  }, [canvasParentPickActive, eligibleParentCandidateIds, hoveredParentCandidateId, parentBindingTaskIds, relationType, taskLookup, visibleTaskIds])
  const renderedEdges = useMemo(() => [...edges, ...parentPreviewEdges], [edges, parentPreviewEdges])

  const selectedTask = selectedTaskId ? taskLookup.get(selectedTaskId) : undefined
  const selectedTaskParent = selectedTask?.parentTaskId ? taskLookup.get(selectedTask.parentTaskId) : undefined
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

  function handleNodeDragStop(_: unknown, node: TaskFlowNode, draggedNodes: TaskFlowNode[]) {
    const movedNodes = draggedNodes.length > 0 ? draggedNodes : [node]
    const movedPositions = Object.fromEntries(movedNodes.map((movedNode) => [movedNode.id, movedNode.position]))
    if (filteredView) {
      setFilteredPositionOverrides((current) => ({ ...current, ...movedPositions }))
      return
    }
    // React Flow 会一起移动圈选节点；保存时必须提交整组坐标，否则刷新后只有最后一个节点保留新位置。
    commitPositions({ ...localPositions, ...movedPositions })
  }

  function selectSingleTask(taskId: string) {
    replaceSelectedTaskIds([taskId])
    setNodes((current) => current.map((node) => {
      const selected = node.id === taskId
      return node.selected === selected ? node : { ...node, selected }
    }))
    setSelectedTaskId(taskId)
  }

  function replaceSelectedTaskIds(taskIds: Iterable<string>) {
    const next = new Set(taskIds)
    if (setsEqual(selectedTaskIdsRef.current, next)) return
    selectedTaskIdsRef.current = next
    setSelectedTaskIds(next)
  }

  function openQuickParentPicker(taskIds: Iterable<string>) {
    const existingIds = [...new Set(taskIds)].filter((taskId) => taskLookup.has(taskId))
    if (existingIds.length === 0) return
    // 进入点选后点击父卡会改变 React Flow 的节点选择事件，因此必须先冻结待改绑任务集合。
    // 后续所有候选过滤、批量提交和撤销都使用这份快照，不能依赖实时 selection。
    setParentBindingTaskIds(existingIds)
    setQuickParentSearch('')
    setQuickParentPickerOpen(true)
    setCanvasParentPickActive(false)
    setHoveredParentCandidateId('')
  }

  function closeQuickParentPicker() {
    setQuickParentPickerOpen(false)
    setHoveredParentCandidateId('')
  }

  function startCanvasParentPick() {
    if (parentBindingTaskIds.length === 0) return
    setQuickParentPickerOpen(false)
    setCanvasParentPickActive(true)
    setHoveredParentCandidateId('')
  }

  function cancelCanvasParentPick() {
    setCanvasParentPickActive(false)
    setHoveredParentCandidateId('')
  }

  function captureParentBindingSnapshots(taskIds: string[]) {
    return taskIds.flatMap((taskId): ParentBindingSnapshot[] => {
      const task = taskLookup.get(taskId)
      if (!task) return []
      return [{
        childTaskId: task.id,
        parentTaskId: task.parentTaskId || '',
        relationType: task.parentLink?.type === 'discovered_from' ? 'discovered_from' : 'subtask_of',
      }]
    })
  }

  async function bindTasksToParent(parentTaskId: string) {
    if (parentBindingBusyRef.current || !eligibleParentCandidateIds.has(parentTaskId)) return
    const parentTask = taskLookup.get(parentTaskId)
    const changedTaskIds = parentBindingTaskIds.filter((taskId) => {
      const task = taskLookup.get(taskId)
      const currentRelationType = task?.parentLink?.type === 'discovered_from' ? 'discovered_from' : 'subtask_of'
      return task && (task.parentTaskId !== parentTaskId || currentRelationType !== relationType)
    })
    if (!parentTask || changedTaskIds.length === 0) {
      setQuickParentPickerOpen(false)
      setCanvasParentPickActive(false)
      setHoveredParentCandidateId('')
      setParentBindingNotice({ message: '所选任务已经挂在这个父任务下' })
      return
    }

    const previousBindings = captureParentBindingSnapshots(changedTaskIds)
    // React state 不能同步阻止同一帧里的连续点击，用 ref 锁住持久化入口，避免重复绑定和重复撤销提示。
    parentBindingBusyRef.current = true
    setParentBindingBusy(true)
    try {
      if (changedTaskIds.length === 1) await onLinkTasks(parentTaskId, changedTaskIds[0], relationType)
      else await onLinkTasksBatch(parentTaskId, changedTaskIds, relationType)
      setParentBindingNotice({
        message: changedTaskIds.length === 1
          ? `已挂到「${parentTask.title}」`
          : `已将 ${changedTaskIds.length} 个任务挂到「${parentTask.title}」`,
        previousBindings,
      })
      setQuickParentPickerOpen(false)
      setCanvasParentPickActive(false)
      setHoveredParentCandidateId('')
    } finally {
      parentBindingBusyRef.current = false
      setParentBindingBusy(false)
    }
  }

  async function unlinkParentBindings() {
    if (parentBindingBusyRef.current) return
    const taskIdsWithParent = parentBindingTaskIds.filter((taskId) => Boolean(taskLookup.get(taskId)?.parentTaskId))
    if (taskIdsWithParent.length === 0) return
    const previousBindings = captureParentBindingSnapshots(taskIdsWithParent)
    parentBindingBusyRef.current = true
    setParentBindingBusy(true)
    try {
      // App 层每次保存都基于最新 dataRef；串行解除可避免并发持久化互相覆盖。
      for (const taskId of taskIdsWithParent) await onUnlinkTask(taskId)
      setParentBindingNotice({
        message: taskIdsWithParent.length === 1 ? '已移除父任务' : `已移除 ${taskIdsWithParent.length} 个任务的父任务`,
        previousBindings,
      })
      setQuickParentPickerOpen(false)
    } finally {
      parentBindingBusyRef.current = false
      setParentBindingBusy(false)
    }
  }

  async function undoParentBinding() {
    const previousBindings = parentBindingNotice?.previousBindings
    if (parentBindingBusyRef.current || !previousBindings?.length) return
    parentBindingBusyRef.current = true
    setParentBindingBusy(true)
    try {
      // 撤销可能需要把每个子任务放回不同父级，现有批量接口无法表达这种映射，因此按快照串行恢复。
      for (const binding of previousBindings) {
        if (binding.parentTaskId) await onLinkTasks(binding.parentTaskId, binding.childTaskId, binding.relationType)
        else await onUnlinkTask(binding.childTaskId)
      }
      setParentBindingNotice({ message: '已撤销父任务变更' })
    } finally {
      parentBindingBusyRef.current = false
      setParentBindingBusy(false)
    }
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

  async function connectTasks(connection: Connection) {
    if (!connection?.source || !connection.target) return
    // 人工画线只表达明确的父子层级；派生关系由 Agent 在执行过程中写入。
    await onLinkTasks(connection.source, connection.target, 'subtask_of')
    selectSingleTask(connection.target)
  }

  function getFlowPosition(event: MouseEvent | TouchEvent | ReactMouseEvent<Element>) {
    const touch = 'changedTouches' in event ? event.changedTouches[0] : undefined
    const clientX = touch?.clientX ?? ('clientX' in event ? event.clientX : 0)
    const clientY = touch?.clientY ?? ('clientY' in event ? event.clientY : 0)
    const instance = reactFlowRef.current
    if (!instance || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return null

    const pointer = instance.screenToFlowPosition({ x: clientX, y: clientY })
    // React Flow 的节点坐标是左上角；减去半个节点尺寸后，新卡片会以用户落点为中心出现。
    return { x: pointer.x - nodeWidth / 2, y: pointer.y - nodeHeight / 2 }
  }

  const handleConnectEnd: OnConnectEnd = (event, connectionState) => {
    // 成功落到另一个连接点时由 onConnect 处理。只有落在空白画布上，才进入新建任务流程。
    if (connectionState.toNode || !connectionState.fromNode || !connectionState.fromHandle) return
    const position = getFlowPosition(event)
    if (!position) return

    onCreateTask({
      anchorTaskId: connectionState.fromNode.id,
      direction: connectionState.fromHandle.type === 'target' ? 'parent' : 'child',
      position,
      relationType: 'subtask_of',
    })
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
        <button className="topology-toolbar-icon" type="button" title="撤销布局" aria-label="撤销布局" disabled={undoStackRef.current.length === 0} onClick={undoLayout}>
          <Undo2 aria-hidden="true" size={16} strokeWidth={1.8} />
        </button>
        <button className="topology-toolbar-icon" type="button" title="重做布局" aria-label="重做布局" disabled={redoStackRef.current.length === 0} onClick={redoLayout}>
          <Redo2 aria-hidden="true" size={16} strokeWidth={1.8} />
        </button>
        <span className="toolbar-divider" aria-hidden="true" />
        <button
          className={`relationship-inbox-trigger ${inboxOpen ? 'active' : ''}`}
          type="button"
          onClick={() => setInboxOpen((current) => !current)}
        >
          待归类 AI <span>{unresolvedAgentTasks.length}</span>
        </button>
        <button className="topology-layout-action" type="button" onClick={autoLayout} title="自动整理任务位置">
          <span aria-hidden="true">✣</span><span className="toolbar-action-label">自动整理</span>
        </button>
        <button
          className="topology-layout-action"
          type="button"
          disabled={collapsibleTaskIds.size === 0}
          title={allParentsCollapsed ? '展开所有父节点' : '收起所有父节点'}
          onClick={() => setCollapsedTaskIds(allParentsCollapsed ? new Set() : new Set(collapsibleTaskIds))}
        >
          <span aria-hidden="true">{allParentsCollapsed ? '▾' : '▸'}</span>
          <span className="toolbar-action-label">{allParentsCollapsed ? '全部展开' : '全部收起'}</span>
        </button>
        {selectedEdgeId && <button className="danger-action" type="button" onClick={() => void unlinkSelectedEdge()}>解除关系</button>}
        <span className="global-topology-visible-count">当前 {visibleTasks.length}</span>
        {selectedTaskIds.size > 1 && <span className="global-topology-selection-count">已选 {selectedTaskIds.size}</span>}
        {selectedTaskIds.size > 1 && (
          <button className="topology-bind-parent-action" type="button" onClick={() => openQuickParentPicker(selectedTaskIds)}>
            <Link2 aria-hidden="true" size={14} strokeWidth={2} />
            挂到父任务
          </button>
        )}
        <div className="global-topology-filters">
          <select className="project-filter" value={projectFilter} aria-label="按项目筛选" onChange={(event) => setProjectFilter(event.target.value)}>
            <option value="all">全部项目</option>
            {projectOptions.map((project) => (
              <option key={project} value={project}>{project === ungroupedProjectFilter ? '未分组' : project}</option>
            ))}
          </select>
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
      </div>

      {quickParentPickerOpen && (
        <div className={`topology-parent-picker-layer ${parentBindingTaskIds.length === 1 && selectedTask ? 'single-selection-picker' : 'multi-selection-picker'}`}>
          <TopologyParentPicker
            tasks={tasks}
            childTaskIds={parentBindingTaskIds}
            searchValue={quickParentSearch}
            relationType={relationType}
            onSearchChange={setQuickParentSearch}
            onRelationTypeChange={setRelationType}
            onSelectParent={(parentTaskId) => void bindTasksToParent(parentTaskId)}
            onSelectFromCanvas={startCanvasParentPick}
            onUnlink={() => void unlinkParentBindings()}
            onClose={closeQuickParentPicker}
          />
        </div>
      )}

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
        <div className="global-topology-canvas" title="双击空白处新建任务；按住 Shift、Command 或 Control 拖动可圈选任务">
          <ReactFlow<TaskFlowNode, TaskFlowEdge>
            nodes={nodes}
            edges={renderedEdges}
            nodeTypes={nodeTypes}
            onInit={(instance) => {
              // Focus navigation reacts to state, while blank-drop creation needs the latest
              // instance synchronously inside pointer callbacks. Keep both views in sync.
              setFlowInstance(instance)
              reactFlowRef.current = instance
            }}
            onNodesChange={onNodesChange}
            onNodeClick={(event, node) => {
              if (canvasParentPickActive) {
                if (eligibleParentCandidateIds.has(node.id)) void bindTasksToParent(node.id)
                return
              }
              if (!event.shiftKey && !event.metaKey && !event.ctrlKey) selectSingleTask(node.id)
              setSelectedEdgeId('')
            }}
            onNodeMouseEnter={(_, node) => {
              if (canvasParentPickActive && eligibleParentCandidateIds.has(node.id)) setHoveredParentCandidateId(node.id)
            }}
            onNodeMouseLeave={(_, node) => {
              setHoveredParentCandidateId((current) => current === node.id ? '' : current)
            }}
            onEdgeClick={(_, edge) => {
              setSelectedEdgeId(edge.id)
              selectSingleTask(edge.target)
            }}
            onPaneClick={(event) => {
              if (canvasParentPickActive) {
                cancelCanvasParentPick()
                return
              }
              if (event.detail >= 2) {
                const position = getFlowPosition(event)
                if (position) onCreateTask({ direction: 'independent', position })
                return
              }
              setSelectedTaskId('')
              replaceSelectedTaskIds([])
              setSelectedEdgeId('')
            }}
            onSelectionChange={({ nodes: selectedNodes, edges: selectedEdges }) => {
              if (canvasParentPickActive) return
              // 圈选过程中 React Flow 会在每次指针移动时上报临时选择集。这里只同步业务所需的
              // id 集合，不再据此重建全部节点或展开详情，避免大拓扑持续重排导致窗口假死。
              if (selectedNodes.length > 0) {
                replaceSelectedTaskIds(selectedNodes.map((node) => node.id))
                setSelectedEdgeId('')
              } else if (selectedEdges.length === 0) {
                replaceSelectedTaskIds([])
              }
            }}
            onNodeDragStop={handleNodeDragStop}
            onConnect={(connection) => void connectTasks(connection)}
            onConnectEnd={handleConnectEnd}
            defaultViewport={initialMemory?.viewport}
            onMoveEnd={(_, viewport) => {
              viewportRef.current = viewport
              // 平移或缩放本身不会触发 React render。同步写入快照引用，确保用户操作后
              // 立刻切换视图时也能保存最后一帧，而不是上一次 render 时的旧视口。
              if (memoryRef.current) memoryRef.current.viewport = viewport
            }}
            minZoom={minTopologyZoom}
            maxZoom={maxTopologyZoom}
            deleteKeyCode={null}
            proOptions={{ hideAttribution: true }}
            nodesConnectable={!canvasParentPickActive}
            nodesDraggable={!canvasParentPickActive}
            selectionKeyCode={['Shift', 'Meta', 'Control']}
            multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
            selectionMode={SelectionMode.Partial}
            selectionOnDrag={false}
            panOnDrag
            panOnScroll
            panOnScrollSpeed={0.8}
            zoomOnScroll={false}
            zoomOnPinch
            zoomOnDoubleClick={false}
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
          {canvasParentPickActive && (
            <div className="topology-parent-pick-banner" role="status">
              <Link2 aria-hidden="true" size={15} strokeWidth={2} />
              <strong>{parentBindingTaskIds.length > 1 ? `为 ${parentBindingTaskIds.length} 个任务选择父任务` : '选择父任务'}</strong>
              <div className="topology-parent-relation-type" role="group" aria-label="关系类型">
                <button className={relationType === 'subtask_of' ? 'active' : ''} type="button" onClick={() => setRelationType('subtask_of')}>子任务</button>
                <button className={relationType === 'discovered_from' ? 'active' : ''} type="button" onClick={() => setRelationType('discovered_from')}>派生</button>
              </div>
              <button className="icon-button" type="button" title="取消" aria-label="取消选择父任务" onClick={cancelCanvasParentPick}>
                <X aria-hidden="true" size={15} />
              </button>
            </div>
          )}
          <div className="global-topology-legend">
            <span><i className="human" />人工任务</span>
            <span><i className="agent" />AI 任务</span>
            <span><i className="subtask" />子任务</span>
            <span><i className="derived" />派生</span>
            <span><i className="follow-up" />不阻塞父任务</span>
          </div>
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
                  <div className="inspector-parent-row">
                    <span>父任务</span>
                    <button
                      type="button"
                      title={selectedTaskParent?.title || '挂到父任务'}
                      aria-expanded={quickParentPickerOpen && parentBindingTaskIds.length === 1}
                      onClick={() => openQuickParentPicker([selectedTask.id])}
                    >
                      <Link2 aria-hidden="true" size={14} strokeWidth={2} />
                      <strong>{selectedTaskParent?.title || '挂到父任务'}</strong>
                      <small>{selectedTaskParent ? '更换' : '选择'}</small>
                    </button>
                  </div>
                  {selectedTaskPath.length > 1 && <p className="inspector-task-path">{selectedTaskPath.map((task) => task.title).join(' › ')}</p>}
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
      {parentBindingNotice && (
        <div className="topology-parent-binding-notice" role="status">
          <span>{parentBindingNotice.message}</span>
          {parentBindingNotice.previousBindings && (
            <button type="button" disabled={parentBindingBusy} onClick={() => void undoParentBinding()}>
              <Undo2 aria-hidden="true" size={14} />
              撤销
            </button>
          )}
          <button className="icon-button" type="button" title="关闭" aria-label="关闭提示" onClick={() => setParentBindingNotice(null)}>
            <X aria-hidden="true" size={14} />
          </button>
        </div>
      )}
    </section>
  )
}
