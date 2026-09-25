# Worker1 of2 — CtxPack content and validation

Use opencode-go/deepseek-v4.1-flash/high. Own ONLY modular/packages/domain/src/ctxpack-content.ts and ctxpack-content.test.ts in D:/OpencodeHarness. Attached sources are complete context. No exploration, commands/tests, Git, delegation or edits elsewhere. Produce code promptly and return uncertainties, no test-pass claims.

This domain package uses plain TypeScript/Promise ports and browser-safe contract types, not Effect/native runtime imports. Import DTOs from @cybermastery/contracts/ctxpack (attached master file); do not edit that contract. Node crypto is allowed in this server-side content module; never import the integrated fork schema/runtime or vendor Core. All emitted CtxPack errors retain the attached contract's _tag+field shapes and never include fragment text.

## Frozen exports (worker2 consumes exactly these)

- normalizeSelectedText(value:string):string
- normalizeKeyword(value:string):string
- utf8ByteLength(value:string):number
- estimateTokens(bytes:number):number
- contentHash(fragments:readonly {readonly ordinal:number;readonly text:string;readonly source:CtxPackSource}[]):string
- normalizeCreate(input:unknown):CtxPackCreateRequest & {readonly tags:readonly CtxPackTag[]}
- normalizePatch(input:unknown,sources:readonly CtxPackSource[]):CtxPackPatchRequest
- normalizeList(input:unknown):CtxPackListRequest
- isCtxPackError(input:unknown):input is CtxPackError
- buildFtsQuery(query:string):string|null
- buildRecallTerms(text:string):readonly string[]
- isTrivialRecallTurn(text:string):boolean
- LIMITS with titleMaxCodePoints120,keywordMaxCount12,keywordMaxCodePoints48,fragmentMinCount1,fragmentMaxCount32,fragmentMaxBytes16384,totalMaxBytes65536,totalMaxEstimatedTokens16384,listLimitMin1,listLimitMax50,queryMaxCodePoints256.

These are synchronous functions, no Effects. Validation throws actual CtxPackError-shaped values. normalizeCreate/Patch/List deeply detach caller data; never mutate input. Validate unknown input structural types using plain TypeScript guards like existing layout contract; no any/casts hiding types. Strictly reject unsupported fields rather than silently losing data. Identifier fields retain bytes (nonempty workspace/idempotency/clientFragmentID); ctxPackID prefix ctxpk_; source blockID/functionalityID/labels may be empty strings as baseline schema allows. Source metadata is primitive JSON string/finite-number/boolean/null; timestamps/revisions safe nonnegative integers. Reject secret/unknown source sensitivity with CtxPackSecretSourceDenied and mismatched source workspace with CtxPackCrossWorkspaceDenied.

## Preserve exact baseline semantics

Attached ctxpack.ts/validation.ts/hash.ts/search.ts/recall.ts are authoritative behavior references, not imports. Selected text normalizes CRLF/CR to LF, trims trailing spaces/tabs per line, then trims ends (NO NFKC on fragment text). Keywords NFKC/trim/collapse whitespace; case-insensitive dedup preserves first display spelling. Titles trim, count Unicode code points not UTF16 units. Tags only ParallelPlan, stable dedup.

Oversized fragments split into <=16KiB chunks at Unicode code-point boundaries, preserve source metadata, and append :1,:2... to clientFragmentID only if split. Check total normalized text bytes/tokens and both pre/post-split fragment count<=32. A pack cannot be less sensitive than any fragment. Patch may change metadata only, including tags; cannot weaken below actual fragment sensitivity. Never rewrite fragment content/hash for metadata changes. List limit1..50, raw query<=256 code points and exact enum/nullable field shapes. Return raw query; repository will apply buildFtsQuery.

contentHash EXACTLY sha256: + SHA256(JSON.stringify(fragments.map(f=>({ordinal:f.ordinal,text:normalizeSelectedText(f.text),source:recursiveKeySortedSource(f.source)})))). Source keys sorted into objects before JSON.stringify, arrays ordered, integer-like keys follow JS enumeration. Do not use the spool's localeCompare canonicalization or add title/keywords/tags/revision. Bytes UTF8, tokens ceil(bytes/4). Repo sums per-fragment estimatedTokens (distinct from total-budget check).

FTS query preserves baseline whitespace-token quoted AND phrases and escaping, null for punctuation-only. Recall terms preserve exact NFKC/lowercase Unicode letter/number regex, stop words, stable dedup max8, trivial-turn punctuation handling from attached recall.ts. No SQL/search/database implementation in this lane.

## Tests

Meaningful boundary tests: 16KiB/64KiB edges with multibyte/astral text, 32-fragment split limit, normalized text vs keyword differences, source metadata hash key ordering including integer-like keys, independently computed golden hash, hash unchanged by metadata changes, source-sensitivity/workspace rejection, DTO errors with no private text, snapshot detachment, all sorts/list bounds, quoted FTS injection syntax, recall stop/trivial/Unicode/max8. Use actual helpers; no copied implementation as expected results. Master runs package typecheck/tests and full proof.
