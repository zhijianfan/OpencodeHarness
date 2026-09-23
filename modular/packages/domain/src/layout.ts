import { decodeLayoutCommand, decodeLayoutTuple, type Actor, type Layout, type LayoutCommand, type LayoutTuple } from "@cybermastery/contracts/layout"

export class LayoutError extends Error {
  constructor(readonly code: "forbidden" | "not-found" | "conflict" | "handed-over" | "invalid-functionality", readonly revision?: number) {
    super(code)
    this.name = "LayoutError"
  }
}

export type LayoutRepository = {
  readonly get: (actor: Actor, workspaceID: string, tuple: LayoutTuple, clientID: string, claimAuthority?: boolean) => Promise<Layout>
  readonly save: (actor: Actor, command: LayoutCommand) => Promise<Layout>
}

export function createLayoutService(repository: LayoutRepository, functionalities: ReadonlyMap<string, { readonly minW: number; readonly minH: number }>) {
  return {
    async get(actor: Actor, workspaceID: string, tuple: unknown, clientID: string, claimAuthority = true) {
      const value = decodeLayoutTuple(tuple)
      if (!actor.userID || actor.userID !== value.user) throw new LayoutError("forbidden")
      if (!workspaceID.trim() || !clientID.trim()) throw new LayoutError("forbidden")
      return repository.get(actor, workspaceID, value, clientID, claimAuthority)
    },
    async save(actor: Actor, input: unknown) {
      const command = decodeLayoutCommand(input)
      if (!actor.userID || actor.userID !== command.tuple.user) throw new LayoutError("forbidden")
      for (const block of command.blocks) {
        const functionality = functionalities.get(block.functionalityID)
        if (!functionality || block.transform.w < functionality.minW || block.transform.h < functionality.minH) {
          throw new LayoutError("invalid-functionality")
        }
      }
      return repository.save(actor, command)
    },
  }
}
