# Checkpoint worker

Implement only these new files in D:/OpencodeHarness:
- modular/packages/adapters-opencode/src/checkpoint.ts
- modular/packages/adapters-opencode/test/checkpoint.test.ts

No reading/exploration/commands/test execution. Use the available write tool. All context below. Bun 1.3.14, TypeScript. No any/star/aliased imports. Master validates after all workers finish. Do not edit vendor, manifests, or other files.

This preserves an existing CyberMastery-owned data format outside native source, not a new format.

Export exactly:
const SENTINEL = "[Private model context checkpoint v1]"
type PrivateCheckpoint = { readonly version:1; readonly rendererVersion:1; readonly summary:string; readonly recent:string; readonly contentHash:string; readonly byteLength:number; readonly estimatedTokens:number; readonly createdAt:number }
class CorruptCheckpoint extends Error { readonly messageID:string; constructor(messageID:string) }
function makeCheckpoint(input:{readonly summary:string;readonly recent:string;readonly createdAt:number}):PrivateCheckpoint
function decodeCheckpoint(value:unknown,messageID:string):PrivateCheckpoint

Canonical bytes: UTF8 of JSON.stringify({version:1,rendererVersion:1,summary:input.summary,recent:input.recent}) in that exact property order. contentHash is node:crypto createHash("sha256").update(canonical).digest("hex"). byteLength is TextEncoder UTF8 byte length, estimatedTokens=Math.ceil(byteLength/4). createdAt is a nonnegative safe integer timestamp, excluded from canonical content hash. makeCheckpoint rejects invalid arguments with CorruptCheckpoint("new") or a clear TypeError (choose and test). Do not trim/change summary/recent.

decodeCheckpoint accepts either JSON string or an object. Exact eight fields only, no missing/extra fields, no array/null; versions exactly1; summary/recent strings; counters/timestamp nonnegative safe integers. Recompute hash, bytes, tokens and require exact equality; wrong hash or counters fail. Return a fresh validated record. Invalid input throws CorruptCheckpoint with only messageID-based message (never include private text or raw JSON). Do not ignore corruption or rematerialize live input.

Tests use bun:test named imports and actual exported implementation. Cover Unicode/multibyte canonical byte length, hash deterministic roundtrip, createdAt excluded from hash, version/extra/missing fields, array/null, malformed JSON, tampered summary/hash/counters, negative/fractional timestamp, result mutation isolation, no private string in error message. Use real createHash independently for known canonical-string expected fixture, not a copy of decoder logic.

Return files and uncertainty. Emit implementation rather than long speculation; the master has already decided the format.
