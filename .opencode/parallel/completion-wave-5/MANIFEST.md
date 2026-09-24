# Completion wave 5 — authorized Session access and lossless legacy codecs

Runs after the verified wave-4 working tree (192 tests); that work is retained. All workers use `openai/gpt-6-astra`, variant `high`, through fresh parallel CLI sessions.

| Worker | Exclusive files | Acceptance |
| --- | --- | --- |
| session-access | modular/packages/adapters-opencode/src/session-access.ts; test/session-access.test.ts in the same package | Actor/placement-authorized native commands and queries; immutable attachment identity; prompt retry/resume/queue semantics; clean public reads |
| legacy-context | modular/packages/adapters-opencode/src/legacy-context.ts; test/legacy-context.test.ts in the same package | Lossless v1/v2 input snapshots, renderer 1/2, exact canonical/hash/byte rules and request identity |
| legacy-bundle | modular/packages/adapters-opencode/src/legacy-bundle.ts; test/legacy-bundle.test.ts in the same package | BundleV1 envelope/identity/deletion/epoch validation against complete merged history, without stripping fork event fields |

Three lanes are useful here: the context codec's small public contract is frozen below, so the bundle worker can implement against it without waiting for code or editing the same files. No shared configuration/package/export/schema changes by workers. No commands/tests/exploration. The master supplies source snapshots, then integrates and validates only after all three return.

## Frozen context codec API

```ts
export type LegacyJson = null | boolean | number | string | readonly LegacyJson[] | { readonly [key: string]: LegacyJson }
export type LegacyJsonObject = { readonly [key: string]: LegacyJson }
export type LegacyInputContext = {
  readonly version: 1 | 2
  readonly rendererVersion: 1 | 2
  readonly snapshot: LegacyJsonObject
  readonly contextRequestHash: string
  readonly apiContent: string
  readonly apiContentHash: string
}
export class LegacyContextError extends Error { readonly code: string; constructor(code: string) }
export function legacyCanonical(value: unknown): string
export function legacyDigest(value: unknown): string // "sha256:" + SHA256(legacyCanonical(value))
export function decodeLegacyContext(value: unknown, promptText: string): LegacyInputContext
```

These modules perform validation only. The master owns authenticated HTTP composition, native projection/sidecar persistence, migration registration, package exports, allowlists and gate changes. Codec acceptance is not permission to bypass placement/owner/readiness checks or claim full transfer parity.
