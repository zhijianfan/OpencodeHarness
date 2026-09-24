# Bounded source audit: production native host composition

User requires modularization through completion. Research the immutable official pin's hosting/composition APIs so the master can integrate the complete native surface into the selected external graph. This is a read-only evidence lane, separate from the write-only implementation workers.

Read/search only:
- D:/OpencodeHarness/vendor/opencode/packages/core/src/effect
- D:/OpencodeHarness/vendor/opencode/packages/core/src/location-services.ts and location-service-map.ts
- D:/OpencodeHarness/vendor/opencode/packages/core/src/tool and plugin (only composition/registration entrypoints)
- D:/OpencodeHarness/vendor/opencode/packages/server/src
- D:/OpencodeHarness/vendor/opencode/packages/protocol/src
- D:/OpencodeHarness/vendor/opencode/packages/cli/src/commands/handlers/serve.ts
- D:/OpencodeHarness/vendor/opencode/packages/sdk-next/src/opencode.ts
- package.json of those native packages
- D:/OpencodeHarness/modular/packages/adapters-opencode/src/session-runtime.ts, session-facade.ts, session-execution.ts, event-boundary.ts, kernel.ts
- D:/OpencodeHarness/modular/apps/host/src

Do not run commands/tests, alter implementation, or delegate. Write only D:/OpencodeHarness/compat/inventory/native-host.md.

Find and report with exact file:line evidence and exported signatures:
1. Can native HTTP handlers be assembled with an externally chosen AppNodeBuilder graph without the closed helper providing a second graph? Which exact lower-level exports are needed and which are not exported?
2. How is the complete native Location graph/builtin tool and plugin registration assembled? Does the current modular createSessionRuntime include the native default builtins and permissions/questions, or only dependencies selected by its limited roots? Identify the smallest correct production root/composition path and required default dependencies.
3. How does request authentication and Session Location middleware propagate user/placement? Identify a supported layer/middleware boundary for providing PrivatePromptContext without changing native source, plus where native protocol decoding drops fork-specific contextAttachments.
4. Native combined-host/CLI/embedded entrypoints and SSE multiplexing exports; what remains inaccessible without an explicit owned adapter?

Do not prescribe broad copying or patching native modules. Explicit maintained replacements are allowed only when necessary and inventoried. One Database/Event/SessionStore/SessionExecution graph is mandatory. The output should be actionable source evidence, not a generic architecture essay: ~1800 words maximum plus compact signature snippets. Mark any uncertain inference; the master will verify decisive source excerpts before coding.
