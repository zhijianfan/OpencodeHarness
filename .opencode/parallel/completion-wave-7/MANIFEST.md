# Completion wave 7 — integrated host and transactional legacy restoration

Wave 6's HTTP/event modules and shared-graph changes pass adapter typecheck and 51 focused/regression tests. This wave uses two independent Astra High coding lanes; all tests/integration wait for both results.

| Lane | Exclusive files | Acceptance |
| --- | --- | --- |
| application | modular/packages/adapters-opencode/src/application.ts; test/application.test.ts in that package; modular/apps/host/src/app.ts | Static layout, authorized Session ingress and native HTTP share one graph and lifecycle; no raw Session fallback bypass |
| legacy-projection | modular/packages/adapters-opencode/src/legacy-projection.ts; test/legacy-projection.test.ts in that package | Authorized, digest-checked native replay plus original fork events/private snapshots/checkpoints/epoch committed atomically, immutable retries and rollback |

Master owns exports/allowlists/bootstrap registration, legacy admission retry recognition, renderer-v2 acceptance, feature extraction and all gate/evidence updates. No worker edits existing shared adapters or vendor. New application factory import may use its relative source until the master adds the package export after the barrier.
