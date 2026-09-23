# Wave 3: private-context support

Workers: fresh `opencode-go/deepseek-v4.1-flash` CLI sessions, `max` effort (catalog has no xhigh), 65536 output cap. Master is the orchestrator and integration owner.

| Worker | Exclusive files | Acceptance |
| --- | --- | --- |
| checkpoint | modular/packages/adapters-opencode/src/checkpoint.ts; test/checkpoint.test.ts | Exact existing v1 private checkpoint format/hash/size/sentinel; corrupt values fail closed |
| history | modular/packages/adapters-opencode/src/history.ts; test/history.test.ts | Immutable private history projection and enriched-token selection; no public input mutation, missing/corrupt context fails |

The master owns Event service decoration, private projection transaction integration, native node wiring, compaction integration and all shared manifests. No native source edits. Workers receive complete cross-task contracts below; master integrates and tests only after both return.
