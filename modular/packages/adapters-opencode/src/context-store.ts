import { Database } from "@opencode-ai/core/database/database"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { decodeCheckpoint, SENTINEL, type PrivateCheckpoint } from "./checkpoint"
import { enrichEntries, PrivateHistoryError, type HistoryEntry, type PrivateInput } from "./history"

export const readPrivateHistory = Effect.fn("CyberMastery.readPrivateHistory")(function* (
  sessionID: SessionSchema.ID,
  entries: readonly HistoryEntry[],
) {
  const database = yield* Database.Service
  const inputs = yield* database.db.all<{ message_id: string; api_content: string; api_content_hash: string }>(sql`
    SELECT message_id, api_content, api_content_hash FROM cm_private_input WHERE session_id = ${sessionID}`)
  const checkpoints = yield* database.db.all<{ message_id: string; context_json: string }>(sql`
    SELECT message_id, context_json FROM cm_private_checkpoint WHERE session_id = ${sessionID}`)
  const required = yield* database.db.all<{ message_id: string; kind: string }>(sql`
    SELECT message_id, kind FROM cm_private_requirement WHERE session_id = ${sessionID}`)
  const inputMap = new Map<string, PrivateInput>(inputs.map((row) => [row.message_id, { apiContent: row.api_content, apiContentHash: row.api_content_hash }]))
  const visible = new Map(entries.map((entry) => [entry.message.id as string, entry.message.type]))
  const checkpointMap = new Map<string, PrivateCheckpoint>(checkpoints
    .filter((row) => visible.has(row.message_id))
    .map((row) => [row.message_id, decodeCheckpoint(row.context_json, row.message_id)]))
  for (const requirement of required) {
    const type = visible.get(requirement.message_id)
    if (!type) continue
    if (requirement.kind === "input" && (type !== "user" || !inputMap.has(requirement.message_id))) throw new PrivateHistoryError(requirement.message_id)
    if (requirement.kind === "compaction" && (type !== "compaction" || !checkpointMap.has(requirement.message_id))) throw new PrivateHistoryError(requirement.message_id)
  }
  const requiredInputs = new Set(required.filter((row) => row.kind === "input").map((row) => row.message_id))
  return {
    entries: enrichEntries(entries, inputMap, checkpointMap, requiredInputs),
    private: entries.some((entry) => inputMap.has(entry.message.id) || checkpointMap.has(entry.message.id)),
    inputMap,
    checkpointMap,
  }
})

export const persistCheckpoint = Effect.fn("CyberMastery.persistCheckpoint")(function* (input: {
  readonly sessionID: SessionSchema.ID
  readonly messageID: SessionMessage.ID
  readonly seq: number
  readonly checkpoint: PrivateCheckpoint
}) {
  const database = yield* Database.Service
  const context = decodeCheckpoint(input.checkpoint, input.messageID)
  const row = yield* database.db.get<{ id: string }>(sql`SELECT id FROM session_message
    WHERE id = ${input.messageID} AND session_id = ${input.sessionID} AND seq = ${input.seq}
      AND type = 'compaction' AND json_extract(data, '$.summary') = ${SENTINEL}`)
  if (!row) return yield* Effect.die("Private checkpoint has no matching public compaction")
  yield* database.db.run(sql`INSERT INTO cm_private_checkpoint (message_id, session_id, context_json)
    VALUES (${input.messageID}, ${input.sessionID}, ${JSON.stringify(context)})`).pipe(Effect.orDie)
  yield* database.db.run(sql`INSERT INTO cm_private_requirement (message_id, session_id, kind)
    VALUES (${input.messageID}, ${input.sessionID}, 'compaction')`).pipe(Effect.orDie)
})
