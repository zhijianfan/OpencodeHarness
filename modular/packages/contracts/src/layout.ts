export type Actor = { readonly userID: string }

export type LayoutTuple = {
  readonly user: string
  readonly style: string
  readonly deviceClass: "desktop" | "mobile" | "tablet"
}

export type BlockDescriptor = {
  readonly id: string
  readonly functionalityID: string
  readonly transform: {
    readonly x: number
    readonly y: number
    readonly w: number
    readonly h: number
    readonly z: number
  }
}

export type Layout = {
  readonly id: string
  readonly workspaceID: string
  readonly revision: number
  readonly blocks: readonly BlockDescriptor[]
}

export type LayoutCommand = {
  readonly workspaceID: string
  readonly tuple: LayoutTuple
  readonly clientID: string
  readonly expectedRevision: number
  readonly blocks: readonly BlockDescriptor[]
}

export class InvalidLayoutCommand extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InvalidLayoutCommand"
  }
}

const commandKeys: readonly string[] = ["workspaceID", "tuple", "clientID", "expectedRevision", "blocks"]
const tupleKeys: readonly string[] = ["user", "style", "deviceClass"]
const blockKeys: readonly string[] = ["id", "functionalityID", "transform"]
const transformKeys: readonly string[] = ["x", "y", "w", "h", "z"]
const purityKeys: readonly string[] = ["runtime", "session", "content"]

export function decodeLayoutCommand(value: unknown): LayoutCommand {
  const path = "layoutCommand"
  const record = requireRecord(value, path)
  rejectUnknownKeys(record, commandKeys, path)

  return {
    workspaceID: requireIdentity(record.workspaceID, `${path}.workspaceID`),
    tuple: decodeTuple(record.tuple, `${path}.tuple`),
    clientID: requireIdentity(record.clientID, `${path}.clientID`),
    expectedRevision: requireRevision(record.expectedRevision, `${path}.expectedRevision`),
    blocks: decodeBlocks(record.blocks, `${path}.blocks`),
  }
}

export function decodeLayoutTuple(value: unknown): LayoutTuple {
  return decodeTuple(value, "layoutTuple")
}

function decodeTuple(value: unknown, path: string): LayoutTuple {
  const record = requireRecord(value, path)
  rejectUnknownKeys(record, tupleKeys, path)

  return {
    user: requireIdentity(record.user, `${path}.user`),
    style: requireIdentity(record.style, `${path}.style`),
    deviceClass: requireDeviceClass(record.deviceClass, `${path}.deviceClass`),
  }
}

function decodeBlocks(value: unknown, path: string): readonly BlockDescriptor[] {
  if (!Array.isArray(value)) fail(path, "expected an array")
  const entries: readonly unknown[] = value
  const seen = new Set<string>()

  return entries.map((entry, index) => {
    const block = decodeBlock(entry, `${path}[${index}]`)
    if (seen.has(block.id)) fail(`${path}[${index}].id`, `duplicate block id "${block.id}"`)
    seen.add(block.id)
    return block
  })
}

function decodeBlock(value: unknown, path: string): BlockDescriptor {
  const record = requireRecord(value, path)
  for (const key of Object.keys(record)) {
    if (purityKeys.includes(key)) fail(`${path}.${key}`, "runtime, session and content fields are not allowed in layout blocks")
    if (!blockKeys.includes(key)) fail(`${path}.${key}`, "unsupported property")
  }

  return {
    id: requireIdentity(record.id, `${path}.id`),
    functionalityID: requireIdentity(record.functionalityID, `${path}.functionalityID`),
    transform: decodeTransform(record.transform, `${path}.transform`),
  }
}

function decodeTransform(value: unknown, path: string): BlockDescriptor["transform"] {
  const record = requireRecord(value, path)
  rejectUnknownKeys(record, transformKeys, path)

  return {
    x: requireNumber(record.x, `${path}.x`),
    y: requireNumber(record.y, `${path}.y`),
    w: requireSize(record.w, `${path}.w`),
    h: requireSize(record.h, `${path}.h`),
    z: requireNumber(record.z, `${path}.z`),
  }
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allowedKeys = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) fail(`${path}.${key}`, "unsupported property")
  }
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) fail(path, "expected an object")
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requireIdentity(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) fail(path, "expected a nonempty string")
  return value
}

function requireDeviceClass(value: unknown, path: string): LayoutTuple["deviceClass"] {
  if (value !== "desktop" && value !== "mobile" && value !== "tablet") {
    fail(path, 'expected one of "desktop", "mobile" or "tablet"')
  }
  return value
}

function requireRevision(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(path, "expected a nonnegative safe integer")
  }
  return value
}

function requireNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "expected a finite number")
  return value
}

function requireSize(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    fail(path, "expected a finite positive number")
  }
  return value
}

function fail(path: string, description: string): never {
  throw new InvalidLayoutCommand(`${path}: ${description}`)
}
