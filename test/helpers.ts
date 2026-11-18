// test helpers: a server on a free loopback port and raw requests that can set any header
import { createServer, type IncomingMessage, request, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface Served {
  url: string;
  port: number;
  server: Server;
  close(): Promise<void>;
}

/** mounts a kit handler in front of an app route that answers 404 "app" */
export async function serve(
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>,
  host = "127.0.0.1",
): Promise<Served> {
  const server = createServer(async (req, res) => {
    if (await handle(req, res)) return;
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("app");
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${host === "::1" ? "[::1]" : host}:${port}`,
    port,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json(): any;
}

/** a request with full control over headers (fetch keeps Host to itself) */
export function raw(
  port: number,
  opts: {
    method?: string;
    path: string;
    headers?: Record<string, string>;
    body?: string | Buffer;
    /** send the body in pieces with no content-length */
    chunked?: boolean;
  },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: `127.0.0.1:${port}`, ...opts.headers };
    if (opts.body !== undefined && !opts.chunked)
      headers["content-length"] = String(Buffer.byteLength(opts.body));
    let responded = false;
    let dropped: Error | null = null;
    const req = request(
      { host: "127.0.0.1", port, method: opts.method ?? "GET", path: opts.path, headers, setHost: false },
      (res) => {
        responded = true;
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) });
        });
        res.on("error", reject);
      },
    );
    req.on("error", (err) => {
      // the server may close the socket after refusing an oversized body, while the answer it
      // sent first is still on its way; a drop with no answer at all fails on close below
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ECONNRESET" || code === "EPIPE") {
        dropped = err;
        return;
      }
      reject(err);
    });
    req.on("close", () => {
      if (!responded) reject(dropped ?? new Error(`the server closed ${opts.path} with no answer`));
    });
    if (opts.body !== undefined) {
      if (opts.chunked) {
        const body = Buffer.from(opts.body);
        for (let i = 0; i < body.length; i += 1024) req.write(body.subarray(i, i + 1024));
      } else {
        req.write(opts.body);
      }
    }
    req.end();
  });
}

export const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** splits a server-sent event stream into { event, data } blocks */
async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let at = buf.indexOf("\n\n");
    while (at >= 0) {
      const block = buf.slice(0, at);
      buf = buf.slice(at + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (data.length > 0) yield { event, data: data.join("\n") };
      at = buf.indexOf("\n\n");
    }
  }
}

/** reads the change stream with fetch; `next()` waits for the next event or times out */
export async function openEvents(url: string, headers: Record<string, string> = {}) {
  const controller = new AbortController();
  const res = await fetch(url, {
    headers: { accept: "text/event-stream", ...headers },
    signal: controller.signal,
  });
  if (!res.body) throw new Error("no body");
  const queue: { event: string; data: string }[] = [];
  const waiting: ((e: { event: string; data: string } | null) => void)[] = [];
  void (async () => {
    try {
      for await (const e of sseEvents(res.body!)) {
        const w = waiting.shift();
        if (w) w(e);
        else queue.push(e);
      }
    } catch {}
  })();
  return {
    status: res.status,
    headers: res.headers,
    next(ms = 1000): Promise<{ event: string; data: string } | null> {
      const queued = queue.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiting.splice(waiting.indexOf(done), 1);
          resolve(null);
        }, ms);
        const done = (e: { event: string; data: string } | null) => {
          clearTimeout(timer);
          resolve(e);
        };
        waiting.push(done);
      });
    },
    close: () => controller.abort(),
  };
}

/** a small EventSource on fetch for the browser client in tests: open, named events, reconnects */
export class FetchEventSource {
  readonly url: string;
  private readonly listeners = new Map<string, Set<(e: { data: string }) => void>>();
  private closed = false;
  private controller: AbortController | null = null;
  opens = 0;

  constructor(url: string, _init?: unknown) {
    this.url = url;
    void this.run();
  }

  addEventListener(type: string, fn: (e: { data: string }) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
  }

  close(): void {
    this.closed = true;
    this.controller?.abort();
  }

  private dispatch(type: string, data: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ data });
  }

  private async run(): Promise<void> {
    while (!this.closed) {
      this.controller = new AbortController();
      try {
        const res = await fetch(this.url, {
          headers: { accept: "text/event-stream" },
          signal: this.controller.signal,
        });
        if (res.ok && res.body) {
          this.opens++;
          this.dispatch("open", "");
          for await (const e of sseEvents(res.body)) this.dispatch(e.event, e.data);
        }
      } catch {}
      if (!this.closed) await sleep(30);
    }
  }
}
