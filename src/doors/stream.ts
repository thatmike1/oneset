// the change stream: server-sent events, one `change` event after every mutating run that
// succeeds at the outermost level, so an open page refetches when an agent changes something
import type { IncomingMessage, ServerResponse } from "node:http";
import type { BareChange, Change, ChangeSource, Registry } from "../core.ts";

/** how often a comment line keeps idle proxies from closing the stream */
export const PING_MS = 25_000;

/** `heard` decides what this subscriber may know of each change; null sends nothing */
export function openStream(
  reg: Registry,
  req: IncomingMessage,
  res: ServerResponse,
  heard: (change: Change, from: ChangeSource) => Change | BareChange | null = (change) => change,
): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(": connected\n\n");
  const off = reg.onChange((change, from) => {
    const sent = heard(change, from);
    if (sent && !res.writableEnded) res.write(`event: change\ndata: ${JSON.stringify(sent)}\n\n`);
  });
  const ping = setInterval(() => {
    if (!res.writableEnded) res.write(": ping\n\n");
  }, PING_MS);
  ping.unref();
  const stop = () => {
    clearInterval(ping);
    off();
  };
  req.on("close", stop);
  res.on("close", stop);
}
