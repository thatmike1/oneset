// the browser client, served at /actions.js and exported as `oneset/client`: `act(name, input)`
// runs an action as the page's person, and `onChange(fn)` hears every change, from this page,
// another one or an agent.
//   import { act, onChange } from "/actions.js";
//   onChange(() => refresh());
//   await act("note.add", { text: "milk" });
// `createClient({ url, fetch, EventSource })` makes another one, for a module that node tests
// import or a page that talks to an app at another address.

// oneset:settings
const SETTINGS = { url: "" };

// served from the app, the module finds the app next to itself; loaded any other way it uses
// the address it was served from, and the package's own copy the page's origin
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

/** a client for the app at `url` (default: the page's own origin, or where this file came from) */
export function createClient(options = {}) {
  const root = (options.url ?? ROOT).replace(/\/$/, "");
  const doFetch = options.fetch ?? ((...args) => globalThis.fetch(...args));
  const Source = options.EventSource;

  async function request(method, path, body) {
    const res = await doFetch(`${root}${path}`, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // an error body may be anything the app chose, null included
      const error = data?.error ?? {};
      throw new ActionError(
        res.status,
        error.code ?? "http",
        error.message ?? `HTTP ${res.status}`,
        error.issues,
      );
    }
    return data;
  }

  /**
   * runs an action and returns its result; a failure throws an ActionError with status and code.
   * A long action answers with a job, which this waits for; `{ wait: false }` returns the job
   */
  async function act(name, input = {}, options = {}) {
    const data = await request("POST", `/api/actions/${encodeURIComponent(name)}`, input);
    if (!data?.job) return data?.result;
    if (options.wait === false) return data.job;
    // the start's answer carries no result, so the job is read at least once
    const { id } = data.job;
    let job;
    do {
      job = (await request("POST", "/api/actions/job.get", { id })).result;
    } while (job.state === "running");
    if (job.state === "failed") {
      const error = job.error ?? {};
      throw new ActionError(
        error.status ?? 500,
        error.code ?? "failed",
        error.message ?? "the job failed",
        error.issues,
      );
    }
    return job.result;
  }

  /** the actions this page may run, with their input schemas */
  async function actions() {
    return (await request("GET", "/api/actions")).actions;
  }

  const listeners = new Set();
  let source = null;
  // opened: the stream has been live at least once; live: it is live right now
  let opened = false;
  let live = false;

  function deliver(fn, change) {
    const failed = (err) => console.error("onChange listener failed", err);
    try {
      // an async listener's rejection is caught too, without waiting for it
      const out = fn(change);
      if (out && typeof out.then === "function") Promise.resolve(out).catch(failed);
    } catch (err) {
      failed(err);
    }
  }

  function notify(change) {
    for (const fn of listeners) deliver(fn, change);
  }

  function connect() {
    const EventSourceClass = Source ?? globalThis.EventSource;
    source = new EventSourceClass(`${root}/api/actions/stream`, { withCredentials: true });
    source.addEventListener("change", (event) => {
      let change = {};
      try {
        change = JSON.parse(event.data);
      } catch {}
      notify(change);
    });
    // a change between the page's first fetch and the stream going live, or during a drop, is
    // only caught by refetching, so listeners hear the stream open as well as every change
    source.addEventListener("open", () => {
      live = true;
      notify(opened ? { reconnected: true } : { connected: true });
      opened = true;
    });
    // EventSource retries by itself; the next open tells every listener it is back
    source.addEventListener("error", () => {
      live = false;
    });
  }

  /**
   * calls `fn` after every change: `{ action, door }` for a run of an action this caller may run,
   * `{ changed: true }` for one it may not (something it shows may still have changed),
   * `{ connected: true }` once the stream is live (right away for a listener added after that),
   * `{ reconnected: true }` when it comes back after a drop. A listener that keeps fetched state
   * refetches on all of them; one that waits for a particular action refetches on any without one.
   * Returns a function that stops listening.
   */
  function onChange(fn) {
    listeners.add(fn);
    if (!source) connect();
    else if (live) {
      queueMicrotask(() => {
        if (listeners.has(fn)) deliver(fn, { connected: true });
      });
    }
    return () => {
      listeners.delete(fn);
      if (listeners.size === 0 && source) {
        source.close();
        source = null;
        opened = false;
        live = false;
      }
    };
  }

  return { act, actions, onChange };
}

// the page's own client; it connects to nothing until a function is called
let page = null;
const pageClient = () => {
  page ??= createClient();
  return page;
};

/** runs an action and returns its result, waiting for a long one's job; see the client's `act` */
export const act = (name, input, options) => pageClient().act(name, input, options);
/** the actions this page may run, with their input schemas */
export const actions = () => pageClient().actions();
/** calls `fn` after every change; returns a function that stops listening */
export const onChange = (fn) => pageClient().onChange(fn);
