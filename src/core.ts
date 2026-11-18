// the core: definitions, the registry, the run chain (allow, schema, around) and doors made with
// reg.door. It never awaits: a sync chain returns a value, an async one a promise.
import { z } from "zod";
import { ActionError } from "./errors.ts";

/** which JSON Schema draft a door shows input schemas in */
export type Draft = "draft-2020-12" | "draft-7";

/** where a run came from: the door's name, and whether it runs inside another run */
export interface RunInfo {
  nested: boolean;
  door: string;
}

/** an action: name, area, summary, zod input, `mutates` and `run`, plus any fields the app adds */
export interface ActionDef<
  Nm extends string = string,
  I extends z.ZodObject = z.ZodObject,
  O = unknown,
  Ctx = any,
> {
  name: Nm;
  /** a group for catalogs and help */
  area: string;
  /** one line: what it does, written for an agent reading a tool list */
  summary: string;
  input: I;
  /** false for reads; a successful mutating run sends a change event */
  mutates: boolean;
  /** the app's own access string; the kit never reads it */
  access?: string;
  run(input: z.output<I>, ctx: Ctx): O;
}

/** any definition, whatever its input, output and context */
export type AnyAction = ActionDef<string, any, any, any>;

/** the two errors the kit raises itself, handed to the `error` hook */
export type KitProblem<Def = AnyAction> =
  | { kind: "unknown_action"; name: string }
  | { kind: "invalid_input"; def: Def; error: z.ZodError };

export interface Hooks<Caller = any, RunCtx = any, Def = AnyAction> {
  /** the input the doors show and validate; by default the definition's own */
  schema?(def: Def): z.ZodObject;
  /**
   * returns nothing, or throws the app's own error. It decides synchronously: one that returns a
   * promise refuses every call (resolve async facts in the caller resolver)
   */
  allow?(def: Def, caller: Caller): undefined;
  /**
   * wraps the handler: `next(input, ctx)` runs it. May change the input, build the context,
   * call `next` more than once and return something other than the handler's result
   */
  around?(
    def: Def,
    input: Record<string, unknown>,
    caller: Caller,
    next: (input: Record<string, unknown>, ctx: RunCtx) => unknown,
    info: RunInfo,
  ): unknown;
  /** turns the kit's own two errors into the app's */
  error?(problem: KitProblem<Def>): Error;
}

/** what a door shows for an action */
export interface Description {
  summary: string;
  /** MCP only */
  title?: string;
  /** MCP only; the default is `{ readOnlyHint: !mutates }` */
  annotations?: Record<string, unknown>;
}

export interface DoorOptions<Def = AnyAction, Caller = any> {
  /** what `info.door` carries for runs through this door */
  name: string;
  /** narrows what the door lists, and so what it lets through; `allow` must pass too */
  list?(def: Def, caller: Caller): boolean;
  describe?(def: Def, caller: Caller): Description;
  /** turns a run's outcome into what the door sends; the default sends it as is, as JSON */
  render?(def: Def, outcome: unknown): unknown;
  /** default draft-2020-12 */
  draft?: Draft;
}

export type JsonSchema = Record<string, unknown> & {
  $schema?: string;
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
};

/** one action in a catalog, the wire format every door shares */
export interface CatalogEntry {
  name: string;
  /** the name as an MCP tool: dots become underscores */
  tool: string;
  area: string;
  summary: string;
  mutates: boolean;
  inputSchema: JsonSchema;
}

export interface Door<Def = AnyAction, Caller = any> {
  readonly name: string;
  readonly draft: Draft;
  /** whether this caller may see, and so call, this action here */
  lists(def: Def, caller: Caller): boolean;
  listed(caller: Caller): Def[];
  describe(def: Def, caller: Caller): Description;
  inputSchema(def: Def): JsonSchema;
  catalog(caller: Caller): CatalogEntry[];
  /** runs a listed action and renders its outcome; refuses a name it does not list */
  run(name: string, input: unknown, caller: Caller): unknown;
}

/** what change listeners hear after a mutating run succeeds at the outermost level */
export interface Change {
  action: string;
  door: string;
}

/** zod types an empty object's input as Record<string, never>, which no extra field fits */
type Clean<T> = string extends keyof T ? {} : T;
type InputOf<D extends AnyAction, N> = Clean<z.input<Extract<D, { name: N }>["input"]>>;
type OutputOf<D extends AnyAction, N> = ReturnType<Extract<D, { name: N }>["run"]>;
type RunOutput<H, D extends AnyAction, N> = "around" extends keyof H
  ? NonNullable<H["around" & keyof H]> extends (...args: any[]) => infer R
    ? R
    : unknown
  : OutputOf<D, N>;

export interface Registry<
  D extends AnyAction = AnyAction,
  Caller = any,
  ExtraInput = {},
  H = {},
  Def = AnyAction,
> {
  readonly actions: readonly D[];
  get(name: string): D | undefined;
  /** the input schema doors show and validate, after the `schema` hook */
  schema(def: Def): z.ZodObject;
  /** true when `allow` does not throw for this caller */
  allows(def: Def, caller: Caller): boolean;
  run<N extends D["name"]>(
    name: N,
    input: InputOf<D, N> & ExtraInput,
    caller: Caller,
    info?: Partial<RunInfo>,
  ): RunOutput<H, D, N>;
  door(options: DoorOptions<Def, Caller>): Door<Def, Caller>;
  /** the error for a name no action has, after the app's `error` hook, as a run would throw it */
  unknown(name: string): Error;
  /**
   * hears every successful outermost mutating run, async ones once they resolve. A listener that
   * throws or rejects is logged and never breaks the run or the other listeners
   */
  onChange(listener: (change: Change) => unknown): () => void;
}

/** what a client needs: every action's input and its awaited output, by name */
export type ActionsOf<R> =
  R extends Registry<infer D, any, infer X, any, any>
    ? {
        [A in D as A["name"]]: {
          input: Clean<z.input<A["input"]>> & X;
          output: Awaited<ReturnType<A["run"]>>;
        };
      }
    : never;

export const toolName = (name: string): string => name.replaceAll(".", "_");

const isThenable = (v: unknown): v is PromiseLike<unknown> =>
  v !== null &&
  (typeof v === "object" || typeof v === "function") &&
  typeof (v as { then?: unknown }).then === "function";

function defaultProblem(problem: KitProblem<AnyAction>): Error {
  if (problem.kind === "unknown_action") {
    return new ActionError(404, "unknown_action", `no action named ${problem.name}`);
  }
  return new ActionError(400, "invalid_input", z.prettifyError(problem.error), {
    issues: problem.error.issues,
  });
}

export function buildRegistry(definitions: readonly AnyAction[], hooks: Hooks = {}): Registry {
  const byName = new Map<string, AnyAction>();
  const tools = new Map<string, string>();
  for (const def of definitions) {
    if (!def || typeof def.name !== "string" || def.name === "") throw new Error("an action needs a name");
    if (byName.has(def.name)) throw new Error(`action ${def.name} is defined twice`);
    const tool = toolName(def.name);
    const clash = tools.get(tool);
    if (clash) throw new Error(`actions ${clash} and ${def.name} both become the tool ${tool}`);
    byName.set(def.name, def);
    tools.set(tool, def.name);
  }

  const schemas = new WeakMap<AnyAction, z.ZodObject>();
  const schemaOf = (def: AnyAction): z.ZodObject => {
    let s = schemas.get(def);
    if (!s) {
      s = hooks.schema ? hooks.schema(def) : (def.input as z.ZodObject);
      schemas.set(def, s);
    }
    return s;
  };
  const problem = (p: KitProblem<AnyAction>): Error => (hooks.error ?? defaultProblem)(p);

  const listeners = new Set<(change: Change) => unknown>();
  const emit = (change: Change): void => {
    const failed = (err: unknown) => console.error("oneset: a change listener failed", err);
    for (const fn of listeners) {
      try {
        // an async listener's rejection is caught too, without waiting for it
        const out: unknown = fn(change);
        if (isThenable(out)) Promise.resolve(out).catch(failed);
      } catch (err) {
        failed(err);
      }
    }
  };

  /**
   * calls allow once. It must decide synchronously: a promise it returns is a refusal that would
   * arrive after the run had started, so the kit refuses the call instead and drops the promise
   */
  function authorize(def: AnyAction, caller: unknown): void {
    const out: unknown = hooks.allow?.(def, caller);
    if (isThenable(out)) {
      Promise.resolve(out).catch(() => {});
      throw new Error(
        `oneset: allow returned a promise for ${def.name}; it must throw or return synchronously ` +
          "(resolve what it needs in the caller resolver instead)",
      );
    }
  }

  function run(name: string, input: unknown, caller: unknown, info?: Partial<RunInfo>): unknown {
    const def = byName.get(name);
    if (!def) throw problem({ kind: "unknown_action", name });
    authorize(def, caller);
    return runAllowed(def, input, caller, info);
  }

  /** validation, around and the handler, for a call allow already passed */
  function runAllowed(def: AnyAction, input: unknown, caller: unknown, info?: Partial<RunInfo>): unknown {
    const runInfo: RunInfo = { nested: info?.nested ?? false, door: info?.door ?? "direct" };
    const parsed = schemaOf(def).safeParse(input ?? {});
    if (!parsed.success) throw problem({ kind: "invalid_input", def, error: parsed.error });
    const data = parsed.data as Record<string, unknown>;
    const out = hooks.around
      ? hooks.around(def, data, caller, (i, ctx) => def.run(i, ctx), runInfo)
      : def.run(data, caller);
    if (!def.mutates || runInfo.nested || listeners.size === 0) return out;
    const change: Change = { action: def.name, door: runInfo.door };
    if (isThenable(out)) {
      return Promise.resolve(out).then((value) => {
        emit(change);
        return value;
      });
    }
    emit(change);
    return out;
  }

  function allows(def: AnyAction, caller: unknown): boolean {
    if (!hooks.allow) return true;
    try {
      authorize(def, caller);
      return true;
    } catch {
      return false;
    }
  }

  function door(options: DoorOptions): Door {
    const draft = options.draft ?? "draft-2020-12";
    const json = new WeakMap<AnyAction, JsonSchema>();
    const lists = (def: AnyAction, caller: unknown) =>
      allows(def, caller) && (options.list ? options.list(def, caller) : true);
    const describe = (def: AnyAction, caller: unknown): Description =>
      options.describe
        ? options.describe(def, caller)
        : { summary: def.summary, annotations: { readOnlyHint: !def.mutates } };
    const inputSchema = (def: AnyAction): JsonSchema => {
      let s = json.get(def);
      if (!s) {
        s = z.toJSONSchema(schemaOf(def), { target: draft, io: "input" }) as JsonSchema;
        json.set(def, s);
      }
      return s;
    };
    const render = (def: AnyAction, outcome: unknown) =>
      options.render ? options.render(def, outcome) : outcome;
    const listed = (caller: unknown) => [...byName.values()].filter((def) => lists(def, caller));
    return {
      name: options.name,
      draft,
      lists,
      listed,
      describe,
      inputSchema,
      catalog: (caller) =>
        listed(caller).map((def) => ({
          name: def.name,
          tool: toolName(def.name),
          area: def.area,
          summary: describe(def, caller).summary,
          mutates: def.mutates,
          inputSchema: inputSchema(def),
        })),
      run(name, input, caller) {
        const def = byName.get(name);
        if (!def) throw problem({ kind: "unknown_action", name });
        if (!lists(def, caller)) {
          // allow's own error is what the caller gets when it applies
          authorize(def, caller);
          throw new ActionError(403, "not_listed", `${name} is not available through ${options.name}`);
        }
        const out = run(name, input, caller, { door: options.name });
        return isThenable(out) ? Promise.resolve(out).then((v) => render(def, v)) : render(def, out);
      },
    };
  }

  return {
    actions: [...byName.values()],
    get: (name) => byName.get(name),
    schema: schemaOf,
    allows,
    run: run as Registry["run"],
    door,
    unknown: (name) => problem({ kind: "unknown_action", name }),
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
