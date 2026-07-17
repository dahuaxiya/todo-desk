import assert from 'node:assert/strict'
import test from 'node:test'
import { collectRelationshipNetworkIds, normalizeTopologyProject } from '../src/topologyNetwork.ts'

test('历史任务缺少项目字段时按未分组处理', () => {
  assert.equal(normalizeTopologyProject(undefined, '__ungrouped__'), '__ungrouped__')
  assert.equal(normalizeTopologyProject(null, '__ungrouped__'), '__ungrouped__')
  assert.equal(normalizeTopologyProject('   ', '__ungrouped__'), '__ungrouped__')
  assert.equal(normalizeTopologyProject('  Todo Desk  ', '__ungrouped__'), 'Todo Desk')
})

test('命中关系网中的任意节点时补齐整张关系网', () => {
  const tasks = [
    { id: 'root' },
    { id: 'left', parentTaskId: 'root' },
    { id: 'left-child', parentTaskId: 'left' },
    { id: 'right', parentTaskId: 'root' },
    { id: 'unrelated' },
  ]

  assert.deepEqual(
    [...collectRelationshipNetworkIds(tasks, ['left-child'])].sort(),
    ['left', 'left-child', 'right', 'root'],
  )
})

test('多个筛选入口会分别补齐各自的关系网', () => {
  const tasks = [
    { id: 'a-root' },
    { id: 'a-child', parentTaskId: 'a-root' },
    { id: 'b-root' },
    { id: 'b-child', parentTaskId: 'b-root' },
    { id: 'isolated' },
  ]

  assert.deepEqual(
    [...collectRelationshipNetworkIds(tasks, ['a-child', 'b-root', 'isolated'])].sort(),
    ['a-child', 'a-root', 'b-child', 'b-root', 'isolated'],
  )
})

test('循环关系不会无限遍历，缺失任务 id 不会进入结果', () => {
  const tasks = [
    { id: 'a', parentTaskId: 'c' },
    { id: 'b', parentTaskId: 'a' },
    { id: 'c', parentTaskId: 'b' },
  ]

  assert.deepEqual([...collectRelationshipNetworkIds(tasks, ['a', 'missing'])].sort(), ['a', 'b', 'c'])
})
