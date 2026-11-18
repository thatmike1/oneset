// the MCP door, hand-written: a stateless streamable-HTTP handler with initialize (version
// negotiation and instructions), tools/list, tools/call and ping. Notifications get 202, GET 405.
// Protocol errors stay JSON-RPC errors; a failed tool call, an unknown tool and invalid arguments
// come back as tool results with isError, as the official SDK does.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AnyAction, Door, DoorOptions, Registry } from "../core.ts";
import { errorShape } from "../errors.ts";
import { createGuard, type GuardOptions } from "./guard.ts";

/** the protocol versions this door speaks, newest first */
export const PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
] as const;
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
    maxBody = 1024 * 1024,
    draft = "draft-7",
    hosts,
    origins,
    ...door
  } = options as McpOptions;
  // the same guard doors() puts in front of every path, so a standalone mount keeps it
  const guard = createGuard({ ...(hosts ? { hosts } : {}), ...(origins ? { origins } : {}) });
  const tools = (reg as Registry).door({ ...door, draft, name: "mcp" });
  const byTool = new Map((reg as Registry).actions.map((def) => [def.name.replaceAll(".", "_"), def]));

  async function callTool(params: Record<string, unknown>, caller: unknown): Promise<unknown> {
    const tool = params.name;
    if (typeof tool !== "string")
      throw new RpcError(200, -32602, "Invalid params: tools/call needs a tool name");
    const args = params.arguments ?? {};
    const def = byTool.get(tool);
    try {
      const rendered = await tools.run(def ? def.name : tool, args, caller);
      return { content: [{ type: "text", text: toolText(rendered) }] };
    } catch (err) {
      const shape = errorShape(err);
      if (!shape) console.error("oneset: an MCP tool call failed", err);
      const text = shape ? `${shape.code}: ${shape.message}` : "internal: something broke on the server";
      return { content: [{ type: "text", text }], isError: true };
    }
  }

  async function answer(msg: Message, caller: unknown): Promise<unknown> {
    const params = msg.params ?? {};
    switch (msg.method) {
      case "initialize": {
        const asked = params.protocolVersion;
        const protocolVersion =
          typeof asked === "string" && (PROTOCOL_VERSIONS as readonly string[]).includes(asked)
            ? asked
            : LATEST_PROTOCOL_VERSION;
        const result: Record<string, unknown> = {
          protocolVersion,
          capabilities: { tools: { listChanged: true } },
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
      if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
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
      // one message per POST since 2025-06-18; a batch is refused before any of it runs
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
