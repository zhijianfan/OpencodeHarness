import { Context } from "effect"
import type { SessionSchema } from "@opencode-ai/core/session/schema"

/** Internal permit set only around an authorized, validated private bundle replay. */
export class PrivateRestoreContext extends Context.Service<PrivateRestoreContext, {
  readonly sessionID: SessionSchema.ID
  readonly digest: string
}>()("@cybermastery/PrivateRestoreContext") {}
