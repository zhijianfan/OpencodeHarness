# Private history worker

Implement only these new files in D:/OpencodeHarness:
- modular/packages/adapters-opencode/src/history.ts
- modular/packages/adapters-opencode/test/history.test.ts

No reading/exploration/commands/test execution. Use write tool. No any/star/aliased imports. All context follows. Master tests after barrier. No vendor/shared config edits.

Available imports:
- import { SessionMessage } from "@opencode-ai/schema/session-message" (namespace schemas/types).
- import { Token } from "@opencode-ai/core/util/token" with Token.estimate(text:string):number.
- import { SessionCompaction } from "@opencode-ai/core/session/compaction" with serializeToolContent(content):string (use this exported helper for completed tool content).
- import { createHash } from "node:crypto".
- import { SENTINEL, decodeCheckpoint, type PrivateCheckpoint } from "./checkpoint".

PINNED cross-task checkpoint contract:
SENTINEL="[Private model context checkpoint v1]".
PrivateCheckpoint={readonly version:1;readonly rendererVersion:1;readonly summary:string;readonly recent:string;readonly contentHash:string;readonly byteLength:number;readonly estimatedTokens:number;readonly createdAt:number}.
decodeCheckpoint(value:unknown,messageID:string):PrivateCheckpoint checks exact v1 format/hash/UTF8 sizes and throws on corruption.

Required exports:
type HistoryEntry={readonly seq:number;readonly message:SessionMessage.Message}
type PrivateInput={readonly apiContent:string;readonly apiContentHash:string}
class PrivateHistoryError extends Error {readonly messageID:string;constructor(messageID:string)}
function enrichEntries(entries:readonly HistoryEntry[],inputs:ReadonlyMap<string,PrivateInput>,checkpoints:ReadonlyMap<string,PrivateCheckpoint>,requiredInputs:ReadonlySet<string>=new Set()):readonly HistoryEntry[]
function serializeEntry(message:SessionMessage.Message):string
function splitEntries(entries:readonly HistoryEntry[],keepTokens:number):{readonly head:readonly HistoryEntry[];readonly recent:readonly HistoryEntry[]}|undefined
function renderEntries(entries:readonly HistoryEntry[]):string

Rules for enrichEntries:
- Never modify input objects/arrays. Keep seq and message metadata/time/files unchanged. For user messages with a private input, verify sha256(apiContent)===apiContentHash then return copy with text=apiContent. If a visible user ID is in requiredInputs but absent from inputs, fail with PrivateHistoryError(id), do not use clean text fallback.
- A private checkpoint for a visible compaction must correspond to message.summary===SENTINEL; validate it with decodeCheckpoint then replace summary/recent only in returned copy. Sentinel without checkpoint or checkpoint attached to non-sentinel compaction fails. Private input keyed to a visible non-user message or checkpoint keyed to a visible non-compaction fails. Ignore map entries for messages not in the selected history (older compacted records may exist).
- Error messages must never contain private content.

Existing private-context compaction transcript FORMAT (preserve these strings exactly; this is owned format compatibility):
- user -> [`[User]: ${message.text}`, ...optional files mapped `[Attached ${file.mime}: ${file.name ?? file.uri}]`].join("\n")
- assistant content parts: text -> `[Assistant]: ${text}`; reasoning -> text truthy ? `[Assistant reasoning]: ${text}` : omitted; tool -> `[Assistant tool call]: ${name}(${input})` where input is raw string or JSON.stringify(state.input). completed adds newline + `[Tool result]: ${truncate(SessionCompaction.serializeToolContent(state.content))}`; error adds newline + `[Tool error]: ${state.error.message}`; pending/running just call line. Join parts with newline.
- system -> `[System update]: ${message.text}`
- synthetic -> `[Synthetic context]: ${message.text}`
- shell -> `[Shell]: ${message.command}\n${truncate(message.output)}`
- other variants (compaction, agent/model switch) -> "".
truncate(text) preserves <=2000 characters; otherwise text.slice(0,2000)+"\n[truncated]".
renderEntries serializes, drops empty strings, joins with double newline.
splitEntries: validate keepTokens finite >=0, remove compaction and any entries with empty serialization, return undefined if nothing remains; scan from last entry, summing native Token.estimate(serialized text), keep a suffix while next total <= budget. Return prefix/head and suffix/recent in original order. Entries supplied here may already be enriched. Do not recall anything or perform provider calls.

Useful native schema construction for tests: SessionMessage.ID.make("msg_test"), SessionMessage.User.make({id:...,type:"user",text:"clean",time:{created:DateTime.makeUnsafe(0)}}) with DateTime imported from effect. Compaction schema can be constructed as a typed object with {id,type:"compaction",summary:SENTINEL,recent:"clean recent",time:{created:DateTime.makeUnsafe(0)},reason:"auto"}; if uncertain required fields, restrict test to Schema.decodeUnknownSync(SessionMessage.Message) on encoded timestamp0 to validate the real shape rather than casting any. Both underlying schema and namespace are already installed by master via exact official-source package links.

Tests: clean/enriched user projection with unchanged original, hash mismatch, required missing input, sentinel restore, missing/corrupt checkpoint, wrong-kind private mapping, metadata/attachments preserved, selection budget based on enriched text rather than clean text, zero-budget/full-budget ordering, exclusion of switch/compaction entries. Check real implementation; no global mocks. Your sibling implements checkpoint schema; do not create it.
