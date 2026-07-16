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
  connectMode: boolean
  onChangeStatus: GlobalTopologyViewProps['onChangeStatus']
  onToggleDone: GlobalTopologyViewProps['onToggleDone']
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
  const graph = new dagre.graphlib.Graph()
  graph.setDefaultEdgeLabel(() => ({}))
  graph.setGraph({ rankdir: 'LR', ranksep: 92, nodesep: 46, marginx: 56, marginy: 48 })

  for (const task of tasks) graph.setNode(task.id, { width: nodeWidth, height: nodeHeight })
  for (const task of tasks) {
    if (task.parentTaskId && graph.hasNode(task.parentTaskId)) graph.setEdge(task.parentTaskId, task.id)
  }

  dagre.layout(graph)
  return Object.fromEntries(tasks.map((task) => {
    const point = graph.node(task.id)
    return [task.id, { x: point.x - nodeWidth / 2, y: point.y - nodeHeight / 2 }]
  }))
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

function TaskNode({ data, selected }: NodeProps<TaskFlowNode>) {
  const { task, childCount, connectMode, onChangeStatus, onToggleDone } = data
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
        <span>{childCount > 0 ? `${childCount} 个子任务` : task.tags[0] ? `#${task.tags[0]}` : '无标签'}</span>
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
  const [selectedTaskId, setSelectedTaskId] = useState('')
  const [selectedEdgeId, setSelectedEdgeId] = useState('')
  const [pendingConnection, setPendingConnection] = useState<Connection | null>(null)
  const [localPositions, setLocalPositions] = useState<Record<string, TopologyPosition>>(positions)
  const [nodes, setNodes] = useState<TaskFlowNode[]>([])
  const [historyVersion, setHistoryVersion] = useState(0)
  const undoStackRef = useRef<Record<string, TopologyPosition>[]>([])
  const redoStackRef = useRef<Record<string, TopologyPosition>[]>([])

  const taskLookup = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks])
  const externallyVisibleTaskIds = useMemo(() => new Set(includedTaskIds), [includedTaskIds])
  const projects = useMemo(
    () => [...new Set(tasks.map((task) => task.project).filter(Boolean))].sort((left, right) => left.localeCompare(right, 'zh-CN')),
    [tasks],
  )
  const childCountByParentId = useMemo(() => {
    const counts = new Map<string, number>()
    for (const task of tasks) {
      if (task.parentTaskId) counts.set(task.parentTaskId, (counts.get(task.parentTaskId) ?? 0) + 1)
    }
    return counts
  }, [tasks])
  const automaticPositions = useMemo(() => createAutomaticLayout(tasks), [tasks])
  const visibleTasks = useMemo(
    () => tasks.filter((task) => {
      if (!externallyVisibleTaskIds.has(task.id)) return false
      if (statusFilter !== 'all' && getColumnStatus(task.status) !== statusFilter) return false
      return projectFilter === 'all' || task.project === projectFilter
    }),
    [externallyVisibleTaskIds, projectFilter, statusFilter, tasks],
  )
  const visibleTaskIds = useMemo(() => new Set(visibleTasks.map((task) => task.id)), [visibleTasks])

  useEffect(() => {
    setLocalPositions((current) => ({ ...automaticPositions, ...current, ...positions }))
  }, [automaticPositions, positions])

  useEffect(() => {
    setNodes(visibleTasks.map((task) => ({
      id: task.id,
      type: 'task',
      position: localPositions[task.id] ?? automaticPositions[task.id] ?? { x: 0, y: 0 },
      data: {
        task,
        childCount: childCountByParentId.get(task.id) ?? 0,
        connectMode: mode === 'connect',
        onChangeStatus,
        onToggleDone,
      },
      selected: task.id === selectedTaskId,
      draggable: mode === 'select',
      connectable: mode === 'connect',
    })))
  }, [automaticPositions, childCountByParentId, localPositions, mode, onChangeStatus, onToggleDone, selectedTaskId, visibleTasks])

  useEffect(() => {
    if (selectedTaskId && !taskLookup.has(selectedTaskId)) setSelectedTaskId('')
  }, [selectedTaskId, taskLookup])

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

      <div className="global-topology-body">
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
            fitView
            fitViewOptions={{ padding: 0.16, maxZoom: 1 }}
            minZoom={0.2}
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

        <aside className="global-topology-inspector">
          {selectedTask ? (
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
          ) : (
            <div className="global-topology-inspector-empty">
              <strong>选择一个任务</strong>
              <p>查看完整内容、父子路径和 Agent 上下文。切换到“连线”后，可从父任务右侧拖到子任务左侧。</p>
            </div>
          )}
        </aside>
      </div>
    </section>
  )
}
