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
    const req = request(
      { host: "127.0.0.1", port, method: opts.method ?? "GET", path: opts.path, headers, setHost: false },
      (res) => {
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
      // the server may close the socket after refusing an oversized body
      if (
        (err as NodeJS.ErrnoException).code === "ECONNRESET" ||
        (err as NodeJS.ErrnoException).code === "EPIPE"
      ) {
        return;
      }
      reject(err);
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
