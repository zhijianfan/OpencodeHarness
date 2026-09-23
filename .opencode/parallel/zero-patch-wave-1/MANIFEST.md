# Zero-patch extraction: wave 1

Master: current orchestrator. Workers: fresh OpenCode CLI worker sessions, because this running harness's Task tool has no per-call model override.

Requested provider/model: OpenCode Go DeepSeek V4.1 Flash ExtraHigh. Observed catalogue variants are low/high/max; actual worker setting is `opencode-go/deepseek-v4.1-flash`, `max`. No xhigh variant is advertised.

| Worker | Brief | Exclusive ownership | Acceptance |
| --- | --- | --- | --- |
| contracts | tasks/contracts.md | modular/packages/contracts/src/layout.ts and layout.test.ts | Browser-safe layout contracts, strict decoding, unique IDs and immutable revision identity |
| canvas | tasks/canvas.md | modular/packages/canvas/src/registry.ts, event-router.ts, registry.test.ts, event-router.test.ts | Complete descriptor registry; scoped canonical invalidation, dedupe and disposal |
| provenance | tasks/provenance.md | modular/packages/compat/src/upstream.ts and upstream.test.ts | Exact pin/remote/object validation including tracked edits hidden by index flags |

Shared package manifests, native integration, baseline capture and host composition belong exclusively to the master. Workers receive pinned cross-task shapes verbatim. No master implementation while workers run. The master runs package-level validation only after all three return.

The official gitlink is `vendor/opencode` at `b02acc1e30ef55f7f181fec8d2f241d26f022683`. Native source is never editable. Current integrated packages stay available until the G1A/G1B and migration/parity gates pass.
