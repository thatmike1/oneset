// the browser client, served at /actions.js: `act(name, input)` runs an action as the page's
// person, and `onChange(fn)` hears every change, from this page, another one or an agent.
//   import { act, onChange } from "/actions.js";
//   onChange(() => refresh());
//   await act("note.add", { text: "milk" });

// oneset:settings
const SETTINGS = { url: "http://localhost:3000" };

// served from the app, the module finds the app next to itself; loaded any other way it uses
// the address it was served from
const ROOT = import.meta.url.startsWith("http")
  ? new URL(".", import.meta.url).href.slice(0, -1)
  : SETTINGS.url;

export class ActionError extends Error {
  constructor(status, code, message, issues) {
    super(message);
    this.name = "ActionError";
    this.status = status;
    this.code = code;
    if (issues !== undefined) this.issues = issues;
  }
}

async function request(method, path, body) {
  const res = await fetch(`${ROOT}${path}`, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = data.error ?? {};
    throw new ActionError(
      res.status,
      error.code ?? "http",
      error.message ?? `HTTP ${res.status}`,
      error.issues,
    );
  }
  return data;
}

/** runs an action and returns its result; a failure throws an ActionError with status and code */
export async function act(name, input = {}) {
  const data = await request("POST", `/api/actions/${encodeURIComponent(name)}`, input);
  return data.result;
}

/** the actions this page may run, with their input schemas */
export async function actions() {
  return (await request("GET", "/api/actions")).actions;
}

const listeners = new Set();
let source = null;
let opened = false;

function notify(change) {
  const failed = (err) => console.error("onChange listener failed", err);
  for (const fn of listeners) {
    try {
      // an async listener's rejection is caught too, without waiting for it
      const out = fn(change);
      if (out && typeof out.then === "function") Promise.resolve(out).catch(failed);
    } catch (err) {
      failed(err);
    }
  }
}

function connect() {
  source = new EventSource(`${ROOT}/api/actions/stream`, { withCredentials: true });
  source.addEventListener("change", (event) => {
    let change = {};
    try {
      change = JSON.parse(event.data);
    } catch {}
    notify(change);
  });
  // a reconnect may have missed changes, so listeners refetch then too
  source.addEventListener("open", () => {
    if (opened) notify({ reconnected: true });
    opened = true;
  });
}

/**
 * calls `fn` after every change: `{ action, door }` for a run, `{ reconnected: true }` when the
 * stream comes back after a drop. Returns a function that stops listening.
 */
export function onChange(fn) {
  listeners.add(fn);
  if (!source) connect();
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0 && source) {
      source.close();
      source = null;
      opened = false;
    }
  };
}
