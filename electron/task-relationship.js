const relationshipStates = new Set(['linked', 'unresolved', 'independent_root'])

function normalizeString(value) {
  return String(value || '').trim()
}

function normalizeCandidateTaskIds(value) {
  const items = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,\s，、]+/)
      : []
  return [...new Set(items.map((item) => normalizeString(item)).filter(Boolean))].slice(0, 50)
}

export function deriveTaskRelationshipState(parentTaskId, originKind, requestedState) {
  if (normalizeString(parentTaskId)) return 'linked'
  if (originKind !== 'agent') return undefined
  return requestedState === 'independent_root' ? 'independent_root' : 'unresolved'
}

export function normalizeTaskRelationshipDecision(value, context, now = new Date().toISOString()) {
  if (!value || typeof value !== 'object') return undefined

  const expectedState = deriveTaskRelationshipState(
    context.parentTaskId,
    context.originKind,
    context.relationshipState,
  )
  const requestedState = normalizeString(value.state)
  const state = relationshipStates.has(requestedState) ? requestedState : expectedState
  // A decision describes the task's current relationship, not its history. Dropping a stale
  // decision prevents a later re-parent operation from looking explicitly classified when it is not.
  if (!state || state !== expectedState) return undefined

  const parentTaskId = normalizeString(context.parentTaskId)
  const candidateTaskIds = normalizeCandidateTaskIds(value.candidateTaskIds)
  if (state === 'linked' && parentTaskId && !candidateTaskIds.includes(parentTaskId)) {
    candidateTaskIds.unshift(parentTaskId)
  }

  const requestedDecider = normalizeString(value.decidedBy)
  return {
    state,
    reason: normalizeString(value.reason).slice(0, 500),
    candidateTaskIds,
    decidedAt: normalizeString(value.decidedAt) || now,
    decidedBy: ['agent', 'human'].includes(requestedDecider)
      ? requestedDecider
      : context.originKind === 'agent' ? 'agent' : 'human',
    agent: normalizeString(context.agent || value.agent) || undefined,
    agentSessionId: normalizeString(context.agentSessionId || value.agentSessionId) || undefined,
  }
}

export function assertAgentRelationshipDecision(task) {
  if (task?.origin?.kind !== 'agent') return

  const decision = task.relationshipDecision
  if (!decision) {
    throw new Error('agent task requires an explicit relationship decision')
  }
  if (decision.state !== task.relationshipState) {
    throw new Error('relationship decision does not match relationshipState')
  }
  if (!normalizeString(decision.reason)) {
    throw new Error('relationship decision reason is required')
  }
  if (decision.state === 'linked' && !normalizeString(task.parentTaskId)) {
    throw new Error('linked relationship decision requires parentTaskId')
  }
  if (decision.state !== 'linked' && normalizeString(task.parentTaskId)) {
    throw new Error('root relationship decision cannot include parentTaskId')
  }
}
