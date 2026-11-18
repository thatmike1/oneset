// sending answers: JSON bodies, any thrown error rendered by status, code, message and issues
import type { ServerResponse } from "node:http";
import { errorShape } from "../errors.ts";

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(text);
}

export function sendText(
  res: ServerResponse,
  status: number,
  type: string,
  text: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-cache", ...headers });
  res.end(text);
}

/** the wire format for a failure: `{ error: { code, message, issues? } }`, or the error's own body */
export function errorBody(err: unknown): { status: number; body: unknown; headers: Record<string, string> } {
  const shape = errorShape(err);
  if (!shape) {
    console.error("oneset: an action failed", err);
    return {
      status: 500,
      body: { error: { code: "internal", message: "something broke on the server" } },
      headers: {},
    };
  }
  const error: Record<string, unknown> = { code: shape.code, message: shape.message };
  if (shape.issues !== undefined) error.issues = shape.issues;
  return {
    status: shape.status,
    body: shape.body !== undefined ? shape.body : { error },
    headers: shape.headers ?? {},
  };
}

export function sendError(res: ServerResponse, err: unknown): void {
  const out = errorBody(err);
  if (res.headersSent) {
    res.end();
    return;
  }
  sendJson(res, out.status, out.body, out.headers);
}
