# Completion wave 8 — new-admission compatibility and bounded transfer spool

Worker model: openai/gpt-6-astra / high. Both tasks have complete source snapshots and disjoint ownership. No worker commands, tests, exploration, shared configuration or vendor changes. Master waits for both, then integrates and validates.

| Lane | Owned adapter files | Acceptance |
| --- | --- | --- |
| input-compatibility | src/context-renderer.ts; src/admission.ts; src/session-facade.ts; src/legacy-projection.ts; test/context-renderer.test.ts; test/input-compatibility.test.ts | Newly admitted real contexts retain complete legacy snapshots, renderer1/2 hashes, atomic compatibility metadata and immutable retries/export |
| transfer-spool | src/transfer-spool.ts; test/transfer-spool.test.ts | Extract the existing custom encrypted bounded spool/wire helpers with its limits, identity, TTL and retry behavior; explicit owned lifecycle |

The master owns bootstrap registration, readiness leases, final restore/receipt orchestration and HTTP routes. These tasks do not close the complete transfer or feature gates by themselves.
