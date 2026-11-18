// the guard every app used to hand-write: foreign Host and Origin refused, JSON bodies only,
// bodies capped. Always on, with or without sign-in; a request with no Origin passes, since
// agents and CLIs send none
import type { IncomingMessage } from "node:http";
import { ActionError } from "../errors.ts";

export interface GuardOptions {
  /** Host names to accept besides the loopback names on the listening port, e.g. `notes.example.com` */
  hosts?: string[];
  /** Origins to accept besides the accepted hosts' own, e.g. a connector's `https://chatgpt.com` */
  origins?: string[];
  /** the largest body accepted, in bytes; default 1 MiB */
  maxBody?: number;
}

const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];

/** whether a host name (with or without a port) is a loopback name */
export function isLoopback(host: string): boolean {
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : (host.split(":")[0] ?? "");
  return name === "localhost" || name === "[::1]" || /^127(\.\d{1,3}){3}$/.test(name);
}

export interface Guard {
  /** throws for a foreign Host or Origin */
  check(req: IncomingMessage): void;
  /** reads a JSON body: JSON content type only, size capped, `{}` when empty */
  readJson(req: IncomingMessage): Promise<unknown>;
}

/** the body cap, checked once so every door reads the same number: a whole number of bytes, 0 or more */
export function maxBodyOf(options: { maxBody?: number | undefined }): number {
  const maxBody = options.maxBody ?? 1024 * 1024;
  if (!Number.isSafeInteger(maxBody) || maxBody < 0) {
    throw new Error(`oneset: maxBody must be a whole number of bytes, 0 or more (got ${maxBody})`);
  }
  return maxBody;
}

export function createGuard(options: GuardOptions = {}): Guard {
  const maxBody = maxBodyOf(options);
  const extraHosts = new Set((options.hosts ?? []).map((h) => h.toLowerCase()));
  const extraOrigins = new Set((options.origins ?? []).map((o) => o.toLowerCase().replace(/\/$/, "")));

  function hostAllowed(host: string, port: number | undefined): boolean {
    const h = host.toLowerCase();
    if (extraHosts.has(h)) return true;
    for (const name of LOOPBACK) {
      if (h === `${name}:${port}`) return true;
      if (port === 80 && h === name) return true;
    }
    return false;
  }

  function check(req: IncomingMessage): void {
    const port = req.socket.localPort;
    const host = req.headers.host ?? "";
    if (!hostAllowed(host, port)) {
      throw new ActionError(403, "foreign_host", `requests for host ${host || "(none)"} are refused here`);
    }
    const origin = req.headers.origin;
    if (origin === undefined) return;
    const o = origin.toLowerCase();
    if (extraOrigins.has(o)) return;
    let originHost: string | null = null;
    try {
      const url = new URL(o);
      const web = url.protocol === "http:" || url.protocol === "https:";
      // only a serialized origin, scheme, host and an optional port, as a browser sends it: a URL
      // with credentials, a path, a query or a non-canonical host is not one, though its host may match
      const defaultPort = url.protocol === "http:" ? "80" : "443";
      if (web && (o === url.origin || o === `${url.origin}:${defaultPort}`)) originHost = url.host;
    } catch {}
    // URL drops a default port, so compare against the bare name for :80 and :443 too
    if (originHost && (hostAllowed(originHost, port) || extraHosts.has(originHost))) return;
    throw new ActionError(403, "foreign_origin", `requests from ${origin} are refused here`);
  }

  async function readJson(req: IncomingMessage): Promise<unknown> {
    const type = String(req.headers["content-type"] ?? "")
      .split(";")[0]
      ?.trim()
      .toLowerCase();
    if (type !== "application/json") {
      throw new ActionError(415, "json_only", "send a JSON body with content-type application/json");
    }
    const tooLarge = () =>
      new ActionError(413, "too_large", `the body is larger than ${maxBody} bytes`, {
        headers: { connection: "close" },
      });
    const declared = Number(req.headers["content-length"] ?? Number.NaN);
    if (declared > maxBody) throw tooLarge();
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > maxBody) throw tooLarge();
      chunks.push(chunk as Buffer);
    }
    if (size === 0) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new ActionError(400, "bad_json", "the body is not valid JSON");
    }
  }

  return { check, readJson };
}
