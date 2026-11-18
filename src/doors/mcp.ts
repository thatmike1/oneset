// the MCP door, hand-written: a stateless streamable-HTTP handler with initialize (version
// negotiation and instructions), tools/list, tools/call and ping. Notifications get 202, GET 405.
// Protocol errors stay JSON-RPC errors; a failed tool call, an unknown tool and invalid arguments
// come back as tool results with isError, as the official SDK does.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AnyAction, Door, DoorOptions, Registry } from "../core.ts";
import { errorShape } from "../errors.ts";
import { createGuard, type GuardOptions, maxBodyOf } from "./guard.ts";

/**
 * the protocol versions this door speaks, newest first. Only versions whose published contract
 * it meets, which is the two with stateless streamable HTTP and one message per POST.
 * 2025-03-26 is left out because its base protocol says implementations MUST support receiving
 * JSON-RPC batches, which this door refuses; 2024-11-05 because its HTTP transport MUST provide
 * an SSE endpoint, which this door does not serve; 2024-10-07 because it has no published spec
 */
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18"] as const;
export const LATEST_PROTOCOL_VERSION = PROTOCOL_VERSIONS[0];

export interface McpOptions<Def = AnyAction, Caller = any>
  extends Omit<DoorOptions<Def, Caller>, "name">,
    GuardOptions {
  /** the server name agents see */
  name: string;
  /** default 1.0.0 */
  version?: string;
  /** how an agent should use these tools, sent in `initialize` */
  instructions?: string;
}

/** answers one MCP request for a caller the app already resolved; `body` when the app read it already */
export type McpHandler<Caller = any> = ((
  req: IncomingMessage,
  res: ServerResponse,
  caller: Caller,
  body?: unknown,
) => Promise<void>) & {
  /** the door underneath, for its catalog (the skill lists its tools) */
  door: Door<any, Caller>;
};

type Id = string | number;
interface Message {
  jsonrpc: "2.0";
  id?: Id;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

class RpcError extends Error {
  readonly status: number;
  readonly rpcCode: number;
  readonly headers: Record<string, string>;
  constructor(status: number, rpcCode: number, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.rpcCode = rpcCode;
    this.headers = headers;
  }
}

function sendRpc(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

/**
 * the guard's Host and Origin refusal as MCP answers it: 403 with a JSON-RPC error and no id.
 * `doors()` sends its own /mcp refusals through this too, so both mounts answer alike
 */
export function sendRefusal(res: ServerResponse, err: { status: number; message: string }): void {
  sendRpc(res, err.status, { jsonrpc: "2.0", error: { code: -32000, message: err.message }, id: null });
}

function isMessage(m: unknown): m is Message {
  if (m === null || typeof m !== "object" || Array.isArray(m)) return false;
  const msg = m as Record<string, unknown>;
  if (msg.jsonrpc !== "2.0") return false;
  const hasId = typeof msg.id === "string" || (typeof msg.id === "number" && Number.isFinite(msg.id));
  if ("method" in msg) {
    if (typeof msg.method !== "string") return false;
    if ("id" in msg && !hasId) return false;
    if ("params" in msg && (msg.params === null || typeof msg.params !== "object")) return false;
    return true;
  }
  // a response from the client
  return hasId && ("result" in msg || "error" in msg);
}

async function readBody(req: IncomingMessage, maxBody: number): Promise<unknown> {
  const declared = Number(req.headers["content-length"] ?? Number.NaN);
  const tooLarge = () => new RpcError(413, -32000, `Request body too large: the limit is ${maxBody} bytes`);
  if (declared > maxBody) throw tooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBody) throw tooLarge();
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RpcError(400, -32700, "Parse error: Invalid JSON");
  }
}

const METHODS = new Set(["initialize", "ping", "tools/list", "tools/call"]);

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const invalidParams = (message: string) => new RpcError(200, -32602, `Invalid params: ${message}`);

// RFC 9110: parameter = token "=" ( token / quoted-string ), no space around "=" (5.6.6), and
// qvalue = ( "0" [ "." 0*3DIGIT ] ) / ( "1" [ "." 0*3("0") ] ) (12.4.2)
const PARAMETER = /^[!#$%&'*+.^_`|~0-9a-z-]+=(?:[!#$%&'*+.^_`|~0-9a-z-]+|"(?:[^"\\]|\\.)*")$/;
const QVALUE = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;

/**
 * whether an Accept header takes this media type: a matching range, no wildcards, whose
 * parameters all parse and whose qvalue, when it has one, is a valid one above 0
 */
function accepts(header: string, type: string): boolean {
  for (const range of header.split(",")) {
    const [media = "", ...params] = range.split(";").map((p) => p.trim().toLowerCase());
    if (media !== type) continue;
    // empty parameters are allowed between semicolons; a malformed one spoils the range
    const named = params.filter((p) => p !== "");
    if (!named.every((p) => PARAMETER.test(p))) continue;
    // a range has at most one weight: a repeated q spoils it instead of the last one winning
    const weights = named.filter((p) => p.startsWith("q=")).map((p) => p.slice(2));
    if (weights.length > 1) continue;
    const [q] = weights;
    if (q === undefined || (QVALUE.test(q) && Number(q) > 0)) return true;
  }
  return false;
}

/** a known field's type: a JSON type, or an object whose known keys have these types */
type Shape = "object" | "boolean" | "string" | { readonly [key: string]: Shape };

/** the client capabilities the 2025-11-25 schema names; others are extensions and stay open */
const CAPABILITIES: Shape = {
  roots: { listChanged: "boolean" },
  sampling: { context: "object", tools: "object" },
  elicitation: { form: "object", url: "object" },
  tasks: {
    list: "object",
    cancel: "object",
    requests: { sampling: { createMessage: "object" }, elicitation: { create: "object" } },
  },
};
const CLIENT_INFO: Shape = { title: "string", description: "string", websiteUrl: "string" };
const ICON: Shape = { mimeType: "string" };

/** what is wrong with a value of this shape, if anything; keys a shape does not name pass */
function misfit(value: unknown, shape: Shape, path: string): string | undefined {
  if (shape === "boolean" || shape === "string") {
    return typeof value === shape ? undefined : `${path} must be a ${shape}`;
  }
  if (!isObject(value)) return `${path} must be an object`;
  if (shape === "object") return undefined;
  for (const [key, inner] of Object.entries(shape)) {
    if (!Object.hasOwn(value, key)) continue;
    const bad = misfit(value[key], inner, `${path}.${key}`);
    if (bad) return bad;
  }
  return undefined;
}

function misfitIcon(icon: unknown, path: string): string | undefined {
  const bad = misfit(icon, ICON, path);
  if (bad || !isObject(icon)) return bad ?? `${path} must be an object`;
  if (typeof icon.src !== "string") return `${path}.src must be a string`;
  if (Object.hasOwn(icon, "sizes")) {
    const sizes = icon.sizes;
    if (!Array.isArray(sizes) || !sizes.every((s) => typeof s === "string")) {
      return `${path}.sizes must be an array of strings`;
    }
  }
  if (Object.hasOwn(icon, "theme") && icon.theme !== "light" && icon.theme !== "dark") {
    return `${path}.theme must be light or dark`;
  }
  return undefined;
}

/** initialize's params against the 2025-11-25 schema: required fields, and known optional ones typed */
function checkInitialize(params: Record<string, unknown>): void {
  if (typeof params.protocolVersion !== "string")
    throw invalidParams("initialize needs a protocolVersion string");
  if (!isObject(params.capabilities)) throw invalidParams("initialize needs a capabilities object");
  const client = params.clientInfo;
  if (!isObject(client) || typeof client.name !== "string" || typeof client.version !== "string") {
    throw invalidParams("initialize needs clientInfo with a name and a version");
  }
  const caps = params.capabilities;
  let bad = misfit(caps, CAPABILITIES, "capabilities") ?? misfit(client, CLIENT_INFO, "clientInfo");
  if (!bad && Object.hasOwn(caps, "experimental")) {
    const experimental = caps.experimental;
    if (!isObject(experimental)) bad = "capabilities.experimental must be an object";
    else {
      const key = Object.keys(experimental).find((k) => !isObject(experimental[k]));
      if (key !== undefined) bad = `capabilities.experimental.${key} must be an object`;
    }
  }
  if (!bad && Object.hasOwn(client, "icons")) {
    const icons = client.icons;
    if (!Array.isArray(icons)) bad = "clientInfo.icons must be an array";
    else for (const [i, icon] of icons.entries()) bad ??= misfitIcon(icon, `clientInfo.icons[${i}]`);
  }
  if (!bad && Object.hasOwn(params, "_meta")) {
    const meta = params._meta;
    if (!isObject(meta)) bad = "_meta must be an object";
    else if (Object.hasOwn(meta, "progressToken")) {
      const token = meta.progressToken;
      if (typeof token !== "string" && typeof token !== "number") {
        bad = "_meta.progressToken must be a string or a number";
      }
    }
  }
  if (bad) throw invalidParams(bad);
}

const toolText = (rendered: unknown): string =>
  typeof rendered === "string" ? rendered : rendered === undefined ? "" : JSON.stringify(rendered, null, 2);

/** the tool definitions this caller may see */
export function mcpTools(door: Door, caller: unknown): Record<string, unknown>[] {
  return door.listed(caller).map((def) => {
    const shown = door.describe(def, caller);
    const tool: Record<string, unknown> = { name: def.name.replaceAll(".", "_") };
    if (shown.title !== undefined) tool.title = shown.title;
    tool.description = shown.summary;
    tool.inputSchema = door.inputSchema(def);
    if (shown.annotations !== undefined) tool.annotations = shown.annotations;
    // the SDK marks every plain tool this way; kept so answers match an app's SDK-built ones
    tool.execution = { taskSupport: "forbidden" };
    return tool;
  });
}

/**
 * the MCP door on its own, for an app that keeps its own routes and resolves its caller
 * itself (Tandem, diskzokej). `doors()` mounts the same handler at `/mcp`.
 */
export function mcp<R extends Registry<any, any, any, any, any>>(
  reg: R,
  options: McpOptions<
    R extends Registry<any, any, any, any, infer Def> ? Def : AnyAction,
    R extends Registry<any, infer C, any, any, any> ? C : any
  >,
): McpHandler<R extends Registry<any, infer C, any, any, any> ? C : any> {
  const {
    name,
    version = "1.0.0",
    instructions,
    maxBody: askedMaxBody,
    draft = "draft-7",
    hosts,
    origins,
    ...door
  } = options as McpOptions;
  const maxBody = maxBodyOf({ maxBody: askedMaxBody });
  // the same guard doors() puts in front of every path, so a standalone mount keeps it
  const guard = createGuard({ ...(hosts ? { hosts } : {}), ...(origins ? { origins } : {}) });
  const tools = (reg as Registry).door({ ...door, draft, name: "mcp" });
  const byTool = new Map((reg as Registry).actions.map((def) => [def.name.replaceAll(".", "_"), def]));

  async function callTool(params: Record<string, unknown>, caller: unknown): Promise<unknown> {
    const tool = params.name;
    if (typeof tool !== "string") throw invalidParams("tools/call needs a tool name");
    if ("arguments" in params && !isObject(params.arguments)) {
      throw invalidParams("tools/call arguments must be an object");
    }
    const args = params.arguments ?? {};
    // only an advertised tool name runs: `x.add` is not the tool `x_add`, though it names its action
    const def = byTool.get(tool);
    try {
      if (!def) throw (reg as Registry).unknown(tool);
      const rendered = await tools.run(def.name, args, caller);
      return { content: [{ type: "text", text: toolText(rendered) }] };
    } catch (err) {
      const shape = errorShape(err);
      if (!shape) console.error("oneset: an MCP tool call failed", err);
      // the issues an HTTP caller gets in its error body, as JSON after the one-line message
      const issues = shape?.issues !== undefined ? `\n\nissues: ${JSON.stringify(shape.issues)}` : "";
      const text = shape
        ? `${shape.code}: ${shape.message}${issues}`
        : "internal: something broke on the server";
      return { content: [{ type: "text", text }], isError: true };
    }
  }

  async function answer(msg: Message, caller: unknown): Promise<unknown> {
    if (!METHODS.has(msg.method ?? "")) throw new RpcError(200, -32601, `Method not found: ${msg.method}`);
    // every MCP method takes named params: an object or nothing
    if (msg.params !== undefined && !isObject(msg.params)) throw invalidParams("params must be an object");
    const params = msg.params ?? {};
    switch (msg.method) {
      case "initialize": {
        checkInitialize(params);
        const asked = params.protocolVersion;
        const protocolVersion =
          typeof asked === "string" && (PROTOCOL_VERSIONS as readonly string[]).includes(asked)
            ? asked
            : LATEST_PROTOCOL_VERSION;
        const result: Record<string, unknown> = {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name, version },
        };
        if (instructions) result.instructions = instructions;
        return result;
      }
      case "ping":
        return {};
      case "tools/list":
        return { tools: mcpTools(tools, caller) };
      case "tools/call":
        return callTool(params, caller);
      default:
        throw new RpcError(200, -32601, `Method not found: ${msg.method}`);
    }
  }

  const handle = async (req: IncomingMessage, res: ServerResponse, caller: unknown, body?: unknown) => {
    try {
      guard.check(req);
    } catch (err) {
      sendRefusal(res, err as { status: number; message: string });
      return;
    }
    try {
      if (req.method !== "POST") {
        throw new RpcError(405, -32000, "Method not allowed.", { allow: "POST" });
      }
      const accept = String(req.headers.accept ?? "");
      if (!accepts(accept, "application/json") || !accepts(accept, "text/event-stream")) {
        throw new RpcError(
          406,
          -32000,
          "Not Acceptable: Client must accept both application/json and text/event-stream",
        );
      }
      const type = String(req.headers["content-type"] ?? "")
        .split(";")[0]
        ?.trim()
        .toLowerCase();
      if (type !== "application/json") {
        throw new RpcError(415, -32000, "Unsupported Media Type: Content-Type must be application/json");
      }
      const version = req.headers["mcp-protocol-version"];
      if (typeof version === "string" && !(PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
        throw new RpcError(
          400,
          -32000,
          `Bad Request: Unsupported protocol version: ${version} (supported versions: ${PROTOCOL_VERSIONS.join(", ")})`,
        );
      }
      const msg = body !== undefined ? body : await readBody(req, maxBody);
      // one message per POST, as 2025-06-18 and later require; a batch is refused before any of it
      // runs, which is why 2025-03-26, the version that requires taking batches, is not negotiated
      if (Array.isArray(msg)) {
        throw new RpcError(
          400,
          -32600,
          "Invalid Request: batches are not supported, send one message per request",
        );
      }
      if (!isMessage(msg)) throw new RpcError(400, -32600, "Invalid Request: not a JSON-RPC 2.0 message");
      // notifications and responses are accepted with no body
      if (msg.method === undefined || msg.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      let reply: Record<string, unknown>;
      try {
        reply = { jsonrpc: "2.0", id: msg.id, result: await answer(msg, caller) };
      } catch (err) {
        if (!(err instanceof RpcError)) console.error("oneset: an MCP request failed", err);
        reply = {
          jsonrpc: "2.0",
          id: msg.id,
          error:
            err instanceof RpcError
              ? { code: err.rpcCode, message: err.message }
              : { code: -32603, message: "Internal error" },
        };
      }
      sendRpc(res, 200, reply);
    } catch (err) {
      if (err instanceof RpcError) {
        sendRpc(
          res,
          err.status,
          { jsonrpc: "2.0", error: { code: err.rpcCode, message: err.message }, id: null },
          err.headers,
        );
        return;
      }
      console.error("oneset: the MCP door failed", err);
      sendRpc(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  };
  return Object.assign(handle, { door: tools });
}
