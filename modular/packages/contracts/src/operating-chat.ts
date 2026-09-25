/** Trusted OperatingChat binding identity; browser-safe and independent of native Core. */
export type OperatingChatProfile = {
  readonly kind: "operating-chat"
  readonly workspaceID: string
  readonly workspaceName: string
  readonly blockID: string
  readonly functionalityID: "builtin:operating-chat-session"
  readonly functionalityInstanceID: string
  readonly generation: number
  readonly revision: number
  readonly directory: string
  readonly operatingAgent: string
}
export type OperatingChatBindingError = {
  readonly _tag: "OperatingChatBinding.Error"
  readonly code: "unauthorized" | "invalid" | "conflict" | "stale" | "missing-session"
}
export type OperatingChatDescriptor = {
  readonly workspaceID: string
  readonly workspaceName: string
  readonly blockID: string
  readonly functionalityID: "builtin:operating-chat-session"
  readonly functionalityInstanceID: string
  readonly directory: string
  readonly operatingAgent: string
}
