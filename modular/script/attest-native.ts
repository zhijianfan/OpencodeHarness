import { attestUpstream } from "../packages/compat/src/upstream"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const pin = await Bun.file(resolve(root, "compat/upstream-pin.json")).json()
const attestation = await attestUpstream(resolve(root, pin.path), pin)
console.log(JSON.stringify(attestation, null, 2))
if (process.argv.includes("--record")) {
  await Bun.write(resolve(root, "compat/upstream-provenance.json"), JSON.stringify(attestation, null, 2) + "\n")
}
