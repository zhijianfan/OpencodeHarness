import { describe, expect, it } from "bun:test"
import type { BlockDescriptor } from "@cybermastery/contracts/layout"
import { createRegistry } from "./registry"
import type { BlockDefinition, Runtime } from "./registry"

function descriptor(functionalityID: string, w = 2, h = 2, id = "block-1"): BlockDescriptor {
  return { id, functionalityID, transform: { x: 0, y: 0, w, h, z: 0 } }
}

function runtime(onDispose: () => void = () => {}): Runtime {
  return { refresh: async () => {}, dispose: onDispose }
}

function definition(overrides: Partial<BlockDefinition> = {}): BlockDefinition {
  return {
    functionalityID: "notes",
    labelKey: "canvas.block.notes",
    mode: "native",
    contractVersion: 1,
    minW: 2,
    minH: 2,
    create: () => runtime(),
    render: () => ({ titleKey: "canvas.notes.title", bodyKey: "canvas.notes.body" }),
    ...overrides,
  }
}

function expectRejected(registrations: readonly unknown[]): void {
  expect(() => createRegistry(registrations as unknown as readonly BlockDefinition[])).toThrow(TypeError)
}

describe("createRegistry", () => {
  it("owns a frozen copy of the supplied definitions", () => {
    const mutable = { ...definition({ functionalityID: "alpha", labelKey: "canvas.alpha" }) }
    const registrations: BlockDefinition[] = [mutable]
    const registry = createRegistry(registrations)

    registrations.push(definition({ functionalityID: "late" }))
    mutable.functionalityID = "renamed"
    mutable.labelKey = "canvas.mutated"

    expect(registry.list().map((entry) => entry.functionalityID)).toEqual(["alpha"])
    expect(registry.get("alpha")?.labelKey).toBe("canvas.alpha")
    expect(registry.get("renamed")).toBeUndefined()
    expect(registry.get("late")).toBeUndefined()
  })

  it("rejects duplicate, empty, and malformed registrations immediately", () => {
    expectRejected([definition({ functionalityID: "alpha" }), definition({ functionalityID: "alpha" })])
    expectRejected([definition({ functionalityID: "" })])
    expectRejected([definition({ labelKey: "" })])
    expectRejected([{ ...definition(), mode: "hologram" }])
    expectRejected([definition({ contractVersion: 0 })])
    expectRejected([definition({ contractVersion: 2.5 })])
    expectRejected([definition({ minW: 0 })])
    expectRejected([definition({ minH: Number.POSITIVE_INFINITY })])
    expectRejected([{ ...definition(), create: 42 }])
    expectRejected([{ ...definition(), render: undefined }])
    expectRejected([null])
  })

  it("mounts through one factory call and disposes idempotently", () => {
    let createCalls = 0
    let disposeCalls = 0
    const registry = createRegistry([
      definition({
        create: () => {
          createCalls += 1
          return runtime(() => {
            disposeCalls += 1
          })
        },
      }),
    ])

    const mounted = registry.mount(descriptor("notes"))
    if (mounted === undefined) throw new Error("expected the supported block to mount")
    const selected = registry.get("notes")
    if (selected === undefined) throw new Error("expected the registered definition")
    expect(mounted.definition).toBe(selected)
    expect(createCalls).toBe(1)

    mounted.dispose()
    mounted.dispose()
    expect(disposeCalls).toBe(1)
  })

  it("returns undefined for unsupported IDs without calling factories", () => {
    let createCalls = 0
    const registry = createRegistry([
      definition({
        create: () => {
          createCalls += 1
          return runtime()
        },
      }),
    ])

    expect(registry.mount(descriptor("missing"))).toBeUndefined()
    expect(createCalls).toBe(0)
  })

  it("rejects undersized mounts without calling factories", () => {
    let createCalls = 0
    const registry = createRegistry([
      definition({
        minW: 4,
        minH: 3,
        create: () => {
          createCalls += 1
          return runtime()
        },
      }),
    ])

    expect(registry.mount(descriptor("notes", 3, 3))).toBeUndefined()
    expect(registry.mount(descriptor("notes", 4, 2))).toBeUndefined()
    expect(createCalls).toBe(0)

    expect(registry.mount(descriptor("notes", 4, 3))).toBeDefined()
    expect(createCalls).toBe(1)
  })

  it("renders through the injected definition", () => {
    const registry = createRegistry([
      definition({
        render: (block) => ({ titleKey: `title.${block.id}`, bodyKey: `body.${block.functionalityID}` }),
      }),
    ])

    const selected = registry.get("notes")
    if (selected === undefined) throw new Error("expected the definition to be registered")
    expect(selected.render(descriptor("notes", 2, 2, "block-9"))).toEqual({
      titleKey: "title.block-9",
      bodyKey: "body.notes",
    })
  })
})
