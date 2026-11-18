// types for the browser client (browser.js, served at /actions.js and exported as `oneset/client`)

/** what `onChange` listeners hear */
export type ClientChange =
  | { action: string; door: string; job?: string; connected?: never; reconnected?: never }
  | { connected: true; action?: never; reconnected?: never }
  | { reconnected: true; action?: never; connected?: never };

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
  /** default the global EventSource */
  EventSource?: new (
    url: string,
    init?: { withCredentials?: boolean },
  ) => EventSourceLike;
}

type AnyActions = Record<string, { input: any; output: any }>;

/** a client; type it with `createClient<ActionsOf<typeof reg>>()` */
export interface Client<A extends AnyActions = AnyActions> {
  /** runs an action and returns its result; a failure throws an ActionError with status and code */
  act<N extends keyof A & string>(name: N, input?: A[N]["input"]): Promise<A[N]["output"]>;
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
