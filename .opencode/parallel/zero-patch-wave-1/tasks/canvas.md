# Worker canvas: standalone registry and canonical event router

Implement ONLY these new files in D:/OpencodeHarness:
- modular/packages/canvas/src/registry.ts
- modular/packages/canvas/src/event-router.ts
- modular/packages/canvas/src/registry.test.ts
- modular/packages/canvas/src/event-router.test.ts

Do not inspect the repository. Use apply_patch only for owned files; no test runs, manifests or lockfile edits. Bun 1.3.14; TS; tests use named imports from bun:test. No any/star/aliased imports. No Solid or native imports: this is browser-safe lifecycle infrastructure.

PINNED shared import: import type { BlockDescriptor } from "@cybermastery/contracts/layout"
Exact BlockDescriptor shape supplied by sibling: {readonly id:string;readonly functionalityID:string;readonly transform:{readonly x:number;readonly y:number;readonly w:number;readonly h:number;readonly z:number}}

registry.ts exports:
type RenderMode = "native" | "projected" | "local" | "static"
type Runtime = { readonly refresh: () => Promise<void>; readonly dispose: () => void }
type BlockDefinition = { readonly functionalityID:string; readonly labelKey:string; readonly mode:RenderMode; readonly contractVersion:number; readonly minW:number; readonly minH:number; readonly create:(block:BlockDescriptor)=>Runtime; readonly render:(block:BlockDescriptor)=>{readonly titleKey:string; readonly bodyKey:string} }
createRegistry(definitions: readonly BlockDefinition[]) returns:
- list(): readonly BlockDefinition[]
- get(id:string): BlockDefinition | undefined
- mount(block:BlockDescriptor): { readonly definition:BlockDefinition; readonly runtime:Runtime; readonly dispose:()=>void } | undefined
Require unique nonempty functionalityID, nonempty labelKey, positive safe integer contractVersion, finite positive minW/minH, recognized render mode, callable create/render. Reject invalid definitions immediately. Own a copy of definitions, preventing later mutations of the supplied array/object from changing registry metadata. mount unsupported IDs returns undefined and never calls a factory. Validate mount size against descriptor minima. mount calls selected factory once. Exposed dispose is idempotent and calls runtime.dispose once. No master host switches or fallback renderers.

event-router.ts exports:
type RuntimeEvent = {readonly id?:string;readonly type:string;readonly properties:Readonly<Record<string,unknown>>}
type EventKey = {readonly type:string;readonly workspaceID?:string;readonly blockID?:string;readonly functionalityID?:string;readonly resourceID?:string}
createEventRouter(listen: (handler:(event:RuntimeEvent)=>void)=>()=>void) returns:
- on(key:EventKey, handler:(event:RuntimeEvent)=>void):()=>void
- onReconnect(handler:()=>void):()=>void
- reconnect():void
- dispose():void

Router requirements: lazy at-most-one underlying listener while event handlers exist; match type and only explicitly requested scope fields; canonical MasterAgent binding events have workspaceID/blockID/sessionID/generation/revision and NO functionalityID. Listener expecting functionalityID should not magically match; callers choose canonical workspace/block key. Dedupe nonempty event IDs in a bounded insertion-order set of 256; do not dedupe events lacking IDs. One handler registered under multiple matching keys fires once per event. Distinct registrations can unsubscribe independently. Last event unsubscribe tears down transport. dispose is idempotent, removes subscribers/reconnect callbacks and dedupe state, and disallows new subscriptions. reconnect calls active reconnect handlers once, clears dedupe state for the new transport incarnation. Callback unsubscription during delivery must not corrupt registry state. No dynamic code loading or global state.

Tests: real in-process transport callback seam without globalThis or mock.module; canonical binding delivery to matching scope, no foreign workspace/block, mismatched functionality filter zero, overlapping keys dedupe, duplicate ID, no-ID repeats, bounded dedupe eviction, unsubscribe/transport lifecycle, reconnect and disposal. Registry tests unknown renderer, duplicate/invalid registrations, injected definition rendering, one factory call and idempotent cleanup.

Return files changed and any missing details. Master validates after wave completion.
