# T08 wave16 — CtxPack catalog extraction

Pushed G1B checkpoint: e5d66cdb76d5fcc2e2dc3cea7614d568b2fcd85b; remote main verified, pre-push31/31. Baseline proof486/1skip. G1B passed; this begins feature extraction, not completion of G2/T08.

Model for both lanes: opencode-go/deepseek-v4.1-flash/high, response cap131072. No worker exploration/commands or shared-file edits; master integrates/tests after BOTH return.

| Worker | Owned files | Task |
| --- | --- | --- |
| 1 | modular/packages/domain/src/ctxpack-content.ts; ctxpack-content.test.ts | Pure structural/semantic validation, exact content/provenance hashes, UTF-8 slicing and search/recall terms |
| 2 | modular/packages/adapters-opencode/src/ctxpack-catalog.ts; test/ctxpack-catalog.test.ts | Same-native-database catalog: authorized CRUD, creator-private filtering, FTS, per-user pins, CAS and commit-safe events |

Master owns browser-safe contracts/src/ctxpack.ts and package exports/check commands. Both lanes receive identical frozen helper signatures. Materialization/capsules, recall assembly, usage-admission integration, HTTP/client/UI and copied CtxPack table migration follow the catalog barrier. Original tables/features remain retained until migrated and accepted.

## Outcome

- Content session: ses_f2cf973d2ffeV7otjs7kD6HJmh. Catalog session: ses_f2cf9733cffetyltb1SwLBX6C8. Both exports confirm the selected model/high and only owned successful file edits; invalid tool attempts returned no source.
- Master corrected create commit reauthorization, mutable caller inputs/actors, synchronous publisher timing, error redaction, numeric cursor and FTS-order details. Added reachable post-split33-fragment rejection, all-sort paging and a true two-runtime concurrent revision attempt.
- Full proof **554 pass / 1 skip / 0 fail**, 2026-09-24T11:07:47.975Z; domain51/catalog17 new tests, adapter436; eight typechecks/build/browser and unchanged native source passed. Domain tests now run in verify:proof. T08/G2 remains in progress.
