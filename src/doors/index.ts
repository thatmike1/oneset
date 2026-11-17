// the doors: one mount on the app's own node:http server that serves the HTTP API, MCP, the
// CLI, the skill, the browser client, the change stream and the setup page, behind the guard
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AnyAction, DoorOptions, Registry } from "../core.ts";
import { ActionError } from "../errors.ts";
import { createGuard, type GuardOptions, isLoopback } from "./guard.ts";
import { mcp } from "./mcp.ts";
import { sendError, sendJson } from "./respond.ts";

export { createGuard, type Guard, type GuardOptions, isLoopback } from "./guard.ts";
export {
  LATEST_PROTOCOL_VERSION,
  type McpHandler,
  type McpOptions,
  mcp,
  mcpTools,
  PROTOCOL_VERSIONS,
} from "./mcp.ts";
export { errorBody } from "./respond.ts";

/** which of the kit's doors a caller is being resolved for */
export type DoorKind = "http" | "mcp" | "stream" | "skill";

type CallerOf<R> = R extends Registry<any, infer C, any, any, any> ? C : never;
type DefOf<R> = R extends Registry<any, any, any, any, infer Def> ? Def : AnyAction;

export type DoorSettings<Def = AnyAction, Caller = any> = Omit<DoorOptions<Def, Caller>, "name">;

interface BaseOptions<Def, Caller> extends GuardOptions {
  /** the app's name: the MCP server name, the CLI's file and command, the skill's name */
  name: string;
  /** how an agent should use the tools: MCP `instructions` and the skill's body */
  instructions?: string;
  /** when an agent should reach for them: the skill's trigger line */
  when?: string;
  /** moves every path under a prefix, e.g. `/kit` */
  base?: string;
  /**
   * the address the CLI, skill and setup page give out; by default the address the request
   * came to (`http://<Host>`)
   */
  url?: string;
  /** a non-loopback host with no `caller` refuses to start unless this is set */
  openWithoutSignIn?: boolean;
  /** options for the HTTP door: `list`, `describe`, `render`, `draft` */
  http?: DoorSettings<Def, Caller>;
  /** options for the MCP door: `list`, `describe`, `render`, `draft` (default draft-7), `version` */
  mcp?: DoorSettings<Def, Caller> & { version?: string };
}

/** resolves the caller for a request, or throws (an ActionError with headers for a challenge) */
export type ResolveCaller<Caller> = (req: IncomingMessage, door: DoorKind) => Caller | Promise<Caller>;

export type DoorsOptions<Def = AnyAction, Caller = any> = BaseOptions<Def, Caller> &
  (undefined extends Caller ? { caller?: ResolveCaller<Caller> } : { caller: ResolveCaller<Caller> });

export type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

interface Route {
  kind: "catalog" | "run" | "mcp";
  methods: string[];
  action?: string;
}

/**
 * mounts every door on the app's server: `if (await handle(req, res)) return;` answers the
 * kit's paths and returns false for the app's own
 */
export function doors<R extends Registry<any, any, any, any, any>>(
  reg: R,
  options: DoorsOptions<DefOf<R>, CallerOf<R>>,
): Handler {
  const opts = options as BaseOptions<AnyAction, unknown> & { caller?: ResolveCaller<unknown> };
  const base = opts.base ?? "";
  if (base !== "" && !/^(\/[^/]+)+$/.test(base)) {
    throw new Error(`oneset: base must start with a slash and not end with one, like "/kit" (got "${base}")`);
  }
  const foreign = (opts.hosts ?? []).filter((h) => !isLoopback(h));
  if (foreign.length > 0 && !opts.caller && !opts.openWithoutSignIn) {
    throw new Error(
      `oneset: ${foreign.join(", ")} is not a loopback host and there is no \`caller\`, so anyone could ` +
        "run every action. Pass a `caller` that signs requests in, or `openWithoutSignIn: true` if that is intended.",
    );
  }
  const guard = createGuard(opts);
  const registry = reg as Registry;
  const http = registry.door({ ...(opts.http as DoorSettings), name: "http" });
  const mcpHandle = mcp(registry, {
    ...(opts.mcp as DoorSettings),
    name: opts.name,
    ...(opts.instructions ? { instructions: opts.instructions } : {}),
    ...(opts.maxBody ? { maxBody: opts.maxBody } : {}),
  });
  const resolve = async (req: IncomingMessage, door: DoorKind) =>
    opts.caller ? opts.caller(req, door) : undefined;

  function route(path: string): Route | null {
    if (path === "/api/actions") return { kind: "catalog", methods: ["GET"] };
    // the MCP handler answers every method itself (GET and DELETE get its 405)
    if (path === "/mcp") return { kind: "mcp", methods: [] };
    const run = /^\/api\/actions\/([^/]+)$/.exec(path);
    if (run) return { kind: "run", methods: ["POST"], action: decodeURIComponent(run[1] ?? "") };
    return null;
  }

  return async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://localhost");
    let path = url.pathname;
    if (base) {
      if (path !== base && !path.startsWith(`${base}/`)) return false;
      path = path.slice(base.length) || "/";
    }
    const r = route(path);
    if (!r) return false;
    const method = req.method ?? "GET";
    try {
      guard.check(req);
      if (r.kind === "mcp") {
        await mcpHandle(req, res, await resolve(req, "mcp"));
        return true;
      }
      if (!r.methods.includes(method)) {
        throw new ActionError(405, "method_not_allowed", `${method} is not allowed here`, {
          headers: { allow: r.methods.join(", ") },
        });
      }
      if (r.kind === "catalog") {
        const caller = await resolve(req, "http");
        sendJson(res, 200, { app: opts.name, actions: http.catalog(caller) });
      } else {
        const input = await guard.readJson(req);
        const caller = await resolve(req, "http");
        const result = await http.run(r.action ?? "", input, caller);
        sendJson(res, 200, { result });
      }
    } catch (err) {
      sendError(res, err);
    }
    return true;
  };
}
