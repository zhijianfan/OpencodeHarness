# G1B integration decision: bounded service decoration

Date: 2026-09-23. Scope: continued implementation; upstream pin unchanged.

## Event boundary

Use the official exported `EventV2.layerWith({ beforeAggregateRead })` behind one external Event-service facade. Delegate durable storage, sequence/owner reconciliation and projectors to the official implementation. The facade owns only transaction scope, public notification buffering and a read barrier for native durable subscriptions.

An outer transaction must hold the read barrier until commit/rollback. Public `listen`, `all` and typed `subscribe` observe facade delivery, never the raw bus. Mutation callbacks inside a transaction join the explicit fiber-local batch scope. Failed batches discard buffered hints. Successful batches deliver after the SQL transaction completes. Native durable subscriptions retain native history selection/decoding but cannot read while a managed restore is incomplete.

This is an explicit native Event-service replacement, not an unchanged-native-behavior claim. No Event implementation is copied and no native import is redirected to modified source. Tests must cover ordinary publication, failure after a replay prefix, sidecar failure, exact duplicate replay, durable observers, reentrant listeners and disposal. Direct outer database transactions around facade operations remain unsupported unless they use this boundary's transaction API; the boundary must fail closed when that misuse can be detected.

## Private-context format and provider integration

Preserve the existing private checkpoint v1 sentinel, canonical content hash and UTF-8 accounting. Project enriched history only in adapter-owned model context; stored public messages remain clean. Keep compaction selection based on enriched input and public recent text based on the same selected entry IDs.

Normal request decoration alone is insufficient because native automatic compaction reads history and checks limits before invoking the LLM service. The integration must demonstrate both normal and compaction paths; standalone projection helpers do not close G1B. Avoid copying the native SessionRunner; prefer explicit service composition/decorators and exported native helpers. Any remaining larger replacement requires a separate measured decision.

## Release condition

The new Event boundary can resolve one specific blocker, but G1B remains partial until private reconstruction, compaction, all supported admission paths, full bundle/epoch/deletion restore and notification visibility are covered. Existing integrated code is retained until the full gates pass.

## 2026-09-24 milestone result

Those bounded T05/T06 mechanisms now have executed evidence and a passing independent follow-up review: **486 pass / 1 platform skip / 0 fail**, source unchanged. See `G1B_ACCEPTANCE.md`, `OWNED_RUNNER_DECISION.md` (including the explicit fork-child replacement and measured ownership surface), and `../modular/G1B_REVIEW.md`. G1B feasibility is passed; full feature/host/product migration and production release remain separate blocked gates. Integrated code remains retained.
