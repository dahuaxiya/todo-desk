import assert from 'node:assert/strict'
import test from 'node:test'
import { calendarSettingsComparableSignature, shouldConsiderTaskForCalendarSync } from '../electron/calendar-sync-policy.js'

const baseTask = {
  id: 'task-1',
  title: '发布版本',
  detail: '整理发布内容',
  project: 'Todo Desk',
  tags: ['release'],
  dueAt: '2026-07-24T10:00:00.000Z',
  reminderAt: '2026-07-24T09:30:00.000Z',
  status: 'doing',
  updatedAt: '2026-07-22T08:00:00.000Z',
  calendarSync: {
    local: { status: 'failed', signature: 'same-event', syncedAt: '2026-07-22T07:00:00.000Z' },
  },
}

test('completion-only changes do not retry external calendars during local save', () => {
  const completedTask = {
    ...baseTask,
    status: 'done',
    completedAt: '2026-07-22T08:01:00.000Z',
    updatedAt: '2026-07-22T08:01:00.000Z',
  }

  assert.equal(shouldConsiderTaskForCalendarSync(completedTask, baseTask, false), false)
})

test('calendar content and calendar settings still trigger synchronization', () => {
  assert.equal(
    shouldConsiderTaskForCalendarSync({ ...baseTask, reminderAt: '2026-07-24T09:45:00.000Z' }, baseTask, false),
    true,
  )
  assert.equal(shouldConsiderTaskForCalendarSync(baseTask, baseTask, true), true)

  const currentSettings = { calendarSyncEnabled: true, larkCalendarSync: true, larkCalendarId: 'primary' }
  const nextSettings = { ...currentSettings, larkCalendarId: 'team-calendar' }
  assert.notEqual(
    calendarSettingsComparableSignature(currentSettings),
    calendarSettingsComparableSignature(nextSettings),
  )
})
