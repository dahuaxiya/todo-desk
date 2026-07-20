import { useMemo, useState } from 'react'
import dagre from '@dagrejs/dagre'
import { ArrowUpRight, X } from 'lucide-react'
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './TaskTopologyCanvas.css'
import type { Task, TaskColumnStatus, TaskStatus } from './types'

interface TaskTopologyCanvasProps {
  tasks: Task[]
  rootTaskId: string
  currentTaskId: string
  onOpenTask: (taskId: string) => void
}

interface TaskTopologyNodeData extends Record<string, unknown> {
  task: Task
  childCount: number
  current: boolean
}

type TaskTopologyFlowNode = Node<TaskTopologyNodeData, 'task-topology'>
type TaskTopologyFlowEdge = Edge<{ relationType: 'subtask_of' | 'discovered_from' }>

const topologyNodeWidth = 238
const topologyNodeHeight = 112

const statusLabels: Record<TaskStatus, string> = {
  doing: '正在做',
  todo: 'Todo',
  pending_acceptance: '待确认',
  done: '已完成',
}

const priorityLabels = {
  high: '高优先级',
  medium: '中优先级',
  low: '低优先级',
}

function getColumnStatus(status: TaskStatus): TaskColumnStatus {
  return status === 'pending_acceptance' ? 'doing' : status
}

function isAgentTask(task: Task) {
  return task.origin?.kind === 'agent' || Boolean(task.agent || task.agentSessionId)
}

function hasActiveCompletionGate(task: Task) {
  return task.status === 'pending_acceptance' && !task.completionAcceptance?.resolvedAt
}

function hasActiveSessionReview(task: Task) {
  return Boolean(task.sessionReview && !task.sessionReview.resolvedAt)
}

function hasActiveParentReview(task: Task) {
  return Boolean(task.parentCompletionReview && !task.parentCompletionReview.resolvedAt)
}

function collectTopologyTasks(tasks: Task[], rootTaskId: string) {
  const childrenByParentId = new Map<string, Task[]>()
  for (const task of tasks) {
    if (!task.parentTaskId) continue
    childrenByParentId.set(task.parentTaskId, [...(childrenByParentId.get(task.parentTaskId) ?? []), task])
  }

  const taskLookup = new Map(tasks.map((task) => [task.id, task]))
  const result: Task[] = []
  const visited = new Set<string>()
  const queue = [rootTaskId]

  // 历史数据可能出现循环关系。visited 既避免无限遍历，也保证同一任务只生成一个画布节点。
  while (queue.length > 0) {
    const taskId = queue.shift()
    if (!taskId || visited.has(taskId)) continue
    visited.add(taskId)
    const task = taskLookup.get(taskId)
    if (!task) continue
    result.push(task)
    const children = [...(childrenByParentId.get(taskId) ?? [])]
      .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
    queue.push(...children.map((child) => child.id))
  }

  return result
}

function createFlowElements(topologyTasks: Task[], currentTaskId: string) {
  const topologyTaskIds = new Set(topologyTasks.map((task) => task.id))
  const childCountByTaskId = new Map<string, number>()
  const graph = new dagre.graphlib.Graph()
  graph.setDefaultEdgeLabel(() => ({}))
  graph.setGraph({ rankdir: 'LR', ranksep: 58, nodesep: 24, marginx: 24, marginy: 24 })

  for (const task of topologyTasks) graph.setNode(task.id, { width: topologyNodeWidth, height: topologyNodeHeight })
  for (const task of topologyTasks) {
    if (!task.parentTaskId || !topologyTaskIds.has(task.parentTaskId)) continue
    graph.setEdge(task.parentTaskId, task.id)
    childCountByTaskId.set(task.parentTaskId, (childCountByTaskId.get(task.parentTaskId) ?? 0) + 1)
  }
  dagre.layout(graph)

  const nodes: TaskTopologyFlowNode[] = topologyTasks.map((task) => {
    const point = graph.node(task.id)
    return {
      id: task.id,
      type: 'task-topology',
      position: {
        x: point.x - topologyNodeWidth / 2,
        y: point.y - topologyNodeHeight / 2,
      },
      data: {
        task,
        childCount: childCountByTaskId.get(task.id) ?? 0,
        current: task.id === currentTaskId,
      },
      draggable: false,
      selectable: true,
    }
  })

  const edges: TaskTopologyFlowEdge[] = topologyTasks.flatMap((task) => {
    if (!task.parentTaskId || !topologyTaskIds.has(task.parentTaskId)) return []
    const relationType = task.parentLink?.type === 'discovered_from' ? 'discovered_from' : 'subtask_of'
    const followUpOnly = task.parentLink?.affectsParentCompletion === false
    const color = relationType === 'discovered_from' ? '#7860d9' : '#78838f'
    return [{
      id: `${task.parentTaskId}->${task.id}`,
      source: task.parentTaskId,
      target: task.id,
      type: 'smoothstep',
      animated: relationType === 'discovered_from',
      markerEnd: { type: MarkerType.ArrowClosed, color },
      style: {
        stroke: color,
        strokeWidth: 1.7,
        strokeDasharray: followUpOnly ? '7 5' : undefined,
      },
      data: { relationType },
    }]
  })

  return { nodes, edges }
}

function TaskTopologyFlowNode({ data, selected }: NodeProps<TaskTopologyFlowNode>) {
  const { task, childCount, current } = data
  const agentTask = isAgentTask(task)
  const columnStatus = getColumnStatus(task.status)

  return (
    <article className={`task-topology-flow-node ${agentTask ? 'agent-task' : 'human-task'} status-${columnStatus} ${current ? 'current' : ''} ${selected ? 'selected' : ''}`}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <header>
        <span className={`task-topology-flow-status status-${columnStatus}`} aria-hidden="true" />
        <strong title={task.title}>{task.title}</strong>
        <span className="task-topology-flow-notices" aria-label="需要用户处理的提醒">
          {hasActiveCompletionGate(task) && <i className="completion" title="等待确认完成" />}
          {hasActiveSessionReview(task) && <i className="session" title="本轮会话已结束，任务未完成" />}
          {hasActiveParentReview(task) && <i className="parent" title="等待复核父任务" />}
        </span>
      </header>
      <div className="task-topology-flow-meta">
        {task.parentTaskId && (
          <span className={`relation ${task.parentLink?.type === 'discovered_from' ? 'derived' : 'subtask'}`}>
            {task.parentLink?.type === 'discovered_from' ? '派生' : '子任务'}
          </span>
        )}
        <span>{statusLabels[task.status]}</span>
        <span>{priorityLabels[task.priority]}</span>
        {agentTask && <span className="origin">AI</span>}
      </div>
      <footer>
        <span>{task.project || '未分组'}</span>
        <span>{childCount > 0 ? `${childCount} 个子任务` : (task.tags?.[0] ? `#${task.tags[0]}` : '无标签')}</span>
      </footer>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </article>
  )
}

const nodeTypes = { 'task-topology': TaskTopologyFlowNode }

export function TaskTopologyCanvas({ tasks, rootTaskId, currentTaskId, onOpenTask }: TaskTopologyCanvasProps) {
  const [selectedTaskId, setSelectedTaskId] = useState('')
  const topologyTasks = useMemo(() => collectTopologyTasks(tasks, rootTaskId), [rootTaskId, tasks])
  const { nodes: baseNodes, edges } = useMemo(
    () => createFlowElements(topologyTasks, currentTaskId),
    [currentTaskId, topologyTasks],
  )
  const nodes = useMemo(
    () => baseNodes.map((node) => ({ ...node, selected: node.id === selectedTaskId })),
    [baseNodes, selectedTaskId],
  )
  const selectedTask = topologyTasks.find((task) => task.id === selectedTaskId)
  const selectedChildren = selectedTask ? topologyTasks.filter((task) => task.parentTaskId === selectedTask.id) : []

  return (
    <div className="task-topology-flow-shell">
      <ReactFlow<TaskTopologyFlowNode, TaskTopologyFlowEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.16, minZoom: 0.34, maxZoom: 1 }}
        minZoom={0.22}
        maxZoom={1.6}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        deleteKeyCode={null}
        zoomOnScroll={false}
        zoomOnPinch
        panOnDrag
        panOnScroll
        panOnScrollSpeed={0.8}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, node) => setSelectedTaskId(node.id)}
        onPaneClick={() => setSelectedTaskId('')}
      >
        <Background variant={BackgroundVariant.Lines} gap={24} size={1} color="#ece8df" />
        <Controls position="bottom-right" showInteractive={false} />
        <MiniMap
          position="bottom-right"
          pannable
          zoomable
          nodeColor={(node) => isAgentTask((node.data as TaskTopologyNodeData).task) ? '#d9cdfc' : '#f4dc93'}
          maskColor="rgba(248, 247, 242, 0.72)"
        />
      </ReactFlow>

      {selectedTask && (
        <aside className="task-topology-flow-inspector" aria-label={`${selectedTask.title} 的任务详情`}>
          <header>
            <div>
              <span className={`task-topology-flow-status status-${getColumnStatus(selectedTask.status)}`} />
              <strong>{selectedTask.title}</strong>
            </div>
            <button type="button" title="关闭详情" aria-label="关闭详情" onClick={() => setSelectedTaskId('')}>
              <X aria-hidden="true" size={15} />
            </button>
          </header>
          <div className="task-topology-flow-inspector-scroll">
            <div className="task-topology-flow-inspector-badges">
              <span>{statusLabels[selectedTask.status]}</span>
              <span>{priorityLabels[selectedTask.priority]}</span>
              <span>{isAgentTask(selectedTask) ? 'AI 任务' : '人工任务'}</span>
              {selectedTask.project && <span>{selectedTask.project}</span>}
            </div>
            <section>
              <h3>任务内容</h3>
              <p>{selectedTask.detail || '暂无任务详情'}</p>
            </section>
            {selectedTask.parentLink?.reason && (
              <section>
                <h3>派生原因</h3>
                <p>{selectedTask.parentLink.reason}</p>
              </section>
            )}
            <section>
              <h3>子任务进度</h3>
              <p>{selectedChildren.filter((task) => task.status === 'done').length} / {selectedChildren.length} 已完成</p>
            </section>
          </div>
          <footer>
            <button type="button" onClick={() => onOpenTask(selectedTask.id)}>
              打开任务 <ArrowUpRight aria-hidden="true" size={14} />
            </button>
          </footer>
        </aside>
      )}
    </div>
  )
}
