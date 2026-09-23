# Client worker

Implement only D:/OpencodeHarness/modular/packages/client/src/client.ts and client.test.ts. Do not explore or run commands. Available write tool is allowed for these new files. Prefer outputting the files over further planning. Use Bun 1.3.14 and TS, named imports, no any/star/aliases. No config/lock/generated edits. Master tests after all workers return.

Imports supplied:
`import { routes } from "./generated/routes"` where routes = {layout:{method:"GET",path:"/api/cybermastery/layout"},save:{method:"PUT",path:"/api/cybermastery/layout"},events:{method:"GET",path:"/api/cybermastery/events"}} as const.
`import { decodeLayoutCommand, type Layout, type BlockDescriptor } from "@cybermastery/contracts/layout"`.
Pinned shapes: BlockDescriptor={readonly id:string;readonly functionalityID:string;readonly transform:{readonly x:number;readonly y:number;readonly w:number;readonly h:number;readonly z:number}}; Layout={readonly id:string;readonly workspaceID:string;readonly revision:number;readonly blocks:readonly BlockDescriptor[]}.
decodeLayoutCommand(value:unknown) validates exact shape {workspaceID:string,tuple:{user:string,style:string,deviceClass:"desktop"|"mobile"|"tablet"},clientID:string,expectedRevision:number,blocks:BlockDescriptor[]} and returns a fresh deep copy. Throws InvalidLayoutCommand. All identity strings nonempty; finite x/y/z; positive w/h; safe nonnegative revision; unique block IDs. Use it to validate response blocks/revision without duplicating that logic.

Exports exact:
type LayoutEvent={readonly type:"workspace.layout.updated";readonly properties:{readonly workspaceID:string;readonly revision:number}}
class ClientError extends Error with readonly status:number, code:string, revision?:number; constructor(status:number,code:string,revision?:number).
createLayoutClient(options:{readonly baseUrl:string;readonly token:string;readonly userID:string;readonly workspaceID:string;readonly clientID:string;readonly fetch?:typeof fetch}) returning:
- get(options?:{readonly claim?:boolean;readonly signal?:AbortSignal}):Promise<Layout>
- save(blocks:readonly BlockDescriptor[],expectedRevision:number,signal?:AbortSignal):Promise<Layout>
- subscribe(onEvent:(event:LayoutEvent)=>void,signal:AbortSignal,onReady?:()=>void):Promise<void>

HTTP protocol: every call Authorization Bearer token, query workspaceID; get query style=canvas, deviceClass=desktop, clientID, claim=1 only if explicitly true (default no authority claim). save JSON {workspaceID,tuple:{user:userID,style:"canvas",deviceClass:"desktop"},clientID,expectedRevision,blocks}, content-type application/json. Backend responds Layout or error {code:string,revision?:number} with non2xx. Validate response identity/workspace/revision/blocks and reject mismatched workspace/invalid response with ClientError; preserve non2xx code/status. Do not expose token in errors.

subscribe fetches events with same auth, provided signal. After response.ok, call onReady. Parse UTF8 SSE incrementally (stream can split anywhere), frames separated blank LF/CRLF lines; combine data: lines with newline; ignore comments such as : connected. Accept only canonical event type with matching workspace and nonnegative safe integer revision; ignore other well-formed events, reject malformed JSON. Stop cleanly on caller abort (do not swallow non-abort errors). Always release/cancel reader on exit. No auto-reconnect; caller owns connection lifecycle. No extra event connection per card.

Test real implementation via injected fetch returning real Response and ReadableStream objects; no global mocks. Cover query/claim/auth/body, response validation and non2xx conflicts, SSE split UTF8 and CRLF frames, workspace filtering, abort cleanup and one fetch per subscription. Tests import named bun:test functions. Master supplies generated route file before validation.

Return owned files and uncertainties. Do not read any files or call unavailable tools.
