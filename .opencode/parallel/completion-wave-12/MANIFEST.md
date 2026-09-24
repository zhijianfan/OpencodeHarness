# G1B wave 12 — private transfer HTTP and readiness-gated admission

Model: opencode-go/deepseek-v4.1-flash/high. Response cap 131072 following the successful receiver resume in wave 11. Independent worker ownership, no commands/exploration, master integration/test after both return.

| Worker | Owned adapter files | Acceptance |
| --- | --- | --- |
| 1 | src/transfer-http.ts; test/transfer-http.test.ts | Authenticated bounded sync HTTP over borrowed source/receiver/readiness services, strict private negotiation and safe error mapping |
| 2 | src/admission.ts; src/session-facade.ts; src/session-runtime.ts; src/session-access.ts; src/session-http.ts; src/kernel.ts; src/legacy-projection.ts; src/event-boundary.ts; src/transfer-readiness.ts; test/readiness-admission.test.ts | Enrichment readiness gate, clean fallback without private metadata, immutable retries, permit lifetime through enclosing commit/rollback, trusted header proof plumbing |

Worker 2 is one connected admission/transaction change, not independent files suitable for separate writers. Worker 1 only consumes the existing readiness grant/revoke signatures, which remain unchanged. Application assembly, replay-owner provisioning and end-to-end source/receiver transport are master integration after this barrier.

Baseline full proof: 2026-09-24T07:12:11.191Z, 417 pass / 1 skip / 0 fail; adapter 350 pass. Wave 11 remains local on top of pushed f2ff727. G1B remains partial until full integration and outstanding acceptance are evidenced.
