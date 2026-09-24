# Worker 2 of 2 — extract the bounded encrypted transfer spool

Create ONLY these files in D:/OpencodeHarness:
- modular/packages/adapters-opencode/src/transfer-spool.ts
- modular/packages/adapters-opencode/test/transfer-spool.test.ts

Use the attached original custom spool and tests as the complete source/behavior specification. This is extraction of fork-added application code, not copying a native engine or importing the integrated fork. Astra High; no exploration, commands/tests, Git, delegation, shared configs, native edits or other file changes.

## Preserve the existing wire/API contract

Retain exported constants, SyncRecordKind/CompleteSyncRecord/ChunkSyncRecord/SyncPage types, error classes, SessionContextTransferSpool make/begin/append/finalize/complete/abort methods and canonical/digest/privateManifest/manifestDigest helper behavior from the source.

Limits: 512 KiB/page; 256 event/deletion records/page; 64 chunks/page; 8 active transfers; 512 MiB/transfer; 1 GiB total; 5-minute idle and 30-minute absolute TTL; 128 high-water aggregates; 64 KiB begin metadata. Retain AES-256-GCM per-transfer keys, nonce uniqueness/AAD, private on-disk permissions, key clearing and payload deletion. Preserve canonical Base64 chunks, ordering, high-water identity, begin/page idempotency and completion receipts.

IMPORTANT: spool canonicalization differs from BundleV1 payload canonicalization. The supplied spool uses Object.entries sorting with localeCompare and omits undefined object fields before JSON.stringify. Keep this exact helper behavior and known digest examples; do not substitute legacyCanonical merely because both are called canonical.

## Lifecycle ownership

Require an explicit dedicated root for the extracted application's constructor so no implicit shared user directory is swept. Callers own that directory; retain startup orphan cleanup within it. Add idempotent `dispose():Promise<void>` that stops new operations, waits for in-flight per-transfer operations, clears keys, removes owned active payloads and receipts. Do not delete the parent directory or unrelated outside paths. The master will supply a process-private root and register disposal with the host.

Check limits/TTL and finalize receipt bindings after waits, not only before asynchronous work, so concurrently appended pages cannot evade total accounting and expired transfers cannot be completed. A completion receipt must come from a successful finalize for that same frozen transfer; do not accept an arbitrary receipt string. A repeated finalize after completion must reconcile its expectedPageCount/manifestDigest rather than accepting conflicting parameters. These are explicit correctness fixes in the owned spool; preserve stable error tags.

Keep errors free of payload text. No fake encryption or unbounded in-memory replacement. Retain the original method-level behavior of deleting invalid/oversized partial spools and rejecting incomplete chunks.

## Tests

Port the supplied tests to the modular package using node:fs/promises mkdtemp, explicit temporary paths, and scoped disposal/cleanup. Add boundary tests for page/event/chunk counts, configurable total/transfer limits, absolute TTL, conflicting complete/finalize receipt binding, parallel append budget accounting, and disposal with active/in-flight operations. Real files/encryption; avoid mocks/globalThis. Do not use non-null assertions or unchecked JSON casts from the original tests; validate fixture data or guard missing values.

No test commands run by worker. Master will run `bun typecheck` and `bun test test/transfer-spool.test.ts --timeout 30000` from adapters-opencode after both workers return. Report exact behavior and any unresolved gaps.
