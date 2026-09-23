import { For, Show, batch, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { createRegistry, type BlockDefinition } from "@cybermastery/canvas/registry"
import { createLayoutClient } from "@cybermastery/client"
import type { BlockDescriptor, Layout } from "@cybermastery/contracts/layout"
import { t } from "./i18n"
import "./style.css"

const USER_ID = "proof-user"
const WORKSPACE_ID = "proof-workspace"
const FUNCTIONALITY_ID = "proof:static-card"

const CARD_WIDTH = 160
const CARD_HEIGHT = 100
const GRID_COLUMNS = 3
const COLUMN_STEP = 176
const ROW_STEP = 116

const staticCard: BlockDefinition = {
  functionalityID: FUNCTIONALITY_ID,
  labelKey: "block.staticCard.label",
  mode: "static",
  contractVersion: 1,
  minW: 120,
  minH: 80,
  create: () => ({
    refresh: async () => {},
    dispose: () => {},
  }),
  render: () => ({
    titleKey: "block.staticCard.title",
    bodyKey: "block.staticCard.body",
  }),
}

type ConnectionState = "disconnected" | "connecting" | "connected"

type BusyState = "idle" | "loading" | "saving"

type CardView = {
  id: string
  functionalityID: string
  supported: boolean
  titleKey: string
  bodyKey: string
  transform: BlockDescriptor["transform"]
}

type AppState = {
  token: string
  connection: ConnectionState
  busy: BusyState
  layoutID: string | undefined
  revision: number
  blocks: BlockDescriptor[]
  cards: CardView[]
  editSeq: number
  dirty: boolean
  stale: boolean
  conflict: boolean
  failed: boolean
}

function App() {
  const registry = createRegistry([staticCard])
  type MountedBlock = NonNullable<ReturnType<typeof registry.mount>>
  const definitions = registry.list()
  const mounted = new Map<string, MountedBlock>()

  let generation = 0
  let controller: AbortController | undefined
  let client: ReturnType<typeof createLayoutClient> | undefined

  const [store, setState] = createStore<AppState>({
    token: "",
    connection: "disconnected",
    busy: "idle",
    layoutID: undefined,
    revision: 0,
    blocks: [],
    cards: [],
    editSeq: 0,
    dirty: false,
    stale: false,
    conflict: false,
    failed: false,
  })

  const canEdit = () => store.connection === "connected" && store.busy !== "loading"

  const connectionLabel = () => {
    if (store.connection === "connecting") return t("status.connecting")
    if (store.connection === "connected") return t("status.connected")
    return t("status.disconnected")
  }

  function abortCurrent() {
    generation += 1
    controller?.abort()
    controller = undefined
    client = undefined
  }

  function disposeMounted() {
    mounted.forEach((handle) => handle.dispose())
    mounted.clear()
  }

  function mountCard(block: BlockDescriptor): CardView {
    const handle = registry.mount(block)
    if (handle === undefined) {
      return {
        id: block.id,
        functionalityID: block.functionalityID,
        supported: false,
        titleKey: "",
        bodyKey: "",
        transform: { ...block.transform },
      }
    }
    mounted.set(block.id, handle)
    const view = handle.definition.render(block)
    return {
      id: block.id,
      functionalityID: block.functionalityID,
      supported: true,
      titleKey: view.titleKey,
      bodyKey: view.bodyKey,
      transform: { ...block.transform },
    }
  }

  function applyLayout(layout: Layout) {
    disposeMounted()
    const cards = layout.blocks.map((block) => mountCard(block))
    batch(() => {
      setState("layoutID", layout.id)
      setState("revision", layout.revision)
      setState("blocks", layout.blocks.slice())
      setState("cards", cards)
    })
  }

  async function connect() {
    const token = store.token.trim()
    if (token.length === 0) return
    abortCurrent()
    disposeMounted()
    const context = generation
    const active = new AbortController()
    controller = active
    const nextClient = createLayoutClient({
      baseUrl: window.location.origin,
      token,
      userID: USER_ID,
      workspaceID: WORKSPACE_ID,
      clientID: crypto.randomUUID(),
    })
    client = nextClient
    batch(() => {
      setState("connection", "connecting")
      setState("busy", "loading")
      setState("failed", false)
      setState("layoutID", undefined)
      setState("revision", 0)
      setState("blocks", [])
      setState("cards", [])
      setState("editSeq", 0)
      setState("dirty", false)
      setState("stale", false)
      setState("conflict", false)
    })
    try {
      const layout = await nextClient.get({ claim: true, signal: active.signal })
      if (context !== generation) return
      applyLayout(layout)
      setState("connection", "connected")
      setState("busy", "idle")
      await nextClient.subscribe(
        (event) => {
          if (context !== generation) return
          if (event.type !== "workspace.layout.updated") return
          if (event.properties.workspaceID !== WORKSPACE_ID) return
          if (event.properties.revision <= store.revision) return
          if (store.dirty) {
            setState("stale", true)
            return
          }
          void refreshAuthoritative(context, active.signal)
        },
        active.signal,
        () => {
          if (context !== generation) return
          setState("connection", "connected")
          // Reconcile changes that happened between the initial read and SSE establishment.
          void refreshAuthoritative(context, active.signal)
        },
      )
      if (context !== generation || active.signal.aborted) return
      abortCurrent()
      batch(() => {
        setState("connection", "disconnected")
        setState("busy", "idle")
      })
    } catch {
      if (context !== generation) return
      active.abort()
      batch(() => {
        setState("connection", "disconnected")
        setState("busy", "idle")
        setState("failed", true)
      })
    }
  }

  function disconnect() {
    abortCurrent()
    disposeMounted()
    batch(() => {
      setState("connection", "disconnected")
      setState("busy", "idle")
      setState("layoutID", undefined)
      setState("revision", 0)
      setState("blocks", [])
      setState("cards", [])
      setState("editSeq", 0)
      setState("dirty", false)
      setState("stale", false)
      setState("conflict", false)
      setState("failed", false)
    })
  }

  async function save() {
    const layoutClient = client
    const active = controller
    if (layoutClient === undefined || active === undefined) return
    if (!canEdit() || store.busy !== "idle" || !store.dirty) return
    const context = generation
    const blocks = store.blocks.map((block) => ({ ...block, transform: { ...block.transform } }))
    const expectedRevision = store.revision
    const acknowledged = store.editSeq
    const staleBeforeSave = store.stale
    setState("busy", "saving")
    setState("failed", false)
    try {
      const saved = await layoutClient.save(blocks, expectedRevision, active.signal)
      if (context !== generation) return
      if (store.editSeq !== acknowledged) {
        batch(() => {
          setState("revision", saved.revision)
          setState("conflict", false)
          setState("busy", "idle")
        })
        return
      }
      applyLayout(saved)
      setState("dirty", false)
      setState("conflict", false)
      setState("busy", "idle")
      if (staleBeforeSave) {
        void refreshAuthoritative(context, active.signal)
        return
      }
      setState("stale", false)
    } catch {
      if (context !== generation || active.signal.aborted) return
      batch(() => {
        setState("busy", "idle")
        setState("failed", true)
        if (store.dirty) setState("conflict", true)
      })
    }
  }

  async function reload() {
    const layoutClient = client
    const active = controller
    if (layoutClient === undefined || active === undefined) return
    if (!canEdit() || store.busy !== "idle") return
    const context = generation
    setState("busy", "loading")
    setState("failed", false)
    try {
      const layout = await layoutClient.get({ claim: true, signal: active.signal })
      if (context !== generation) return
      applyLayout(layout)
      batch(() => {
        setState("dirty", false)
        setState("stale", false)
        setState("conflict", false)
        setState("busy", "idle")
      })
    } catch {
      if (context !== generation || active.signal.aborted) return
      batch(() => {
        setState("busy", "idle")
        setState("failed", true)
      })
    }
  }

  async function refreshAuthoritative(context: number, signal: AbortSignal) {
    const layoutClient = client
    if (layoutClient === undefined) return
    const editSeq = store.editSeq
    try {
      const layout = await layoutClient.get({ claim: false, signal })
      if (context !== generation) return
      if (layout.revision < store.revision) return
      if (store.dirty || store.editSeq !== editSeq) {
        setState("stale", true)
        return
      }
      applyLayout(layout)
      batch(() => {
        setState("stale", false)
        setState("failed", false)
      })
    } catch {
      if (context !== generation || signal.aborted) return
      setState("failed", true)
    }
  }

  function addCard() {
    if (!canEdit()) return
    const index = store.cards.length
    const descriptor: BlockDescriptor = {
      id: crypto.randomUUID(),
      functionalityID: FUNCTIONALITY_ID,
      transform: {
        x: (index % GRID_COLUMNS) * COLUMN_STEP,
        y: Math.floor(index / GRID_COLUMNS) * ROW_STEP,
        w: CARD_WIDTH,
        h: CARD_HEIGHT,
        z: index + 1,
      },
    }
    const card = mountCard(descriptor)
    batch(() => {
      setState("blocks", [...store.blocks, descriptor])
      setState("cards", [...store.cards, card])
      setState("editSeq", store.editSeq + 1)
      setState("dirty", true)
      setState("failed", false)
    })
  }

  function removeCard(id: string) {
    if (!canEdit()) return
    const handle = mounted.get(id)
    if (handle !== undefined) {
      handle.dispose()
      mounted.delete(id)
    }
    batch(() => {
      setState("blocks", store.blocks.filter((block) => block.id !== id))
      setState("cards", store.cards.filter((card) => card.id !== id))
      setState("editSeq", store.editSeq + 1)
      setState("dirty", true)
    })
  }

  onCleanup(() => {
    abortCurrent()
    disposeMounted()
  })

  return (
    <main class="shell">
      <header class="header">
        <h1>{t("app.title")}</h1>
        <p class="proof-badge">{t("app.proofLabel")}</p>
        <p class="proof-note">{t("app.proofNotice")}</p>
      </header>

      <section class="panel" aria-labelledby="session-heading">
        <h2 id="session-heading">{t("auth.title")}</h2>
        <form
          class="auth"
          onSubmit={(event) => {
            event.preventDefault()
            void connect()
          }}
        >
          <label for="auth-token">{t("auth.tokenLabel")}</label>
          <input
            id="auth-token"
            type="password"
            autocomplete="off"
            value={store.token}
            onInput={(event) => setState("token", event.currentTarget.value)}
          />
          <p class="hint">{t("auth.tokenHint")}</p>
          <div class="row">
            <button type="submit" disabled={store.connection === "connecting" || store.token.trim().length === 0}>
              {store.connection === "connecting" ? t("auth.connecting") : t("auth.connect")}
            </button>
            <button type="button" disabled={store.connection === "disconnected"} onClick={disconnect}>
              {t("auth.disconnect")}
            </button>
          </div>
        </form>
        <p class="status" role="status">{connectionLabel()}</p>
        <Show when={store.busy !== "idle"}>
          <p class="status" role="status">
            {store.busy === "saving" ? t("status.saving") : t("status.loading")}
          </p>
        </Show>
        <Show when={store.failed}>
          <p class="notice notice-error" role="alert">{t("error.action")}</p>
        </Show>
        <Show when={store.stale}>
          <p class="notice" role="alert">{t("notice.stale")}</p>
        </Show>
        <Show when={store.conflict}>
          <p class="notice" role="alert">{t("notice.conflict")}</p>
        </Show>
      </section>

      <section class="panel" aria-labelledby="palette-heading">
        <h2 id="palette-heading">{t("palette.title")}</h2>
        <Show when={definitions.length > 0} fallback={<p class="empty">{t("palette.empty")}</p>}>
          <ul class="palette">
            <For each={definitions}>
              {(definition) => (
                <li class="palette-item">
                  <strong>{t(definition.labelKey)}</strong>
                  <span class="meta">
                    {t("palette.mode")}: {t(`mode.${definition.mode}`)}{" · "}
                    {t("palette.contract")}: {definition.contractVersion}{" · "}
                    {t("palette.minSize")}: {definition.minW}×{definition.minH}
                  </span>
                  <bdi dir="ltr" class="meta">{definition.functionalityID}</bdi>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>

      <section class="panel" aria-labelledby="canvas-heading">
        <h2 id="canvas-heading">{t("canvas.title")}</h2>
        <p class="hint">{t("canvas.limitation")}</p>
        <p class="hint">{t("canvas.positions")}</p>
        <Show when={store.layoutID}>
          {(layoutID) => (
            <p class="meta">
              {t("canvas.layoutID")}: <bdi dir="ltr">{layoutID()}</bdi>{" · "}
              {t("canvas.revision")}: {store.revision}
            </p>
          )}
        </Show>
        <div class="row">
          <button type="button" disabled={!canEdit()} onClick={addCard}>
            {t("action.addCard")}
          </button>
          <button type="button" disabled={!canEdit() || store.busy !== "idle" || !store.dirty} onClick={() => void save()}>
            {t("action.save")}
          </button>
          <button type="button" disabled={!canEdit() || store.busy !== "idle"} onClick={() => void reload()}>
            {t("action.reload")}
          </button>
        </div>
        <Show when={store.cards.length === 0}>
          <p class="empty">{t("canvas.empty")}</p>
        </Show>
        <ul class="cards">
          <For each={store.cards}>
            {(card) => (
              <li class="card">
                <div class="card-header">
                  <Show when={card.supported} fallback={<strong class="unsupported">{t("unsupported")}</strong>}>
                    <strong>{t(card.titleKey)}</strong>
                  </Show>
                  <button type="button" disabled={!canEdit()} onClick={() => removeCard(card.id)}>
                    {t("card.remove")}
                  </button>
                </div>
                <p class="card-body">
                  <Show when={card.supported} fallback={<span>{t("unsupported.hint")}</span>}>
                    {t(card.bodyKey)}
                  </Show>
                </p>
                <p class="card-meta">
                  {t("card.id")}: <bdi dir="ltr">{card.id}</bdi>
                </p>
                <p class="card-meta">
                  {t("card.functionality")}: <bdi dir="ltr">{card.functionalityID}</bdi>
                </p>
                <p class="card-meta">
                  {t("card.transform")}:{" "}
                  <bdi dir="ltr">
                    {`${card.transform.x}, ${card.transform.y} · ${card.transform.w}×${card.transform.h} · z ${card.transform.z}`}
                  </bdi>
                </p>
              </li>
            )}
          </For>
        </ul>
      </section>
    </main>
  )
}

function applyDocumentDirection() {
  const direction = new URLSearchParams(window.location.search).get("dir")
  if (direction !== "rtl" && direction !== "ltr") return
  document.dir = direction
}

applyDocumentDirection()

const root = document.getElementById("root")
if (root === null) throw new Error(t("boot.missingRoot"))
render(() => <App />, root)
