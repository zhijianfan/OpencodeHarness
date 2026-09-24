# G1B wave 13 — acceptance and offline upgrade proof

Base pushed commit f2ff727; waves 11–12 local. Full proof before wave: 440 pass / 1 skip, 2026-09-24T07:40:05.688Z. Use opencode-go/deepseek-v4.1-flash/high with 131072 response cap.

| Worker | Owned adapter files | Acceptance |
| --- | --- | --- |
| 1 | test/application-transfer.test.ts | Real HTTP source/receiver, paged private/clean transfer, restart receipt and retry, no provider wake/leak |
| 2 | src/transfer-receiver.ts; test/transfer-receiver.test.ts | Scoped spool identity, bounded lifecycle metadata, cancellation cleanup and expiry/receipt integrity |
| 3 | src/fork-session-copy.ts; test/fork-session-copy.test.ts | Digest-bound read-only copied-fork Session upgrade experiment through the real native/legacy restore boundary |

All public source/receiver/application signatures are frozen. Worker 2 cannot change the wire/constructor shape; worker 1 consumes it without inspecting concurrent edits. Worker 3 owns only an offline copy importer/proof, not the complete product-data migration. No commands/exploration/tests by workers. Master reviews/integrates/tests after ALL THREE return. Do not upgrade G1B or migration gates merely because these lanes return.
