import { afterAll } from "bun:test"
import { rm } from "node:fs/promises"

/** Call once at test-file registration time; each file owns its own cleanup set. */
export function databaseCleanup() {
  const directories = new Set<string>()
  afterAll(async () => {
    for (const directory of directories) {
      await remove(directory)
      directories.delete(directory)
    }
  })
  return (directory: string) => { directories.add(directory) }
}

async function remove(directory: string, retries = 30): Promise<void> {
  Bun.gc(true)
  await rm(directory, { recursive: true, force: true }).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EBUSY" || retries === 0) throw error
    await Bun.sleep(100)
    await remove(directory, retries - 1)
  })
}
