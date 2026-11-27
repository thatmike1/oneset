// types for the browser client (browser.js, served at /actions.js and exported as `oneset/client`)

/**
 * what `onChange` listeners hear. Anything without an `action` (a change to an action this caller
 * may not run, the stream going live, the stream coming back) is a reason to refetch
 */
export type ClientChange =
  | { action: string; door: string; job?: string; changed?: never; connected?: never; reconnected?: never }
  | { changed: true; action?: never; connected?: never; reconnected?: never }
  | { connected: true; action?: never; changed?: never; reconnected?: never }
  | { reconnected: true; action?: never; changed?: never; connected?: never };

/** an action in the catalog, as `actions()` returns it */
export interface ClientCatalogEntry {
  name: string;
  tool: string;
  area: string;
  summary: string;
  mutates: boolean;
  long?: true;
  inputSchema: Record<string, unknown>;
}

/** the part of EventSource the client uses */
export interface EventSourceLike {
  addEventListener(type: string, listener: (event: { data: string }) => void): void;
  close(): void;
}

export interface ClientOptions {
  /** the app's address, base included; default the page's own origin, or where /actions.js came from */
  url?: string;
  /** default the global fetch */
  fetch?: (
    url: string,
    init: Record<string, unknown>,
  ) => Promise<{
    ok: boolean;
    status: number;
    json(): Promise<any>;
  }>;
  /**
   * headers sent with every action and catalog request, e.g. `{ authorization: "Bearer …" }` for
   * a server calling another app with a key. Not on the change stream: EventSource sends none
   */
  headers?: Record<string, string>;
  /** default the global EventSource */
  EventSource?: new (
    url: string,
    init?: { withCredentials?: boolean },
  ) => EventSourceLike;
}

type AnyActions = Record<string, { input: any; output: any }>;

/** a long action's job, as `act(name, input, { wait: false })` and `act("job.get", { id })` return it */
export interface ClientJob {
  id: string;
  action: string;
  state: "running" | "done" | "failed";
  started: string;
  finished?: string;
  result?: unknown;
  error?: { status: number; code: string; message: string; issues?: unknown; body?: unknown };
}

/** a client; type it with `createClient<ActionsOf<typeof reg>>()` */
export interface Client<A extends AnyActions = AnyActions> {
  /**
   * runs an action and returns its result; a failure throws an ActionError with status and code.
   * A long action's job is waited for; `{ wait: false }` returns the job instead (an ordinary
   * action still answers its result, so that call's type is either)
   */
  act<N extends keyof A & string>(
    name: N,
    input?: A[N]["input"],
    options?: { wait?: true },
  ): Promise<A[N]["output"]>;
  act<N extends keyof A & string>(
    name: N,
    input: A[N]["input"],
    options: { wait: false },
  ): Promise<ClientJob | A[N]["output"]>;
  /** reads a long action's job, waiting up to `wait` seconds (default 30) for it to finish */
  act(name: "job.get", input: { id: string; wait?: number }): Promise<ClientJob>;
  /** the actions this page may run, with their input schemas */
  actions(): Promise<ClientCatalogEntry[]>;
  /** calls `fn` after every change; returns a function that stops listening */
  onChange(fn: (change: ClientChange) => unknown): () => void;
}

export declare class ActionError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues?: unknown;
  constructor(status: number, code: string, message: string, issues?: unknown);
}

export declare function createClient<A extends AnyActions = AnyActions>(options?: ClientOptions): Client<A>;
export declare const act: Client["act"];
export declare const actions: Client["actions"];
export declare const onChange: Client["onChange"];
