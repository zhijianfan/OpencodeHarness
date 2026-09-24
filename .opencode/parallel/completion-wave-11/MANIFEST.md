# G1B wave 11 — paged source and atomic receiver

Base checkpoint: f2ff727b93eeea0a729b3aa67743da3d2c84b95a (pushed, remote verified; pre-push 31/31). Full proof before this wave: 399 pass / 1 skip.

Model for both workers: opencode-go/deepseek-v4.1-flash, variant high. Self-contained briefs plus attached source snapshots; no worker commands/exploration. Master integrates and tests after BOTH workers return.

| Worker | Owned files under modular/packages/adapters-opencode | Acceptance |
| --- | --- | --- |
| 1 | src/transfer-source.ts; test/transfer-source.test.ts | Instance-local authenticated source snapshots, discovery, cursor binding, bounded pages/chunks and source-change checks |
| 2 | src/transfer-receiver.ts; test/transfer-receiver.test.ts | Scope-bound encrypted spool orchestration, atomic multi-aggregate restore and durable completion receipts |

Master-owned frozen wire/types: src/transfer-protocol.ts (attached identically to both workers). Existing spool/legacy projection and protocol files are read-only to workers. HTTP, readiness/admission wiring and transport integration tests follow this barrier; this wave alone does not complete G1B.

## Integration in progress

- Source worker: ses_f2dda0feeffezBn5CItkDdMI13, DeepSeek V4.1 Flash/high.
- Receiver worker: ses_f2dda0bd1ffeauqbpH0C7eC4AN, same model/high. First response exhausted 65536 reasoning tokens without edits; resumed with 131072 response cap and completed both owned files. Unavailable read attempt returned no source.
- Master corrected source request-fixture consistency, mutation assertions, cache-admission races, in-transaction placement revalidation, capability cursor checks and expiry-test scheduling. Source focused tests: 8 pass.
- Master hardened receiver request detachment, strict Created placement, authorization/expiry revalidation before durable receipt, orphan replay-owner checking, receipt cleanup retry and begin keepalive synchronization. Native claim does not create a sequence row; corrected the owner-rejection fixture accordingly.
- Focused source/receiver/spool/legacy-projection run before the keepalive correction: 69 pass / 0 fail. Full proof and subsequent integration still required.
