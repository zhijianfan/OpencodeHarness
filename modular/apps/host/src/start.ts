import { resolve } from "node:path"
import { createApplication } from "./app"

const mode = process.argv.includes("--proof") ? "proof" : "full"
const token = process.env.CYBERMASTERY_PROOF_TOKEN ?? ""
const filename = process.env.CYBERMASTERY_PROOF_DB
if (!filename) throw new Error("Set CYBERMASTERY_PROOF_DB to an explicit disposable database path")
const app = await createApplication({
  mode,
  filename,
  workspaceID: "proof-workspace",
  userID: "proof-user",
  token,
  staticDirectory: resolve(import.meta.dir, "../../web/dist"),
})
const server = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PORT ?? 3174), fetch: app.fetch })
console.log(`CyberMastery ${mode} host: ${server.url}`)
process.once("SIGINT", async () => { server.stop(true); await app.dispose() })
process.once("SIGTERM", async () => { server.stop(true); await app.dispose() })
