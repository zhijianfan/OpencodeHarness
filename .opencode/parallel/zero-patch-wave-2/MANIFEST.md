# Zero-patch wave 2: ordinary external host slice

Workers use fresh CLI sessions of `opencode-go/deepseek-v4.1-flash`, variant `max`, response cap 65536. The installed catalogue has no xhigh variant. Write-only briefs; master integrates only after both return.

| Worker | Owned files | Acceptance |
| --- | --- | --- |
| client | modular/packages/client/src/client.ts and client.test.ts | Typed extension client, authenticated calls, one abortable SSE subscription and correct authoritative read/claim distinction |
| web | modular/apps/web/src/main.tsx, i18n.ts, style.css | Independent Solid shell uses injected client and descriptor registry; static card save/reload/remove and one connection per context |

Master owns host composition, native storage, generated route manifest, package manifests and HTTP integration tests. This is a proof slice, not full feature parity. Native G1B remains blocked pending provider/compaction/replay integration.
