# T08 wave19 — authenticated catalog transport

Base e5d66cd, subsequent waves16–18 local. Catalog/capsule/materializer/admitted-use all use the selected native DB/EventBoundary; a direct app integration test has passed. One bounded worker on opencode-go/deepseek-v4.1-flash/high (131072 cap) owns ONLY new src/ctxpack-http.ts and test/ctxpack-http.test.ts. Master binds the borrowed transport into application.ts after worker returns. No generated native outputs/API changes; route is custom owned extension. T08/G2 remains in progress.

Outcome: HTTP session ses_f2c7ee117ffeWhOEDksl3ow4D3. Master corrected root trailing-slash route and empty-JSON excess-field decoding; 13 HTTP tests passed. Bound borrowed catalog/materializer to application HTTP (shared selected graph) and verified authenticated HTTP materialization followed by private Session prompt and one usage count. Full proof 607 / 1 skip / 0 fail at 2026-09-24T13:13:28.187Z; native source attestation/typechecks/build/browser pass.
