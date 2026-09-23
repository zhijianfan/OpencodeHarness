import type { BlockDescriptor } from "@cybermastery/contracts/layout"

export type RenderMode = "native" | "projected" | "local" | "static"

export type Runtime = {
  readonly refresh: () => Promise<void>
  readonly dispose: () => void
}

export type BlockDefinition = {
  readonly functionalityID: string
  readonly labelKey: string
  readonly mode: RenderMode
  readonly contractVersion: number
  readonly minW: number
  readonly minH: number
  readonly create: (block: BlockDescriptor) => Runtime
  readonly render: (block: BlockDescriptor) => { readonly titleKey: string; readonly bodyKey: string }
}

export function createRegistry(definitions: readonly BlockDefinition[]): {
  list(): readonly BlockDefinition[]
  get(id: string): BlockDefinition | undefined
  mount(block: BlockDescriptor):
    | {
        readonly definition: BlockDefinition
        readonly runtime: Runtime
        readonly dispose: () => void
      }
    | undefined
} {
  const byFunctionalityID = new Map<string, BlockDefinition>()

  definitions.forEach((value, index) => {
    const definition = requireDefinition(value, index)
    if (byFunctionalityID.has(definition.functionalityID)) {
      throw new TypeError(`duplicate functionalityID "${definition.functionalityID}" at index ${index}`)
    }
    byFunctionalityID.set(definition.functionalityID, definition)
  })

  // Owned frozen copies: later mutations of the supplied array or objects cannot reach registry metadata.
  const owned = Object.freeze(Array.from(byFunctionalityID.values()))

  return {
    list: () => owned,
    get: (id) => byFunctionalityID.get(id),
    mount: (block) => {
      const definition = byFunctionalityID.get(block.functionalityID)
      if (definition === undefined) return undefined
      if (!supportsSize(block, definition)) return undefined

      const runtime = definition.create(block)
      let disposed = false

      return Object.freeze({
        definition,
        runtime,
        dispose: () => {
          if (disposed) return
          disposed = true
          runtime.dispose()
        },
      })
    },
  }
}

function requireDefinition(value: unknown, index: number): BlockDefinition {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`definition at index ${index} must be an object`)
  }

  const source = value as Readonly<Record<string, unknown>>

  const functionalityID = source["functionalityID"]
  if (typeof functionalityID !== "string" || functionalityID.length === 0) {
    throw new TypeError(`definition at index ${index} must declare a nonempty functionalityID`)
  }

  const labelKey = source["labelKey"]
  if (typeof labelKey !== "string" || labelKey.length === 0) {
    throw new TypeError(`definition "${functionalityID}" must declare a nonempty labelKey`)
  }

  const mode = source["mode"]
  if (!isRenderMode(mode)) {
    throw new TypeError(`definition "${functionalityID}" declares unsupported render mode "${String(mode)}"`)
  }

  const contractVersion = source["contractVersion"]
  if (typeof contractVersion !== "number" || !Number.isSafeInteger(contractVersion) || contractVersion <= 0) {
    throw new TypeError(`definition "${functionalityID}" must declare a positive safe integer contractVersion`)
  }

  const minW = requireSize(source["minW"], functionalityID, "minW")
  const minH = requireSize(source["minH"], functionalityID, "minH")

  const create = source["create"]
  if (typeof create !== "function") {
    throw new TypeError(`definition "${functionalityID}" must declare a callable create`)
  }

  const render = source["render"]
  if (typeof render !== "function") {
    throw new TypeError(`definition "${functionalityID}" must declare a callable render`)
  }

  return Object.freeze({
    functionalityID,
    labelKey,
    mode,
    contractVersion,
    minW,
    minH,
    create: create as (block: BlockDescriptor) => Runtime,
    render: render as (block: BlockDescriptor) => { readonly titleKey: string; readonly bodyKey: string },
  })
}

function requireSize(value: unknown, functionalityID: string, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`definition "${functionalityID}" must declare a finite positive ${field}`)
  }
  return value
}

function isRenderMode(value: unknown): value is RenderMode {
  return value === "native" || value === "projected" || value === "local" || value === "static"
}

function supportsSize(block: BlockDescriptor, definition: BlockDefinition): boolean {
  if (!Number.isFinite(block.transform.w) || block.transform.w < definition.minW) return false
  if (!Number.isFinite(block.transform.h) || block.transform.h < definition.minH) return false
  return true
}
