# OpenCode encapsulation and CyberMastery mediation plan

- Date: 2026-09-23
- Status: Proposed; implementation requires authorization and the gates below.
- Source review: `CYBERMASTERY_MODULARIZATION_ALIGNMENT_REVIEW.md`
- Relationship: Amendments and concrete boundary design for the supplied zero-patch T01-T14 plan; not a claim those tasks have executed.

## 1. Outcome and acceptance boundary

Encapsulate an **official, exact-commit OpenCode monorepo** as an unchanged dependency. CyberMastery owns the application shell, custom domain behavior, composition, extension contracts, migrations and integration code.

The mediation layer is an anti-corruption boundary: it translates explicit CyberMastery commands, queries, identities and policy into proven native APIs. It is not a reverse proxy presented as transactional integration, a duplicate Session engine, or a copied native implementation hidden behind renamed imports.

Two independent release records are mandatory:

1. **Source integrity:** which official native source, lockfiles, patches, exports and build inputs were consumed, and proof they were not modified.
2. **Behavioral divergence:** which services are delegated, extended, explicitly replaced or still blocked, with owners and parity evidence.

Large runtime replacements may satisfy source integrity while retaining substantial maintenance debt. Approval must consider both records.

## 2. Proposed ownership topology

All paths below are proposed, not existing extraction deliverables.

```text
OpencodeHarness/
  vendor/
    opencode/                     whole official monorepo at an approved gitlink
    superpowers/                  independently pinned skills
  apps/
    host/                         sole composition and startup authority
    web/                          CyberMastery routing and shell
    cli/                          custom launch and compatibility entrypoints
    desktop/                      packaging, preload and lifecycle adapters
  packages/
    contracts/                    browser-safe extension schemas and error DTOs
    domain/                       cohesive feature folders and their ports
    canvas/                       complete descriptors and runtime host
    session-ui/                   owned composer and injected session surfaces
    chat-relay/                   authorized application service and page worker
    adapters-opencode/            allowlisted native integration only
    client/                       extension-generated clients plus native facade
  migrations/                     extension migration definitions
  compat/
    baseline/                     source/data/route/feature/host ledgers
    upstream-capabilities.json     exact-pin capability proof records
    native-replacements.json      explicit maintained divergence
    imports.json                  allowed native imports and consumers
  tests/                          contracts, integration, parity, migration, integrity
```

Use distinct extension package names, for example `@cybermastery/contracts` and `@cybermastery/adapters-opencode`. Do not give an extension package the name of an upstream `@opencode-ai/*` package. Package-name or import-alias shadowing is not service substitution.

Keep the current deployment intact during proofs. The existing fork/Harness snapshot remains a labeled reference, never the hidden production dependency presented as official upstream.

## 3. Dependency rules

```text
web/canvas/session-ui -> extension contracts + client + injected browser services
feature domain       -> extension contracts + feature-owned ports
OpenCode adapter     -> feature ports + allowlisted native source exports
host composition     -> feature services + adapter wiring + proven native handlers
upstream             -> no CyberMastery imports
```

The host's native imports are limited to composition-only exports and recorded with the same rigor as adapter imports. Feature code must not acquire native SQL tables, Session service tags or app-private providers transitively through a utility package.

Maintain a coherent resolution graph for Core, Effect, schema identities, database service and tool registries. A single version string is insufficient: test real module paths, service construction counts, shared memoization and disposal. Also inspect the existing vendored client tarball resolution before defining the new client facade.

A static frontend descriptor supplies identity, display metadata, sizing constraints, contract version, runtime creation and view factory. The runtime host supplies scoped services and disposal. The backend capability/functionality manifest remains separate; advertising an ID does not authorize browser code loading.

## 4. Mediation contracts

These are proposed semantic contracts, not assumed native symbols. Avoid generic `execute(string, unknown)` dispatch and public transaction callbacks that leak native internals.

| Boundary | Required contract | Lifetime and authority |
| --- | --- | --- |
| `SessionCommands` | Create/adopt, admit, explicit resume and interrupt; preserve IDs, delivery, resume intent and typed conflicts | Process-level facade; one native Session/inbox authority |
| `SessionQueries` | Authorized session/history/pending-input/status reads and binding lookup | Same native graph; no secondary transcript projection |
| `PrivateAdmission` | Resolve policy, recognize exact retry, freeze immutable input, commit native admission and sidecar atomically, wake only after commit | Transaction orchestration inside adapter; actor and Location explicit |
| `ProviderContext` | Reconstruct from stored snapshot, preserve clean public projection and compaction continuation | Location-scoped provider-turn integration with stable Session/turn identity |
| `PrivateProjection` | Freeze/export, validate and atomically restore public events, sidecars, deletions and native epoch state | Same database/event authority; notifications and execution after outer commit |
| `BindingRepository` | Query/CAS functionality binding; pending/active guards; publish canonical invalidation after successful transition | CyberMastery-owned binding state; native Session references through queries |
| `LayoutRepository` | Authorized holder/revision transition and post-commit invalidation | Same host database; explicit corrected concurrency contract |
| `ContextCatalog` | CtxPack CRUD/search/pinning/usage and authorized immutable materialization | Actor/workspace scoped; SQL and FTS adapter hidden from feature code |
| `SkillCatalog` | Allowed/ask policy, hash-valid selection, server preview and role-specific source content | Location/agent scoped; no trusted client-supplied skill bodies |
| `TaskExecution` | Stable child IDs/model, settlement/error/interruption mapping and native ownership integration | Location-scoped execution; exclusivity contract must be proven |
| `BatchCapture` | Manifest/task identity, persisted model/results, partial retry, bounding and child archival | Existing CtxPack/native Session authority; no new scheduler implied |
| `WorkspaceRouting` | Local/remote resolution, readiness proof, target validation and bounded frozen transfer | Host-controlled authenticated topology |
| `EventFeed` | One browser connection per server connection context, canonical decoding, dedupe, reconnect and authoritative refresh | Multiplex native and extension delivery without duplicating native durable history |
| `DraftStore` / `SessionSurface` | Browser-local IDs/blobs/revisions; typed transport, permissions, attachments, queue/steer | Browser ownership; no native Core/Server runtime imports |

Every externally reachable command carries a verified actor/placement context or an explicitly trusted internal principal. Preserve current policy differences between entrypoints; do not invent multi-tenancy in a parity refactor. In particular, task-batch capture currently uses `local-user`; its mapping must be recorded rather than silently replaced or propagated as a universal principal.

CtxPack already has service-level capability checks. Preserve them after moving HTTP boundaries. Production composition must also demonstrate that real event publishers are installed: CtxPack's optional recording-event fallback must not silently become the extracted production event path.

## 5. Capability and replacement inventory

For each integration, record: official SHA, source symbol/export, consumer, lifecycle, actor/Location propagation, host coverage, delegate/extend/replace/blocked status, owned replacement files, acceptance tests and upgrade owner. Status remains `blocked` until the corresponding executable proof passes.

| Integration | Evidence now | Required next proof |
| --- | --- | --- |
| Source package consumption | Private workspace export maps exist | Install/build an external consumer without editing vendor manifests, catalogs, lockfile or source |
| Node replacement | Official `AppNodeBuilder.build(root, replacements)` exists | Replacement reaches both global and Location graph in every supported host |
| Local atomic event commit | Official `EventV2.publish` commit callback exists | Native admission call sites use it with extension sidecars, exact retry and rollback |
| Private admission ports | Present in fork; not present in official admission helper | Identify real replaceable service boundaries; do not cite fork-only ports as native APIs |
| Provider reconstruction/compaction | Fork changes internal translation and compaction functions | Narrow existing seam covers normal and compaction turns with immutable identity |
| Private replay | Fork adds `replayBatch`; official pin lacks it | Full rollback and notification isolation through an actual boundary, or reviewed replacement |
| Native epoch | Already upstream-owned; fork adds transfer access | Read/restore extension integration preserves one native epoch owner |
| Batch execution/capture | Fork-owned tool and subagent service exist | Register external tool and mediate child execution/capture without duplicate ownership |
| Closed route helpers | Both official and current helpers provide their own graph | Assemble lower-level handlers with a single selected graph; no ineffective outer override |
| Generated contracts | Custom methods currently live in native package outputs | Generate extension outputs and preserve route/event/error compatibility through a facade |

Do not infer an Event replacement merely from missing `replayBatch`: first test whether available transaction primitives and services can implement the contract safely. Conversely, do not mark a public-replay wrapper as sufficient before durable wake and nested-transaction tests pass.

## 6. Critical transaction and lifecycle sequences

### Admission

1. Resolve the authenticated actor, workspace, Location and immutable request identity.
2. Reconcile an existing exact retry before recall; conflict on changed identity inputs.
3. Resolve references server-side and freeze provider input outside the write transaction.
4. Revalidate mutable binding/profile/authority at commit.
5. Commit the native admission projection and required private snapshot in one transaction.
6. Expose acknowledgement/notifications only after commit; wake only when resume intent permits.

Apply this to the actual baseline entrypoint matrix, including direct child admission. Do not add post-crash provider retries under a durability label: persisted admitted-input recovery and reissuing provider work are different promises.

### Provider turns and compaction

Use stored snapshots and their renderer/content hashes, not current recall results. Keep one explicit stream delegation per provider turn; preserve native normal versus compaction request construction. A raw LLM decorator lacking stable Session/turn identity is insufficient.

If a significant runner replacement is necessary, review its responsibility/line surface and the upstream behavior it must track before proceeding beyond G1B. This is an architectural cost decision, not an implementation detail.

### Private restoration

Validate the frozen source identity, owner/workspace, event versions, manifest, deletion relations, sidecar hashes and epoch before exposure. Restore native events/projections and private data atomically. Hold external notifications, durable subscriber visibility and execution wake until the outer commit. Failure at any intermediate point must leave no partially visible projection.

Retain current transfer constraints: 512 KiB/page; 256 public events/page; 64 chunks/page; eight active transfers; 512 MiB/transfer; 1 GiB total spool; five-minute idle TTL; thirty-minute absolute TTL. Preserve authenticated readiness headers and unsupported move/removal behavior. Digests are integrity checks, not authorization.

### Layout concurrency

Correct the known read/check/write structure using one transaction and a conditional transition including revision and applicable authority. Claim/handover and save must obey one serialization design, with notifications after commit. Test through independently scheduled file-backed connections/processes.

Do not introduce an authority-expiry TTL without a separate behavior decision: the current `held_at` field does not implement one.

### Child execution

Inventory both the legacy task runner and V2 `task_batch` / `SubagentRunner`. Test a batch-started child racing with external resume/interrupt before finalizing the mediation implementation. A module-local batch mutex does not alone cover all Session entrypoints. Preserve established error/interruption/capture behavior and explicitly approve any ownership correction.

## 7. Revised T01-T14 execution plan

The original task numbering is retained for traceability. All new test paths are proposed deliverables. The plan should be executed in gated work packages, not as a blanket authorization to relocate the repository.

| Task | Required amendment / deliverable | Acceptance evidence |
| --- | --- | --- |
| T01: baseline | Use `d555e5aa7`, record its relationship to `b7c82166e`, account for 1,128 paths/147 commits; record committed stabilization, 43 Harness mode differences, exact lockfiles/gitlinks, task_batch capture and current host/default configurations. RepositoryCache is unchanged at this pin unless separate work is supplied. | Complete path/feature/route/schema/host ledger, hashes and modes; explicit disposition for every delta |
| T02: corrected contracts | Characterize the real canonical binding failure first; correct consumer matching in owned code. Separate characterization from later descriptor relocation. Reproduce layout interleavings with multiple connections; do not invent expiry semantics. | Producer/decoder/router regression, real two-client refresh, conditional layout transition and post-commit notification tests |
| T03: official consumption | Independent official checkout, package resolution experiment, import allowlist and construction/disposal instrumentation. Inventory fork-only admission ports, Event replay changes and module-evaluation defaults. | Pristine external install/build, shared runtime identities, before/during/after source attestation |
| T04: G1A host slice | External lower-level host composition, extension contract/client, one registered static card and same-database layout persistence. Do not wrap a closed helper and presume replacement. | Create/save/reconnect/restart/remove and two-client reload, one graph and unchanged vendor |
| T05: private admission proof | Include existing retries before recall, revalidation, changed attachment/version identity, resume:false and every baseline entrypoint, including children. Run an early representative fork-schema upgrade experiment. | Fault injection before/after commit; exact snapshots reused; complete-or-absent state; policy cannot be bypassed by native routes |
| T06: G1B reconstruction/replay | Treat native provider translation, compaction and missing replayBatch as explicit capability proofs. Test durable wakes as well as public events and nested transactions. | Frozen hashes match after restart/compaction/restore; failed restore rolls back without premature visibility; replacement inventory approved |
| T07: shell/Canvas/drafts | Full frontend descriptors replace split metadata/types/JSX switches. Use injected session surface/client/draft APIs. Preserve native screens exposed by the baseline, four render modes, scratchpad and FPS. | Source-independent web build; correct context-scoped event transport; identity/revision-safe drafts and disposal |
| T08: CtxPack | Preserve CRUD/pinning/search/usage and exact limits/error contracts; inventory lazy FTS and batch/worker result packs, not just user-created packs. Keep recall behind proven admission policy. | UTF-8 boundary, paging/order, materialization authorization, FTS upgrade and retry parity |
| T09: skills/relay | Preserve role-specific Superpowers content, hash policy, skill-load gating, text-only sends, files and local draft behavior; move handler and worker together behind explicit actor/page ownership. | Fake-page identity/upload/reconnect tests plus separately authorized real-browser/site smoke; no API substitution |
| T10: OperatingChat | Remove native tables/tags from the feature domain; cover HTTP, embedded and supported legacy paths, correct Location policy, pending delivery and interruption. | Public/private separation and single execution authority across the enumerated entrypoints |
| T11: MasterAgent/control plane | Preserve task_batch registration, manifest hashes, stable child IDs, persisted models/results, partial retry, bounding, archival, binding invalidation and private transfer. Characterize child direct-run/resume overlap. | Existing task-batch/subagent contracts plus cross-entrypoint exclusivity, readiness expiry and bounded-transfer tests |
| T12: migration/rollback | Complete the migration work started during T01/T05/T06: native vs extension journal, fork event decoders, sidecars, epochs, worker/batch packs, drafts/blobs and retained compatibility state. | Fresh/native-upgrade/fork-upgrade on copies, content/identity/hash equality and rehearsed full rollback |
| T13: supported hosts | Test combined host, custom CLI, SDK/embedded, desktop and TUI attachment as actually supported. Keep correct Solid/browser suite split; do not upgrade Bun to fix the earlier wrong invocation. | Windows and Linux results, authentication/SSE/PTY/native-screen/shutdown tests, explicit skip/block classifications |
| T14: production conversion | Only after earlier gates, replace production dependency topology with the approved official gitlink. Retain a separate historical baseline and rehearse an official-pin upgrade. | Source integrity, complete parity/migration matrix, measured replacements and successful rollback/upgrade drill |

### Sequencing and responsibilities

1. **Baseline and contract work:** T01-T03. Lead Engineer owns reproducibility and defect characterization; Lead Architect owns boundary/capability classification; Product Manager approves any changed behavior.
2. **Paired feasibility:** T04 and T05/T06 may proceed separately once package identities, transaction ownership and contracts are fixed. Each returns a demonstrable proof, not just a scaffold.
3. **Review checkpoint:** approve both G1A and G1B, including measured replacement burden. Do not start broad production extraction on G1A alone.
4. **Feature extraction:** T07-T09; T10-T11 integrate the proven native boundaries. Preserve the dependency chain for CtxPack-backed batch capture.
5. **Data/host acceptance:** complete T12-T13. Run one writer at a time during migration/rollback rehearsals.
6. **Production topology and upgrade:** T14/G5.

The first authorized implementation milestone should deliver the frozen baseline, corrected binding contract, official dependency consumption experiment and paired proofs. It should not promise full extraction or an effort estimate based on changed-file counts.

## 8. Migration and bootstrap design

- The host owns startup ordering: native bootstrap, extension migration validation/application, FTS readiness, capability checks, then listener/write activation.
- Keep native migration definitions and ledger semantics unchanged. Add an extension ledger in the same database; map already-applied custom fork migrations explicitly so extraction does not replay them.
- Keep native System Context/Context Epoch authority. Extension input/compaction sidecars and transfer metadata have explicit owners; table placement is selected only after proving transactional access and native decoder compatibility.
- Do not assume an extension side table is equivalent to the current native columns until every query, projection, history deletion and restore path is covered.
- Inventory fresh generated schema, upgrade migrations, legacy journal seeding and lazy FTS separately. Preserve historical runtime classifications, IDs, event versions and private-input hashes.
- Preserve browser IndexedDB formats and in-flight draft revision semantics. Keep relay profiles, retained compatibility records and application blobs in the migration/deployment inventory without treating them as a second Session datastore.
- Use copied/sanitized databases for all rehearsals. Define the matching application/data rollback point; source-only rollback is insufficient after incompatible data changes.

## 9. Build and release integrity

Keep the native source tree immutable while distinguishing it from allowed dependency/cache/output artifacts. Upstream-authored dependency patches are part of the pinned upstream build, not permission to add CyberMastery vendor patches.

The installation proof must specify exactly where dependencies, generated artifacts and native build outputs live. If the pinned scripts require forbidden source writes or unsupported nested workspace resolution, record a blocker or use an approved external build composition; do not silently rewrite vendor manifests or disable required install behavior.

Release gates should verify:

- Official repository provenance and exact gitlink; hashes and file modes, not only clean Git status.
- No native-module shadowing, temporary source rewrites or custom generation inside native clients.
- Allowlisted imports; actual module identity and lifecycle checks across all host entrypoints.
- Explicit replacement inventory with responsibilities, evidence and upgrade ownership.
- Correct decoded event/route/error contracts and separate extension-generated artifacts.
- One write/Session authority and preserved rollback guarantees.
- Selected later official-pin upgrade passing the same proof/parity matrix.

## 10. Definition of done and stop rule

Done means an unchanged official OpenCode dependency, a CyberMastery-owned host and shell, feature-facing ports without native leakage, all supported data/workflows preserved or explicitly corrected with approval, visible tested replacements, and a successful official-pin upgrade/rollback drill.

If atomic admission, provider reconstruction, compaction or private replay cannot be wired through existing upstream boundaries, **stop the full-parity release**. Record the exact missing interface and choose a reviewed explicit replacement, a later official capability or an approved semantic redesign. Do not count public-events-only replay, a fork-pinned gitlink, or reorganized directories as successful encapsulation.
