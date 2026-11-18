// the one error type apps throw and every door renders by status, code, message and issues

export interface ActionErrorExtra {
  /** validation issues, sent with the error */
  issues?: unknown;
  /** a response body to send instead of the plain error (an answer a client already understands) */
  body?: unknown;
  /** response headers, such as a WWW-Authenticate on a refused caller */
  headers?: Record<string, string>;
}

export class ActionError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues?: unknown;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;

  constructor(status: number, code: string, message: string, extra: ActionErrorExtra = {}) {
    super(message);
    this.name = "ActionError";
    this.status = status;
    this.code = code;
    if (extra.issues !== undefined) this.issues = extra.issues;
    if (extra.body !== undefined) this.body = extra.body;
    if (extra.headers !== undefined) this.headers = extra.headers;
  }
}

/** what a door needs to render any thrown error; plain errors become a 500 */
export interface RenderedError {
  status: number;
  code: string;
  message: string;
  issues?: unknown;
  body?: unknown;
  headers?: Record<string, string>;
}

/** reads status, code, message and issues off anything thrown, ActionError or not */
export function errorShape(err: unknown): RenderedError | null {
  if (err === null || typeof err !== "object") return null;
  const e = err as Partial<RenderedError>;
  if (typeof e.status !== "number" || typeof e.code !== "string") return null;
  const out: RenderedError = { status: e.status, code: e.code, message: String(e.message ?? e.code) };
  if (e.issues !== undefined) out.issues = e.issues;
  // an explicit null is a body too; only a missing one means the default envelope
  if (e.body !== undefined) out.body = e.body;
  if (e.headers !== undefined) out.headers = e.headers;
  return out;
}
