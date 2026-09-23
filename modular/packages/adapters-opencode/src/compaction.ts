import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { DateTime, Effect, Schema } from "effect"
import { SENTINEL, makeCheckpoint } from "./checkpoint"
import { persistCheckpoint } from "./context-store"
import { renderEntries, splitEntries } from "./history"
import { preparePrivateTurn } from "./provider-context"

type Dependencies = Parameters<typeof SessionCompaction.make>[0]
type Input = Parameters<ReturnType<typeof SessionCompaction.make>["compactIfNeeded"]>[0]

/**
 * Delegate provider call, prompt template, limits and failure handling to the
 * native compactor. Only its private view and committed public projection differ.
 */
export function makePrivateCompaction(dependencies: Dependencies) {
  const keepTokens = dependencies.config.reduce((tokens, entry) =>
    entry.type === "document" ? entry.info.compaction?.keep?.tokens ?? tokens : tokens, 8_000)

  const run = Effect.fn("CyberMastery.privateCompaction")(function* (input: Input, overflow: boolean) {
    const database = yield* Database.Service
    const prepared = yield* preparePrivateTurn(input)
    if (!prepared.private) {
      const native = SessionCompaction.make(dependencies)
      return yield* (overflow ? native.compactAfterOverflow(input) : native.compactIfNeeded(input))
    }
    const selected = splitEntries(prepared.entries, keepTokens)
    const recentIDs = new Set(selected?.recent.map((entry) => entry.message.id) ?? [])
    const cleanRecent = renderEntries(input.entries.filter((entry) => recentIDs.has(entry.message.id)))
    const privateRecent = renderEntries(selected?.recent ?? [])
    const events: EventV2.Interface = {
      ...dependencies.events,
      publish: (definition, data, options) => {
        if (definition.type !== SessionEvent.Compaction.Ended.type) return dependencies.events.publish(definition, data, options)
        // Roundtrip through the exact native codec to bridge the generic publish
        // signature without trusting a cast or altering the native event schema.
        const value = Schema.decodeUnknownSync(SessionEvent.Compaction.Ended.data)(
          Schema.encodeUnknownSync(SessionEvent.Compaction.Ended.data)(data),
        )
        if (value.sessionID !== input.sessionID) return Effect.die("Compaction session identity changed")
        const checkpoint = makeCheckpoint({ summary: value.text, recent: privateRecent, createdAt: DateTime.toEpochMillis(value.timestamp) })
        return dependencies.events.publish(definition, Object.assign({}, data, { text: SENTINEL, recent: cleanRecent }), {
          ...options,
          commit: (seq) => Effect.gen(function* () {
            if (options?.commit) yield* options.commit(seq)
            yield* persistCheckpoint({ sessionID: input.sessionID, messageID: value.messageID, seq, checkpoint })
              .pipe(Effect.provideService(Database.Service, database), Effect.orDie)
          }),
        })
      },
    }
    const native = SessionCompaction.make({ ...dependencies, events })
    const enriched = { ...input, entries: prepared.entries, request: prepared.request }
    return yield* (overflow ? native.compactAfterOverflow(enriched) : native.compactIfNeeded(enriched))
  })
  return {
    compactIfNeeded: (input: Input) => run(input, false),
    compactAfterOverflow: (input: Input) => run(input, true),
  }
}
