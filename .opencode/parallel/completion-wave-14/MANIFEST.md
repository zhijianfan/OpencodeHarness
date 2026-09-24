# G1B wave 14 — local deletion export and transfer client

Full-proof baseline: 456 pass / 1 skip, adapter389, 2026-09-24T08:32:44.783Z. Model opencode-go/deepseek-v4.1-flash/high, 131072 response cap. Master integrates after BOTH workers return.

| Worker | Owned adapter files | Acceptance |
| --- | --- | --- |
| 1 | src/legacy-deletion.ts; src/legacy-projection.ts; test/local-revert-transfer.test.ts | Actual native local revert exports valid private deletion proofs for admitted/promoted inputs and checkpoints, including subsequent restore |
| 2 | src/transfer-client.ts; src/transfer-protocol.ts; src/transfer-source.ts; test/transfer-client.test.ts | Reusable authenticated source-to-receiver transport/peer adapter, bounded validation/cancellation and completed-snapshot cache lifecycle |

Existing public source/receiver/history/replay shapes remain stable. Protocol may gain exported response SCHEMAS without changing wire fields. Application/replay/child admission signatures are read-only to both. No commands/exploration by workers; no vendor/fork runtime imports. Scope remains G1B, not full product extraction/migration.
