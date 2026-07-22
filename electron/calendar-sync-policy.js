function taskCalendarComparableSignature(task) {
  return JSON.stringify({
    id: task.id,
    title: task.title,
    detail: task.detail,
    project: task.project,
    tags: task.tags || [],
    dueAt: task.dueAt || '',
    reminderAt: task.reminderAt || '',
    agent: task.agent || task.origin?.agent?.name || '',
    agentSessionId: task.agentSessionId || task.origin?.agent?.sessionId || '',
    repository: task.repository || task.origin?.repository?.name || '',
  })
}

export function calendarSettingsComparableSignature(settings) {
  return JSON.stringify({
    calendarSyncEnabled: settings.calendarSyncEnabled !== false,
    larkCalendarSync: settings.larkCalendarSync !== false,
    larkCalendarId: String(settings.larkCalendarId || 'primary').trim() || 'primary',
  })
}

export function shouldConsiderTaskForCalendarSync(task, previousTask, calendarSettingsChanged) {
  if (!previousTask) return true
  if (calendarSettingsChanged) return true
  // Completion, parent-link and review-state changes do not alter calendar events. Retrying a
  // failed calendar command during those unrelated saves made every local action wait on external I/O.
  return taskCalendarComparableSignature(task) !== taskCalendarComparableSignature(previousTask)
}
