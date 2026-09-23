# Web worker

Implement only D:/OpencodeHarness/modular/apps/web/src/main.tsx, i18n.ts, style.css. No exploration/tests/commands/config/generated edits. Use available write tool for new files. All context below. Emit implementation rather than extended planning.

Stack: SolidJS 1.9.10, vite-plugin-solid, TS JSX preserve. index.html supplies <div id="root">, lang=en dir=ltr. main.tsx imports render from solid-js/web, createStore from solid-js/store, named Solid functions as needed, and ./style.css. No any/star/aliased imports. All user-visible text through own i18n t(key) with English dictionary in i18n.ts. Do not read/touch native packages. This is a proof shell; clearly label it as proof and not complete CyberMastery parity. No need to implement session blocks in this task.

Imports and contracts:
`import { createLayoutClient } from "@cybermastery/client"`
function createLayoutClient(options:{baseUrl:string;token:string;userID:string;workspaceID:string;clientID:string;fetch?:typeof fetch}) -> {get(options?:{claim?:boolean;signal?:AbortSignal}):Promise<Layout>;save(blocks:readonly BlockDescriptor[],expectedRevision:number,signal?:AbortSignal):Promise<Layout>;subscribe(onEvent:(event:LayoutEvent)=>void,signal:AbortSignal,onReady?:()=>void):Promise<void>}
Layout={id:string,workspaceID:string,revision:number,blocks:readonly BlockDescriptor[]}; LayoutEvent={type:"workspace.layout.updated",properties:{workspaceID:string,revision:number}}.
`import type { Layout, BlockDescriptor } from "@cybermastery/contracts/layout"`
BlockDescriptor={readonly id:string;readonly functionalityID:string;readonly transform:{readonly x:number;readonly y:number;readonly w:number;readonly h:number;readonly z:number}}.

`import { createRegistry, type BlockDefinition } from "@cybermastery/canvas/registry"`
BlockDefinition={functionalityID:string,labelKey:string,mode:"native"|"projected"|"local"|"static",contractVersion:number,minW:number,minH:number,create:(block:BlockDescriptor)=>{refresh:()=>Promise<void>,dispose:()=>void},render:(block:BlockDescriptor)=>{titleKey:string,bodyKey:string}}
createRegistry(definitions:readonly BlockDefinition[]) -> {list():readonly BlockDefinition[];get(id:string):BlockDefinition|undefined;mount(block:BlockDescriptor):{definition:BlockDefinition,runtime:{refresh:()=>Promise<void>,dispose:()=>void},dispose:()=>void}|undefined}. Unknown renderer returns undefined; cleanup idempotent.

Build a minimal standalone proof shell:
- Form for password-type auth token (memory only, no localStorage/url). User/workspace fixed proof-user/proof-workspace matching master proof host, baseUrl window.location.origin, clientID crypto.randomUUID per shell context.
- Connect aborts previous session stream/requests, loads layout via get({claim:true}), then starts ONE subscribe for that connection context. Use a generation identity or AbortSignal to prevent stale async completions changing current state. onCleanup aborts pending work and disposes mounted runtimes.
- One registered proof:static-card descriptor, labelKey/titleKey/bodyKey in dictionary, mode static, contractVersion1,minW120,minH80; create has no resource side effects. Palette metadata and view copy come through registry. Render unsupported functionality honestly with t("unsupported") and ID via <bdi dir="ltr">.
- Buttons Add card, Save, Reload, Remove per card; every action labels via t. Saving uses last authoritative revision, then sets returned layout. Successful save uses explicit current client authority; Reload button may get claim:true for explicit handover. Event invalidation GET uses claim:false so it cannot steal another writer's authority. Do not silently save on events; if local edits are dirty, show stale/conflict notice until explicit reload instead of discarding edits.
- Saving only clears dirty if same local edit revision acknowledged; preserve edits made in flight. Errors shown as localized generic action failure, not raw token-bearing errors.
- createStore for state, keep DOM/focus order natural, logical CSS padding/margin/inset properties. No row-reverse. lang=en and document.dir derive optional URL dir=rtl/ltr for manual RTL validation without changing language. Isolate IDs with bdi LTR. No screenshots or production claims.
- Render small cards in a grid rather than implementing full infinite canvas/pan/resize. This task is the static-card host proof only; clearly keep that limitation in interface copy.

No tests required from you. Master runs typecheck and Vite build after both workers return. Return owned files and uncertainties. Do not call unavailable read tools.
