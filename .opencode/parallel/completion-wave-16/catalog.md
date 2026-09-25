# Worker2 of2 — native-database CtxPack catalog

Use opencode-go/deepseek-v4.1-flash/high. Own ONLY modular/packages/adapters-opencode/src/ctxpack-catalog.ts and test/ctxpack-catalog.test.ts in D:/OpencodeHarness. No exploration, commands/tests, Git, delegation or other edits. Attached source/contract/helper signatures are all context. Preserve official vendor source; fork sources are CUSTOM feature references only, never runtime imports. Return files/guarantees/uncertainties, not pass claims.

## Frozen dependencies

DTOs/types from @cybermastery/contracts/ctxpack (attached). Worker1 provides @cybermastery/domain/ctxpack-content with synchronous exports:
normalizeSelectedText(string):string; normalizeKeyword(string):string; utf8ByteLength(string):number; estimateTokens(number):number; contentHash(readonly {ordinal:number;text:string;source:CtxPackSource}[]):string; normalizeCreate(unknown):CtxPackCreateRequest & {tags:readonly CtxPackTag[]}; normalizePatch(unknown,readonly CtxPackSource[]):CtxPackPatchRequest; normalizeList(unknown):CtxPackListRequest; isCtxPackError(unknown):input is CtxPackError; buildFtsQuery(string):string|null; buildRecallTerms(string):readonly string[]; isTrivialRecallTurn(string):boolean. They throw CtxPackError shaped values. Do not inspect worker1 files or duplicate validation/hashes.

## API

Export makeCtxPackCatalog(options:{readonly authorize:(request:CtxPackAccess)=>Effect.Effect<void,CtxPackError>;readonly publish?:(event:CtxPackChanged)=>Effect.Effect<void>;readonly now?:()=>number}). Effect constructor captures Database.Service and EventBoundary, initializes extension tables in the SAME selected native DB, returns methods with captured dependencies (no further env):
- create(actor:CtxPackActor,request:unknown):Effect.Effect<CtxPackInfo,CtxPackError>
- get(actor:CtxPackActor,ctxPackID:string,includeDeleted?:boolean):Effect.Effect<CtxPackInfo,CtxPackError>
- list(actor:CtxPackActor,request:unknown):Effect.Effect<CtxPackListResult,CtxPackError>
- patch(actor:CtxPackActor,request:unknown):Effect.Effect<CtxPackInfo,CtxPackError>
- remove/restore(actor:CtxPackActor,input:{readonly ctxPackID:string;readonly expectedRevision:number}):Effect.Effect<CtxPackInfo,CtxPackError>
- pin(actor:CtxPackActor,ctxPackID:string):Effect.Effect<CtxPackInfo,CtxPackError>
- unpin(actor:CtxPackActor,ctxPackID:string):Effect.Effect<void,CtxPackError>

No Capsule/recall/usage mutators yet; preserve Info.usage fields and storage columns for subsequent integration. No feature HTTP or application graph edits in this task. Use native exported ascending() from @opencode-ai/schema/identifier for ctxpk_/ctxpkf_ IDs (attached implementation), not fork CtxPack schema. Domain/shared DTO IDs are strings.

## Persistence/policy

Port baseline custom ctxpack/sql.ts + service.ts behavior using extension tables cm_ctx_pack, cm_ctx_pack_fragment, cm_ctx_pack_keyword, cm_ctx_pack_pin and cm_ctx_pack_fts; journal under cm_migration id 0007-ctxpack-catalog. Preserve column semantics from attached original tables (except cm_ prefix); do not silently move/read/delete old ctx_pack tables or modify native migration ledger. FTS5 tokenizer unicode61 remove_diacritics2, initialize before first search/write; when creating missing FTS over existing cm_ catalog rows, backfill existing live packs transactionally. Record native/legacy table mapping as a code comment for later copy migration.

Actor explicit nonempty user/workspace; request.workspaceID must match actor. Lookup is always workspace-scoped. Private packs deny EVERY operation for a noncreator independent of the injected capability policy (baseline deny-first rule); list excludes noncreator private rows BEFORE pagination/count/FTS. authorize operation strings: create ctxpack.create; get/list/pin/unpin ctxpack.read; patch/remove/restore corresponding contract op. Non-list operations supply current pack when available. Require authorization before mutation AND recheck inside EventBoundary.transaction with freshly loaded row. A failed/changed authorization rolls back catalog/fragment/keyword/FTS/pins and emits no hints.

All writes use EventBoundary.transaction; preserve native outer-transaction ownership, avoid fork/concurrent Effect.all inside a write. Notifications via boundary.afterCommit; envelope has only workspaceID/ctxPackID/revision/change, never text. Non-interruption publisher failure must not fail or roll back committed mutation and must not log private error data; use sanitized fixed logging or swallow. No-op create/pin/unpin/restore emits no duplicate hints.

Baseline details to preserve (not guesses):
- create idempotent by (workspaceID,createdByUserID,idempotencyKey), including raced two-connection retries. Reusing key returns the original winner even with a different valid payload (baseline does NOT compare create payload hash). Emit created once. Initial revision1; preserve tags; server fragment ID doubles as clientFragmentID on reload (original does not persist client ID). Fragment hash includes actual ordinal + provenance; pack hash sums ordered normalized content. byteLength sum; estimatedTokens SUM of per-fragment ceil(bytes/4).
- Metadata patch checks expectedRevision and increments revision/time_updated even for an empty patch; content/fragments/hash stay unchanged. Patch idempotencyKey is wire metadata ONLY: baseline patch does not dedup it, so stale retry conflicts. Enforce SQL CAS/reserved writer across separate connections.
- remove requires live/exact revision, sets time_deleted and removes FTS. restore checks revision, clears deletion and restores FTS only if deleted; live restore is no-op. Both retain revision/time_updated per baseline (do not invent increments).
- Per-user pin/unpin: pin time immutable on exact repeat; no revision change; pins on deleted pack rejected, unpin may remove an existing pin on deleted pack. Deleted packs never in pinnedOnly list even includeDeleted:true. Restore can reveal retained pins.
- List preserves all7 sorts, id tie-break same direction, null last for recently-attached; count excludes cursor but includes visibility/filter; limit+1 keyset paging; no fragment bodies in Summary. Cursor v1 Base64URL JSON {version:1,sort,value,id}; reject malformed/type-incompatible cursors. Raw search sanitized with buildFtsQuery before MATCH. Whitespace/empty/punctuation-only sanitizes to empty and skips MATCH as the existing service does. Metadata filters INTERSECT with FTS. Keyword filter uses normalizeKeyword exactly (case preserved).

Use Schema helpers for DB JSON, never unsafe casts/any/star/alias imports. Decode stored shapes; unknown SQL/driver errors are sanitized defects (no fragment text in surfaced error). Structural methods should return the contract union failures. Scope/clock/input objects detach before first await.

## Tests

Real file-backed createMediatedKernel/runtime + actual native DB, constructor bootstrap, EventBoundary + disposal/databaseCleanup. Verify create/hash/order/tags/reload/idempotency incl changed-valid payload; CAS patch; stable hash; privacy BEFORE counts/paging; all sort/null cursor cases; FTS AND filters/punctuation/quotes and missing-index backfill; per-user pins/remove/restore edge semantics; authorization revoked at commit; afterCommit outer rollback suppresses hints; publisher defect leaves committed data. Use independent runtimes on same file for create/revision races, no polling/sleeps/globalThis. No mocks of the database or copied expected implementation. Native APIs and fixture examples are attached; Effect v4 uses Effect.catch, forkScoped, Fiber.await, no fork/zipRight/failureOption.
