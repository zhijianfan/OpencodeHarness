# Worker contracts: external browser-safe layout contract

Implement ONLY these new files in D:/OpencodeHarness:
- modular/packages/contracts/src/layout.ts
- modular/packages/contracts/src/layout.test.ts

Do not read the repository. All required context follows. Use apply_patch to create files. No tool, dependency, manifest or lockfile changes; no tests run by you.

The independent workspace uses Bun 1.3.14 and TypeScript. This package has no runtime dependencies. Tests import { describe, expect, test } from "bun:test". No any, aliases or star imports. No defaults that silently repair invalid requests. Validation failures must have predictable messages; user-facing localization is not relevant for these internal DTO errors.

PINNED CONTRACTS (export exactly these types, readonly throughout):
type Actor = { readonly userID: string }
type LayoutTuple = { readonly user: string; readonly style: string; readonly deviceClass: "desktop" | "mobile" | "tablet" }
type BlockDescriptor = { readonly id: string; readonly functionalityID: string; readonly transform: { readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly z: number } }
type Layout = { readonly id: string; readonly workspaceID: string; readonly revision: number; readonly blocks: readonly BlockDescriptor[] }
type LayoutCommand = { readonly workspaceID: string; readonly tuple: LayoutTuple; readonly clientID: string; readonly expectedRevision: number; readonly blocks: readonly BlockDescriptor[] }

Exports:
- class InvalidLayoutCommand extends Error (name set to InvalidLayoutCommand).
- decodeLayoutCommand(value: unknown): LayoutCommand
- decodeLayoutTuple(value: unknown): LayoutTuple

Requirements:
1. Accept only exact allowed properties on all objects (commands, tuples, blocks and transforms). Reject array/null as objects. Reject runtime/session/content fields in block descriptors (layout purity).
2. Required string identities must be nonempty after trim; preserve original strings, do not trim stored IDs.
3. expectedRevision must be a nonnegative safe integer. x/y/z must be finite numbers; w/h finite positive numbers. Fractional positions and negative x/y are valid. Blocks must be an array with unique nonempty IDs; empty array valid.
4. Device class is exactly the three strings above. Decode creates fresh objects/arrays rather than retaining mutable caller objects. Do not freeze arrays globally, but ensure mutating input after decode cannot change output.
5. Throw InvalidLayoutCommand with a useful field path in message for invalid input.
6. Tests actual decoders: valid negative/fractional coordinates; valid empty layout; missing and extra fields; null/arrays; Infinity/NaN/zero width; duplicate block IDs; invalid revision; tuple case; input mutation isolation. Do not just copy implementation logic into tests.

Return files changed and uncertainty. The master supplies manifests and runs `bun test src/layout.test.ts` in this package after the wave ends.
