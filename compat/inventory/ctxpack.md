# CtxPack extraction ledger — T08/T10 waves16–22

Baseline: retained fork `packages/schema/src/ctxpack.ts`, `ctxpack-tag.ts`, `ctxpack-limits.ts` and `packages/core/src/ctxpack/{validation,hash,search,recall,sql,service,materialize,usage,session-context}.ts`. Official vendor remains unchanged.

## Implemented slice

| Behavior | Baseline evidence | External owner / verified behavior |
| --- | --- | --- |
| Wire DTOs/errors | schema/ctxpack.ts:47–155,219–301 | Browser-safe contracts/src/ctxpack.ts, no native/Effect/crypto runtime dependency |
| Text/keyword normalization | schema/ctxpack.ts:173–182 | domain/ctxpack-content.ts; preserves text line endings/whitespace versus keyword NFKC semantics |
| Content + provenance hash | schema/ctxpack.ts:190–217; core/ctxpack/hash.ts | Exact ordered ordinal/text/source canonical form and sha256 prefix; integer-like key enumeration tested |
| Capture limits and splitting | core/ctxpack/validation.ts:118–189 | 1–32 fragments, <=16KiB UTF-8 slices, <=64KiB total, Unicode code-point boundaries and post-split count check |
| Source policy | validation.ts:140–185; capability/service.ts deny-first private rule | Cross-workspace/secret source rejection and sensitivity ordering; catalog private packs deny noncreators |
| FTS and recall terms | core/ctxpack/search.ts:24–46; recall.ts:32–87 | Quoted AND FTS terms, exact keyword behavior, stable max8 recall terms/trivial-turn detection; advisory selection is enabled only for trusted bound OperatingChat Sessions |
| Create retry | core/ctxpack/sql.ts:427–488 | Key is workspace + creator + idempotencyKey; different valid retry payload returns original winner, one created hint |
| Metadata patch | core/ctxpack/sql.ts:503–561 | CAS and writer reservation; empty patch increments revision; stable content/hash; patch idempotencyKey remains metadata, not deduplication |
| List and visibility | core/ctxpack/sql.ts:565–653 | Private filtering before paging/count; all7 sorts and ID tie-breaks; null-last cursor; FTS intersects metadata filters |
| Delete/restore/pins | core/ctxpack/sql.ts:655–749 | No invented revision increments; per-user immutable repeat pin time; deleted packs excluded from pinned lists; restore retains other users' pins |
| Commit/event boundary | core/ctxpack/service.ts:110–123 and mutation methods | Captures selected native DB/EventBoundary, reauthorizes at commit, suppresses rollback hints and tolerates postcommit publisher failure |
| Durable capsule | core/context-broker/{sql,capsule}.ts | owned cm_context_capsule in same native DB, immutable ID/body, workspace scope, stored JSON validation, reference filtering/expiry/budgets |
| Materializer/snapshot | core/ctxpack/materialize.ts:215–477 | real catalog+capsule, target/purpose/audience/instance/capability checks, current pack fragment resolution, V1 snapshot; no premature usage |
| Admitted usage | core/ctxpack/usage.ts | cm_ctx_pack_usage_admission ledger; one counted use per pack/native admitted input, atomic multi-pack, aftercommit used hints; verified workspace-native input is an explicit stricter selected-host boundary |
| Host/HTTP | core/ctxpack/session-context.ts; fork HTTP routes | same selected host graph: borrowed catalog/materializer, custom authenticated ctxpack HTTP; real materialize+Session prompt with readiness proof stores private body and counts once; unauthorized and clean-only fail closed |
| Browser-safe client | extension CtxPack HTTP route contract | @cybermastery/client/ctxpack typed CRUD/list/pin/materialize and redacted errors, no native runtime imports; real Bun server roundtrip to one selected application/Session admission graph |
| Trusted OperatingChat recall | core/ctxpack/{recall,session-context}.ts; core/workspace/{operating-chat-context,operating-chat-session}.ts | Same-native-DB cm_operating_chat_binding with native Session placement/runtime checks, revision/generation CAS, soft reset, host-owned authorization port; advisory private/foreign-filtered FTS selection and explicit-first budget. Only bound v2-enriched Sessions add automatic attachments, revalidate at admission commit, and count use once. Not the full fork layout/instance lifecycle. |

Persistence is in owned `cm_ctx_pack`, `cm_ctx_pack_fragment`, `cm_ctx_pack_keyword`, `cm_ctx_pack_pin`, `cm_ctx_pack_fts`, with `cm_migration` entry `0007-ctxpack-catalog`. These map to the same-named fork `ctx_pack*` tables without the prefix. Existing fork tables are not read/moved/deleted by this bootstrap. Native migrations remain delegated unchanged. Missing FTS is backfilled from live owned catalog rows with explicit ordinal order.

Additional extension entries `0008-ctxpack-capsule` and `0009-ctxpack-usage` register `cm_context_capsule` and `cm_ctx_pack_usage_admission`; no fork source table is imported implicitly. Their original names and field meanings remain inventoried for the T12 copied-data migration.

Entry `0010-operating-chat-binding` registers `cm_operating_chat_binding`; post-reset rebinding advances the tombstone generation/revision rather than reusing a stale profile identity. Binding is available only through a trusted host-supplied observed-layout/functionality-instance authorization callback; there is no client-visible binding route in the proof app.

## Verification and scope

Most recent full proof **659 pass / 1 POSIX-only skip / 0 fail** at **2026-09-24T15:22:33.050Z** (adapter512, eight typechecks/build/browser and native attestation); prior wave22 verification below remains a historical snapshot.

Wave16 proof at **2026-09-24T11:07:47.975Z**: 554 pass / 1 skip, including 51 domain content tests and 17 new catalog tests. Latest full proof at **2026-09-24T13:13:28.187Z**: **607 pass / 1 POSIX-only skip / 0 fail**, domain51, adapter489. Eight typechecks, frontend build/browser and official-source attestation passed. Domain tests run in verify:proof.

Wave20 full proof at **2026-09-24T13:30:07.286Z**: **636 pass / 1 POSIX-only skip / 0 fail** (contracts25, Canvas18, compat8, domain51, client42, adapter489, host2, web smoke1). The client suite added29 tests. Eight package/app typechecks, frontend build/browser and official-source attestation passed. Browser code depends only on `@cybermastery/contracts` and standard URL/fetch/JSON, not native Core/Server.

Wave22 full proof at **2026-09-24T15:02:26.121Z**: **659 pass / 1 POSIX-only skip / 0 fail**, adapter512, including real native Session/HTTP/generic-versus-bound recall/usage/revocation and two-connection binding CAS. Eight typechecks, frontend build/real browser and unchanged official-source attestation passed. Wave21 advisory recall selector has 16 focused tests; wave22 binding has 6 focused tests. The host authorization port is deliberately external because the static-card proof layout has no durable functionality-instance authority.

Master review corrected create-time commit reauthorization, caller actor/request detachment, synchronous publisher evaluation timing, storage-error redaction, numeric cursor validation and ordered FTS backfill. A post-split33-fragment case is reachable under the64KiB budget (31 small fragments plus one split fragment); its regression was added. Revision writes are exercised concurrently on two independent native runtimes over one database file.

## Remaining T08/T11 work

T12 source/target product-table and rejection inventory is now recorded in `ctxpack-migration.md`. It is a migration contract, not executable imported-data acceptance.

- Full OperatingChat ensure/reset tied to real observed layout/functionality instances and production UI (current proof accepts a trusted host authority port and binds an existing native Session only).
- Worker/batch result-pack capture, model pinning and partial retries.
- UI catalog integration and one context-scoped event connection multiplexing native+extension hints; client transport is now implemented.
- Read-only copied-data migration for original ctx_pack/capsule/usage tables and preserved identities.

This is a catalog/domain foundation with an exported server composition API, not a claim that T08 or broad G2 extraction is complete.
