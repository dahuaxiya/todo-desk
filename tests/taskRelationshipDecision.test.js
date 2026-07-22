import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertAgentRelationshipDecision,
  deriveTaskRelationshipState,
  normalizeTaskRelationshipDecision,
} from '../electron/task-relationship.js'

test('relationship state is derived from parent and explicit root decision', () => {
  assert.equal(deriveTaskRelationshipState('parent-1', 'agent', 'unresolved'), 'linked')
  assert.equal(deriveTaskRelationshipState('', 'agent', 'independent_root'), 'independent_root')
  assert.equal(deriveTaskRelationshipState('', 'agent', undefined), 'unresolved')
  assert.equal(deriveTaskRelationshipState('', 'human', undefined), undefined)
})

test('linked decision records the selected parent among reviewed candidates', () => {
  const decision = normalizeTaskRelationshipDecision({
    state: 'linked',
    reason: 'The parent directly requested this branch',
    candidateTaskIds: ['other'],
    decidedBy: 'agent',
  }, {
    parentTaskId: 'parent-1',
    relationshipState: 'linked',
    originKind: 'agent',
    agent: 'codex',
    agentSessionId: 'session-1',
  }, '2026-07-22T00:00:00.000Z')

  assert.deepEqual(decision, {
    state: 'linked',
    reason: 'The parent directly requested this branch',
    candidateTaskIds: ['parent-1', 'other'],
    decidedAt: '2026-07-22T00:00:00.000Z',
    decidedBy: 'agent',
    agent: 'codex',
    agentSessionId: 'session-1',
  })
})

test('stale and incomplete agent decisions are rejected', () => {
  const stale = normalizeTaskRelationshipDecision({
    state: 'independent_root',
    reason: 'Old decision',
  }, {
    parentTaskId: 'parent-1',
    relationshipState: 'linked',
    originKind: 'agent',
  })
  assert.equal(stale, undefined)

  assert.throws(() => assertAgentRelationshipDecision({
    origin: { kind: 'agent' },
    relationshipState: 'unresolved',
  }), /requires an explicit relationship decision/)
  assert.throws(() => assertAgentRelationshipDecision({
    origin: { kind: 'agent' },
    relationshipState: 'unresolved',
    relationshipDecision: { state: 'unresolved', reason: '' },
  }), /reason is required/)
})

test('all three explicit agent decisions pass validation', () => {
  assert.doesNotThrow(() => assertAgentRelationshipDecision({
    origin: { kind: 'agent' },
    parentTaskId: 'parent-1',
    relationshipState: 'linked',
    relationshipDecision: { state: 'linked', reason: 'Explicit parent' },
  }))
  for (const state of ['independent_root', 'unresolved']) {
    assert.doesNotThrow(() => assertAgentRelationshipDecision({
      origin: { kind: 'agent' },
      relationshipState: state,
      relationshipDecision: { state, reason: 'Explicit root decision' },
    }))
  }
})
