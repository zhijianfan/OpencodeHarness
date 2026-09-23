# CyberMastery isolated modular proof workspace

This is an executable frontend/backend/persistence slice around official OpenCode. It is **not a full replacement** for the integrated application. Full-parity startup deliberately fails until the native-context, migration and host gates pass. See `../compat/gates.json`.

## Implemented

- `apps/web`: standalone Solid shell with a descriptor-driven static card, local edit revision protection, one event connection per client context, and logical CSS for LTR/RTL.
- `apps/host`: authenticated one-origin proof host and static assets; selects one native database/Event/projector graph through the adapter.
- `packages/contracts`: browser-safe layout DTO validation and extension HTTP route manifest.
- `packages/client`: typed client facade with extension-generated route bindings and abortable SSE.
- `packages/domain`: layout authorization/catalog policy behind a repository port.
- `packages/adapters-opencode`: official-source package integration, extension layout storage/CAS, independent migration ledger, private admission facade, managed Event transactions, private history/compaction adapters and full-snapshot proof transport.
- `packages/canvas`: descriptor registry and scoped event router.
- `packages/compat`: official pin/content attestation including edits hidden by index flags.

Native source is `../vendor/opencode` at `b02acc1e30ef55f7f181fec8d2f241d26f022683`. This workspace never imports the old root `packages/core` or `packages/server`. Native dependencies are installed in their unchanged native workspace. `script/link-native.ts` creates explicit local package links to those actual source packages and their exact dependency instances; it does not map native imports to custom implementations. No global `bun link` registry is required.

The existing integrated application remains at the repository root. That placement is temporary pending the gates, not a claimed production topology conversion.

## Setup

From the repository root initialize `vendor/opencode` and `vendor/superpowers` with `git submodule update --init`.

From `vendor/opencode`:

```text
bun install --frozen-lockfile
```

From `modular`:

```text
bun install --frozen-lockfile
bun run link:native
bun run attest:native
```

From `modular/packages/client`, run `bun run generate`. Generated files belong only to this extension workspace; do not generate changes inside native clients.

## Run the proof

Build from `modular/apps/web` with `bun run build`.

In PowerShell, choose a disposable database path and token, then run from `modular/apps/host`:

```powershell
$env:CYBERMASTERY_PROOF_DB = "$env:TEMP\cybermastery-static-card-proof.db"
$env:CYBERMASTERY_PROOF_TOKEN = "choose-a-local-proof-token"
bun run start --proof
```

Open `http://127.0.0.1:3174` and enter the token. Use `?dir=rtl` for an English/RTL check. The proof has a fixed grid, not the complete production canvas or session blocks. Explicit Reload acquires layout authority; event-triggered refresh does not.

Running full mode instead of `--proof` raises `FullParityUnavailable`; it does not silently downgrade private context or route to the old fork.

## Verification

Run `bun typecheck` from each affected package directory. Run `bun test src` in contracts, canvas, client and compat; `bun test test` in adapters-opencode and apps/host. Tests never run from the repository root.

From `apps/web`, `bun run test:smoke` drives the built shell in two real browser contexts. Playwright runs in a Node subprocess, with the proof host still on Bun. Windows uses installed Edge; other systems require Playwright Chromium. English LTR and forced RTL are covered; real RTL locale/native desktop parity is not claimed.

The compatibility suite has a POSIX-only symlink test skipped on Windows. The actual official Windows checkout is separately attested, including its link-text files. Before/after attestation does not establish protection from unobserved temporary rewrites; read-only build packaging remains a release requirement.

## Native-context finding

The native-boundary tests prove local atomic admission/sidecar commit, exact retry without repeated recall, rollback on sidecar failure and resume intent through the explicit external facade. The managed Event boundary also defers an enclosing transaction's execution wake until commit. These do not intercept every stock `SessionV2.prompt` entrypoint.

They also characterize two failing full-parity strategies:

1. Stock `EventV2.replayAll` commits a public prefix before a later failure.
2. A naive outer transaction rolls rows back, but a native replay notification has already escaped.

`event-boundary.ts` now resolves those two timing failures through an explicit replacement: upstream still owns storage/projectors, while the facade buffers public hints and fences native durable readers until the managed outer transaction completes. Nested savepoint rollback discards only its own hints/actions. Unmanaged outer SQL transactions and writes escaping the owning fiber/kernel fail closed.

`projection.ts` atomically restores input sidecars, checkpoints and the native epoch in the new explicit proof format. It checks an independently supplied expected digest, authorization, placement, relations and immutable duplicates. Native revert deletion cleans up extension records. This is not the original fork's paged BundleV1 protocol: lossy native codec decoding is rejected and migration compatibility remains pending.

`provider-context.ts` reconstructs immutable private request messages, and `compaction.ts` exercises the real native compactor with enriched history while atomically storing a clean public checkpoint plus private summary/recent text. `runner.ts` now supplies explicit owned orchestration at the Location-scoped SessionRunner boundary. `session-facade.ts` delegates the native Session constructor and normalization while adding private admission/guard behavior. `createSessionRuntime` wires both into the native Location map and execution coordinator, with object-identity checks for shared services.

The core integration kernel is exported as `@cybermastery/adapters-opencode/session-runtime`; managed callers provide `PrivatePromptContext` from `./session-context`. The static-card HTTP host is still a proof host, not an assertion that every native/legacy endpoint has been migrated. See `../compat/OWNED_RUNNER_DECISION.md` for the replacement responsibility and outstanding conformance matrix.

Current-fork data migration and all supported CLI/desktop/embedded/TUI workflows remain pending. **Do not remove the integrated source based on this proof.**

## Worker provenance

Seven independent implementation workers across three waves used `opencode-go/deepseek-v4.1-flash`, variant `max`, via fresh OpenCode CLI sessions. The catalogue did not advertise the requested ExtraHigh/xhigh variant; max was the highest supported effort. The master supplied self-contained, file-owned briefs, reviewed outputs and ran all validation after worker barriers. Manifests are in `.opencode/parallel/zero-patch-wave-*` at the repository root.
