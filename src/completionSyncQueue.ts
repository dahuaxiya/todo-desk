export interface SerialBackgroundQueue {
  enqueue: (job: () => Promise<void>) => void
  whenIdle: () => Promise<void>
}

export function createSerialBackgroundQueue(onError: (error: unknown) => void = () => undefined): SerialBackgroundQueue {
  let tail = Promise.resolve()

  return {
    enqueue(job) {
      // Cloud writes must remain ordered because every response carries a newer sync-log snapshot.
      // Catch inside the chain so one failed request cannot prevent later completion batches syncing.
      tail = tail.then(job).catch(onError)
    },
    whenIdle() {
      return tail
    },
  }
}

export function enqueueCompletionSync(
  queue: SerialBackgroundQueue,
  taskIds: Iterable<string>,
  sync: (taskIds: string[]) => Promise<void>,
) {
  const uniqueTaskIds = [...new Set(taskIds)].filter(Boolean)
  if (uniqueTaskIds.length === 0) return false

  // A completion batch represents one user action and one board snapshot, so it should produce
  // one Lark document update rather than one network round trip for every descendant.
  queue.enqueue(() => sync(uniqueTaskIds))
  return true
}
