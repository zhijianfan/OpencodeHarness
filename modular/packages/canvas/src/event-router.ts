export type RuntimeEvent = {
  readonly id?: string
  readonly type: string
  readonly properties: Readonly<Record<string, unknown>>
}

export type EventKey = {
  readonly type: string
  readonly workspaceID?: string
  readonly blockID?: string
  readonly functionalityID?: string
  readonly resourceID?: string
}

type ScopeField = "workspaceID" | "blockID" | "functionalityID" | "resourceID"

type EventSubscription = {
  readonly key: EventKey
  readonly handler: (event: RuntimeEvent) => void
}

type ReconnectRegistration = {
  readonly handler: () => void
}

const DELIVERED_EVENT_ID_LIMIT = 256

export function createEventRouter(
  listen: (handler: (event: RuntimeEvent) => void) => () => void,
): {
  on(key: EventKey, handler: (event: RuntimeEvent) => void): () => void
  onReconnect(handler: () => void): () => void
  reconnect(): void
  dispose(): void
} {
  const subscriptions = new Set<EventSubscription>()
  const reconnectRegistrations = new Set<ReconnectRegistration>()
  const deliveredEventIDs = new Map<string, true>()

  let transportUnsubscribe: (() => void) | undefined
  let disposed = false

  const receive = (event: RuntimeEvent) => {
    if (disposed) return

    const id = event.id
    if (typeof id === "string" && id.length > 0) {
      if (deliveredEventIDs.has(id)) return
      deliveredEventIDs.set(id, true)
      // Insertion-order bound: evict the oldest ID once the set exceeds 256 entries.
      if (deliveredEventIDs.size > DELIVERED_EVENT_ID_LIMIT) {
        const oldest = deliveredEventIDs.keys().next()
        if (!oldest.done) deliveredEventIDs.delete(oldest.value)
      }
    }

    // Snapshot registrations so unsubscribing mid-delivery cannot corrupt iteration,
    // and dedupe handlers that matched under more than one key.
    const deliveredHandlers = new Set<(event: RuntimeEvent) => void>()
    for (const subscription of Array.from(subscriptions)) {
      if (!subscriptions.has(subscription)) continue
      if (!matchesKey(subscription.key, event)) continue
      if (deliveredHandlers.has(subscription.handler)) continue
      deliveredHandlers.add(subscription.handler)
      subscription.handler(event)
    }
  }

  const ensureTransport = () => {
    if (disposed || transportUnsubscribe !== undefined) return
    transportUnsubscribe = listen(receive)
  }

  const releaseTransport = () => {
    const unsubscribe = transportUnsubscribe
    if (unsubscribe === undefined) return
    transportUnsubscribe = undefined
    unsubscribe()
  }

  return {
    on: (key, handler) => {
      if (disposed) return () => {}
      const subscription: EventSubscription = { key: { ...key }, handler }
      subscriptions.add(subscription)
      ensureTransport()
      let active = true
      return () => {
        if (!active) return
        active = false
        if (!subscriptions.delete(subscription)) return
        if (subscriptions.size === 0) releaseTransport()
      }
    },
    onReconnect: (handler) => {
      if (disposed) return () => {}
      const registration: ReconnectRegistration = { handler }
      reconnectRegistrations.add(registration)
      let active = true
      return () => {
        if (!active) return
        active = false
        reconnectRegistrations.delete(registration)
      }
    },
    reconnect: () => {
      if (disposed) return
      deliveredEventIDs.clear()
      for (const registration of Array.from(reconnectRegistrations)) {
        if (!reconnectRegistrations.has(registration)) continue
        registration.handler()
      }
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      subscriptions.clear()
      reconnectRegistrations.clear()
      deliveredEventIDs.clear()
      releaseTransport()
    },
  }
}

function matchesKey(key: EventKey, event: RuntimeEvent): boolean {
  if (key.type !== event.type) return false
  return (
    matchesScope(key.workspaceID, event, "workspaceID") &&
    matchesScope(key.blockID, event, "blockID") &&
    matchesScope(key.functionalityID, event, "functionalityID") &&
    matchesScope(key.resourceID, event, "resourceID")
  )
}

function matchesScope(requested: string | undefined, event: RuntimeEvent, field: ScopeField): boolean {
  if (requested === undefined) return true
  return event.properties[field] === requested
}
