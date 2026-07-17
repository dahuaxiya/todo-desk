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
  type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './GlobalTopologyView.css'
import type { Task, TaskColumnStatus, TaskParentLink, TaskStatus, TopologyPosition } from './types'

type TopologyRelationType = TaskParentLink['type']
type TopologyStatusFilter = 'all' | TaskColumnStatus
type TopologyMode = 'select' | 'connect'

interface GlobalTopologyViewProps {
  tasks: Task[]
  includedTaskIds: string[]
  positions: Record<string, TopologyPosition>
  onSavePositions: (positions: Record<string, TopologyPosition>) => Promise<void> | void
  onLinkTasks: (parentTaskId: string, childTaskId: string, relationType: TopologyRelationType) => Promise<void> | void
  onUnlinkTask: (taskId: string) => Promise<void> | void
  onChangeStatus: (taskId: string, status: TaskColumnStatus) => Promise<void> | void
  onToggleDone: (taskId: string) => Promise<void> | void
  onOpenTask: (taskId: string) => void
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
    <article className={`global-task-node ${agentTask ? 'agent-task' : 'human-task'} status-${columnStatus} ${selected ? 'selected' : ''}`}>
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
        <strong title={task.title}>{task.title}</strong>
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
  positions,
  onSavePositions,
  onLinkTasks,
  onUnlinkTask,
  onChangeStatus,
  onToggleDone,
  onOpenTask,
  onAddTask,
}: GlobalTopologyViewProps) {
  const [mode, setMode] = useState<TopologyMode>('select')
  const [statusFilter, setStatusFilter] = useState<TopologyStatusFilter>('all')
  const [projectFilter, setProjectFilter] = useState('all')
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
  const flowInstanceRef = useRef<ReactFlowInstance<TaskFlowNode, TaskFlowEdge> | null>(null)
  const skipNextSelectionFitRef = useRef(false)

  const taskLookup = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks])
  const externallyVisibleTaskIds = useMemo(() => new Set(includedTaskIds), [includedTaskIds])
  const projects = useMemo(
    () => [...new Set(tasks.map((task) => task.project).filter(Boolean))].sort((left, right) => left.localeCompare(right, 'zh-CN')),
    [tasks],
  )
  const automaticPositions = useMemo(() => createAutomaticLayout(tasks), [tasks])
  const filteredTasks = useMemo(
    () => tasks.filter((task) => {
      if (!externallyVisibleTaskIds.has(task.id)) return false
      if (statusFilter !== 'all' && getColumnStatus(task.status) !== statusFilter) return false
      return projectFilter === 'all' || task.project === projectFilter
    }),
    [externallyVisibleTaskIds, projectFilter, statusFilter, tasks],
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
  const filteredView = statusFilter !== 'all' || projectFilter !== 'all' || filteredTasks.length !== tasks.length
  const allParentsCollapsed = collapsibleTaskIds.size > 0 && [...collapsibleTaskIds].every((taskId) => collapsedTaskIds.has(taskId))

  useEffect(() => {
    setLocalPositions((current) => ({ ...automaticPositions, ...current, ...positions }))
  }, [automaticPositions, positions])

  useEffect(() => {
    if (!skipNextSelectionFitRef.current) return
    // 收缩可能先改变可见节点数量，再因选中节点被隐藏而关闭详情栏，会产生两次渲染。
    // 延迟到下一帧再恢复详情栏的自动适配，确保这两次渲染都沿用原视口。
    const frame = requestAnimationFrame(() => {
      skipNextSelectionFitRef.current = false
    })
    return () => cancelAnimationFrame(frame)
  }, [collapsedTaskIds])

  useEffect(() => {
    setFilteredPositionOverrides({})
    const frame = requestAnimationFrame(() => {
      flowInstanceRef.current?.fitView({
        padding: filteredTasks.length > 80 ? 0.035 : 0.075,
        maxZoom: filteredTasks.length > 40 ? 0.82 : 1.05,
        duration: 0,
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [filteredAutomaticPositions, filteredTasks.length, projectFilter, statusFilter])

  useEffect(() => {
    if (skipNextSelectionFitRef.current) return
    // 详情栏出现或收起会改变画布宽度，等 CSS 网格完成一次布局后重新适配，
    // 否则选中任务时右侧节点会被详情栏直接裁掉。
    const timer = window.setTimeout(() => {
      flowInstanceRef.current?.fitView({
        padding: visibleTasks.length > 80 ? 0.035 : 0.075,
        maxZoom: visibleTasks.length > 40 ? 0.82 : 1.05,
        duration: 0,
      })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [selectedTaskId, visibleTasks.length])

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
          skipNextSelectionFitRef.current = true
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
      requestAnimationFrame(() => flowInstanceRef.current?.fitView({ padding: 0.075, maxZoom: 1.05, duration: 0 }))
      return
    }
    commitPositions(createAutomaticLayout(tasks))
    requestAnimationFrame(() => flowInstanceRef.current?.fitView({ padding: 0.05, maxZoom: 0.9, duration: 0 }))
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

  void historyVersion

  return (
    <section className="global-topology-view">
      <div className="global-topology-toolbar">
        <div className="global-topology-mode" role="group" aria-label="拓扑编辑模式">
          <button className={mode === 'select' ? 'active' : ''} type="button" onClick={() => setMode('select')}>选择</button>
          <button className={mode === 'connect' ? 'active' : ''} type="button" onClick={() => setMode('connect')}>连线</button>
        </div>
        <button type="button" onClick={onAddTask}>＋ 新增任务</button>
        <span className="toolbar-divider" />
        <button type="button" title="撤销布局" disabled={undoStackRef.current.length === 0} onClick={undoLayout}>↶</button>
        <button type="button" title="重做布局" disabled={redoStackRef.current.length === 0} onClick={redoLayout}>↷</button>
        <button type="button" onClick={autoLayout}>自动整理</button>
        <button
          type="button"
          disabled={collapsibleTaskIds.size === 0}
          title={allParentsCollapsed ? '展开所有父节点' : '收起所有父节点'}
          onClick={() => {
            skipNextSelectionFitRef.current = true
            setCollapsedTaskIds(allParentsCollapsed ? new Set() : new Set(collapsibleTaskIds))
          }}
        >
          {allParentsCollapsed ? '▾ 全部展开' : '▸ 全部收起'}
        </button>
        <span className="global-topology-visible-count">当前 {visibleTasks.length}</span>
        {selectedEdgeId && <button className="danger-action" type="button" onClick={() => void unlinkSelectedEdge()}>解除关系</button>}
        <div className="global-topology-filters">
          <select value={statusFilter} aria-label="按状态筛选" onChange={(event) => setStatusFilter(event.target.value as TopologyStatusFilter)}>
            <option value="all">全部状态</option>
            <option value="doing">正在做</option>
            <option value="todo">Todo</option>
            <option value="done">已完成</option>
          </select>
          <select value={projectFilter} aria-label="按项目筛选" onChange={(event) => setProjectFilter(event.target.value)}>
            <option value="all">全部项目</option>
            {projects.map((project) => <option key={project} value={project}>{project}</option>)}
          </select>
        </div>
      </div>

      <div className={`global-topology-body ${selectedTask ? 'has-selection' : ''}`}>
        <div className={`global-topology-canvas mode-${mode}`}>
          <ReactFlow<TaskFlowNode, TaskFlowEdge>
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onInit={(instance) => {
              flowInstanceRef.current = instance
            }}
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
            fitView
            fitViewOptions={{ padding: 0.075, maxZoom: 1.05 }}
            minZoom={0.08}
            maxZoom={1.8}
            deleteKeyCode={null}
            proOptions={{ hideAttribution: true }}
            nodesConnectable={mode === 'connect'}
            nodesDraggable={mode === 'select'}
            selectionOnDrag={mode === 'select'}
            panOnDrag
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
                </div>
                <span className={`inspector-origin ${isAgentTask(selectedTask) ? 'agent' : 'human'}`}>{isAgentTask(selectedTask) ? 'AI 任务' : '人工任务'}</span>
              </header>
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
              <footer>
                {selectedTask.status === 'todo' && <button type="button" onClick={() => void onChangeStatus(selectedTask.id, 'doing')}>开始处理</button>}
                <button className="primary" type="button" onClick={() => onOpenTask(selectedTask.id)}>打开任务卡片</button>
              </footer>
            </>
          </aside>
        )}
      </div>
    </section>
  )
}
