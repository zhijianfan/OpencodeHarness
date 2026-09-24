# Completion wave 6 — one-graph HTTP and native event adaptation

Prerequisites: wave-5 access/context/bundle modules typecheck and pass 45 focused tests. The master factored `makeSessionGraph`, added dependency-aware Session policy factories, and made layout persistence borrow an existing runtime. Actual official Server/Protocol package links are installed without vendor changes.

| Astra High worker | Exclusive files under modular/packages/adapters-opencode | Acceptance |
| --- | --- | --- |
| native-http | src/native-http.ts; test/native-http.test.ts | Lower-level native handlers use one selected graph; auth and shared identities; scoped disposal |
| session-http | src/session-http.ts; test/session-http.test.ts | Authenticated owned transport delegates SessionAccess, preserves native wire/cursors, handles contextAttachments and clean SSE |
| legacy-event | src/legacy-event.ts; test/legacy-event.test.ts | Explicit known fork-field extraction plus native codec validation, reversible lossless event conversion |

No overlap or shared-file edits. Workers get the current source snapshots and contracts. No worker commands/tests/exploration. Master integrates HTTP routing, extension persistence/migrations, event multiplexing and host lifecycle after all three return; workers do not open release gates.
