import assert from "node:assert/strict"
import { chromium } from "playwright"

const url = process.argv[2]
if (!url) throw new Error("A disposable proof-host URL is required")
const browser = await chromium.launch({ headless: true, timeout: 10_000, ...(process.platform === "win32" ? { channel: "msedge" } : {}) })
try {
  const leftContext = await browser.newContext()
  const rightContext = await browser.newContext()
  const left = await leftContext.newPage()
  const right = await rightContext.newPage()
  left.setDefaultTimeout(5_000)
  right.setDefaultTimeout(5_000)
  const errors = []
  left.on("pageerror", (error) => errors.push(error.message))
  right.on("pageerror", (error) => errors.push(error.message))
  await left.goto(url)
  await right.goto(`${url}?dir=rtl`)
  for (const page of [left, right]) {
    await page.getByLabel("Auth token", { exact: true }).fill("browser-proof-token")
    await page.getByRole("button", { name: "Connect", exact: true }).click()
    await page.getByText("Connected", { exact: true }).waitFor()
  }
  assert.equal(await left.locator("html").getAttribute("dir"), "ltr")
  assert.equal(await right.locator("html").getAttribute("dir"), "rtl")
  assert.equal(await right.locator("html").getAttribute("lang"), "en")
  await left.getByRole("button", { name: "Reload", exact: true }).click()
  await left.getByRole("button", { name: "Add card", exact: true }).click()
  await left.getByRole("button", { name: "Save", exact: true }).click()
  await right.getByText("Proof static card", { exact: true }).waitFor()
  assert.equal(await left.locator(".cards .card").count(), 1)
  assert.equal(await right.locator(".cards .card").count(), 1)
  await left.getByRole("button", { name: "Remove", exact: true }).click()
  await left.getByRole("button", { name: "Save", exact: true }).click()
  await right.getByText("The workspace layout has no blocks yet.", { exact: true }).waitFor()
  assert.equal(await right.locator(".cards .card").count(), 0)
  assert.deepEqual(errors, [])
  await leftContext.close()
  await rightContext.close()
  console.log(JSON.stringify({ ltr: true, rtl: true, synchronized: true, removed: true, pageErrors: errors }))
} finally {
  await browser.close()
}
