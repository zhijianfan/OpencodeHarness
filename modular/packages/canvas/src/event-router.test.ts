import { describe, expect, it } from "bun:test"
import { createEventRouter } from "./event-router"
import type { EventKey, RuntimeEvent } from "./event-router"

function createTransport() {
  const handlers = new Set<(event: RuntimeEvent) => void>()
  let listenCalls = 0
  let unsubscribeCalls = 0

  return {
    listen: (handler: (event: RuntimeEvent) => void) => {
      listenCalls += 1
      handlers.add(handler)
      return () => {
        unsubscribeCalls += 1
        handlers.delete(handler)
      }
    },
    emit: (event: RuntimeEvent) => {
      for (const handler of Array.from(handlers)) handler(event)
    },
    listenerCount: () => handlers.size,
    listenCalls: () => listenCalls,
    unsubscribeCalls: () => unsubscribeCalls,
  }
}

const bindingProperties = {
  workspaceID: "workspace-1",
  blockID: "block-1",
  sessionID: "session-1",
  generation: 1,
  revision: 1,
}

function binding(id: string, workspaceID = "workspace-1", blockID = "block-1"): RuntimeEvent {
  return {
    id,
    type: "workspace.master-agent.binding.updated",
    properties: { ...bindingProperties, workspaceID, blockID },
  }
}

function bindingWithoutID(workspaceID = "workspace-1", blockID = "block-1"): RuntimeEvent {
  return {
    type: "workspace.master-agent.binding.updated",
    properties: { ...bindingProperties, workspaceID, blockID },
  }
}

const bindingKey: EventKey = { type: "workspace.master-agent.binding.updated" }

describe("createEventRouter", () => {
  it("attaches lazily and delivers canonical binding events to explicitly scoped keys", () => {
    const transport = createTransport()
    const router = createEventRouter(transport.listen)
    expect(transport.listenCalls()).toBe(0)

    const received: RuntimeEvent[] = []
    router.on({ type: "workspace.master-agent.binding.updated", workspaceID: "workspace-1", blockID: "block-1" }, (event) =>
      received.push(event),
    )
    expect(transport.listenCalls()).toBe(1)

    transport.emit(binding("event-1"))
    expect(received).toHaveLength(1)
    expect(received[0]?.id).toBe("event-1")
  })

  it("ignores foreign workspaces, foreign blocks, and functionality filters on canonical bindings", () => {
    const transport = createTransport()
    const router = createEventRouter(transport.listen)
    let calls = 0

    router.on({ type: "workspace.master-agent.binding.updated", workspaceID: "workspace-9" }, () => {
      calls += 1
    })
    router.on({ type: "workspace.master-agent.binding.updated", blockID: "block-9" }, () => {
      calls += 1
    })
    router.on({ type: "workspace.master-agent.binding.updated", functionalityID: "notes" }, () => {
      calls += 1
    })

    transport.emit(binding("event-1"))
    expect(calls).toBe(0)
  })

  it("matches functionality and resource scopes only when the event carries them", () => {
    const transport = createTransport()
    const router = createEventRouter(transport.listen)
    const received: string[] = []

    router.on({ type: "CanvasDocument.chunk", functionalityID: "notes", resourceID: "document-1" }, (event) =>
      received.push(event.id ?? "missing"),
    )

    transport.emit({
      id: "match",
      type: "CanvasDocument.chunk",
      properties: { functionalityID: "notes", resourceID: "document-1" },
    })
    transport.emit({
      id: "foreign-functionality",
      type: "CanvasDocument.chunk",
      properties: { functionalityID: "charts", resourceID: "document-1" },
    })
    transport.emit({
      id: "foreign-resource",
      type: "CanvasDocument.chunk",
      properties: { functionalityID: "notes", resourceID: "document-2" },
    })
    transport.emit({ id: "absent-functionality", type: "CanvasDocument.chunk", properties: { resourceID: "document-1" } })

    expect(received).toEqual(["match"])
  })

  it("fires one handler registered under overlapping keys once per event", () => {
    const transport = createTransport()
    const router = createEventRouter(transport.listen)
    const received: string[] = []
    const handler = (event: RuntimeEvent) => received.push(event.id ?? "missing")

    router.on(bindingKey, handler)
    router.on({ type: "workspace.master-agent.binding.updated", workspaceID: "workspace-1" }, handler)
    router.on({ type: "workspace.master-agent.binding.updated", workspaceID: "workspace-1", blockID: "block-1" }, handler)
    router.on(bindingKey, handler)

    transport.emit(binding("event-1"))
    expect(received).toEqual(["event-1"])
  })

  it("dedupes repeated nonempty event IDs regardless of scope", () => {
    const transport = createTransport()
    const router = createEventRouter(transport.listen)
    const received: string[] = []
    router.on(bindingKey, (event) => received.push(event.id ?? "missing"))

    transport.emit(binding("event-1"))
    transport.emit(binding("event-1", "workspace-9", "block-9"))
    expect(received).toEqual(["event-1"])
  })

  it("delivers events without IDs every time", () => {
    const transport = createTransport()
    const router = createEventRouter(transport.listen)
    const received: string[] = []
    router.on(bindingKey, (event) => received.push(event.id ?? "missing"))

    transport.emit(bindingWithoutID())
    transport.emit(bindingWithoutID())
    transport.emit({ ...bindingWithoutID(), id: "" })
    transport.emit({ ...bindingWithoutID(), id: "" })
    expect(received).toEqual(["missing", "missing", "", ""])
  })

  it("bounds the dedupe set to the most recent 256 insertion-ordered IDs", () => {
    const transport = createTransport()
    const router = createEventRouter(transport.listen)
    const received: string[] = []
    router.on({ type: "CanvasDocument.chunk" }, (event) => received.push(event.id ?? "missing"))

    for (let index = 0; index < 257; index += 1) {
      transport.emit({ id: `event-${index}`, type: "CanvasDocument.chunk", properties: {} })
    }
    expect(received).toHaveLength(257)

    transport.emit({ id: "event-0", type: "CanvasDocument.chunk", properties: {} })
    expect(received).toHaveLength(258)

    transport.emit({ id: "event-256", type: "CanvasDocument.chunk", properties: {} })
    expect(received).toHaveLength(258)
  })

  it("keeps one lazy transport listener for the lifetime of active subscribers", () => {
    const transport = createTransport()
    const router = createEventRouter(transport.listen)

    const unsubscribeFirst = router.on(bindingKey, () => {})
    const unsubscribeSecond = router.on(bindingKey, () => {})
    expect(transport.listenCalls()).toBe(1)
    expect(transport.listenerCount()).toBe(1)

    unsubscribeFirst()
    expect(transport.unsubscribeCalls()).toBe(0)
    expect(transport.listenerCount()).toBe(1)

    unsubscribeSecond()
    expect(transport.unsubscribeCalls()).toBe(1)
    expect(transport.listenerCount()).toBe(0)

    const unsubscribeThird = router.on(bindingKey, () => {})
    expect(transport.listenCalls()).toBe(2)
    unsubscribeThird()
    expect(transport.unsubscribeCalls()).toBe(2)
  })

  it("unsubscribes distinct registrations independently", () => {
    const transport = createTransport()
    const router = createEventRouter(transport.listen)
    const received: string[] = []
    const handler = (event: RuntimeEvent) => received.push(event.id ?? "missing")

    const unsubscribeFirst = router.on(bindingKey, handler)
    router.on({ type: "workspace.master-agent.binding.updated", workspaceID: "workspace-1" }, handler)

    unsubscribeFirst()
    unsubscribeFirst()
    transport.emit(binding("event-1"))
    expect(received).toEqual(["event-1"])
    expect(transport.listenerCount()).toBe(1)

    transport.emit(binding("event-2"))
    expect(received).toEqual(["event-1", "event-2"])
  })

  it("survives unsubscription during delivery", () => {
    const transport = createTransport()
    const router = createEventRouter(transport.listen)
    const calls: string[] = []
    let unsubscribeFirst = () => {}
    let unsubscribeSecond = () => {}

    unsubscribeFirst = router.on(bindingKey, () => {
      calls.push("first")
      unsubscribeFirst()
      unsubscribeSecond()
    })
    unsubscribeSecond = router.on(bindingKey, () => calls.push("second"))

    transport.emit(binding("event-1"))
    expect(calls).toEqual(["first"])
    expect(transport.unsubscribeCalls()).toBe(1)
    expect(transport.listenerCount()).toBe(0)

    transport.emit(binding("event-2"))
    expect(calls).toEqual(["first"])

    const unsubscribeThird = router.on(bindingKey, () => calls.push("third"))
    expect(transport.listenCalls()).toBe(2)
    transport.emit(binding("event-3"))
    expect(calls).toEqual(["first", "third"])
    unsubscribeThird()
  })

  it("reconnects active handlers once and clears dedupe state", () => {
    const transport = createTransport()
    const router = createEventRouter(transport.listen)
    const order: string[] = []
    const received: string[] = []

    router.on(bindingKey, (event) => received.push(event.id ?? "missing"))
    const unsubscribeFirst = router.onReconnect(() => order.push("first"))
    router.onReconnect(() => order.push("second"))

    transport.emit(binding("event-1"))
    transport.emit(binding("event-1"))
    expect(received).toEqual(["event-1"])

    unsubscribeFirst()
    router.reconnect()
    expect(order).toEqual(["second"])

    transport.emit(binding("event-1"))
    expect(received).toEqual(["event-1", "event-1"])

    router.reconnect()
    expect(order).toEqual(["second", "second"])
  })

  it("disposes idempotently and refuses later subscriptions", () => {
    const transport = createTransport()
    const router = createEventRouter(transport.listen)
    const received: string[] = []
    let reconnects = 0

    router.on(bindingKey, (event) => received.push(event.id ?? "missing"))
    router.onReconnect(() => {
      reconnects += 1
    })
    expect(transport.listenerCount()).toBe(1)

    router.dispose()
    router.dispose()

    expect(transport.unsubscribeCalls()).toBe(1)
    expect(transport.listenerCount()).toBe(0)
    expect(transport.listenCalls()).toBe(1)

    const unsubscribeLate = router.on(bindingKey, (event) => received.push(event.id ?? "missing"))
    unsubscribeLate()
    const unsubscribeLateReconnect = router.onReconnect(() => {
      reconnects += 1
    })
    unsubscribeLateReconnect()
    expect(transport.listenCalls()).toBe(1)

    router.reconnect()
    expect(reconnects).toBe(0)

    transport.emit(binding("event-1"))
    expect(received).toHaveLength(0)
  })
})
