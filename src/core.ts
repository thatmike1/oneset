// the core: definitions, the registry, the run chain (allow, schema, around) and doors made with
// reg.door. It never awaits: a sync chain returns a value, an async one a promise.
import { z } from "zod";
import { ActionError, errorShape } from "./errors.ts";

/** which JSON Schema draft a door shows input schemas in */
export type Draft = "draft-2020-12" | "draft-7";

/** where a run came from: the door's name, whether it runs inside another run, and its job */
export interface RunInfo {
  nested: boolean;
  door: string;
  /** the job's id when a door started this run as a job (a long action) */
  job?: string;
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
  /**
   * slow work (a model call, a render): every door answers at once with a job id instead of
   * waiting, and the kit's `job.get` action reads the job until it is done. Runs from app code
   * (`reg.run`) and nested runs still run inline and return the result
   */
  long?: boolean;
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
  /**
   * who owns a job: a caller reads a job only when this returns the same value (===) for it as
   * for the caller that started it. Without it, any caller its action is listed for may read a
   * job whose id it holds
   */
  jobOwner?(caller: Caller): unknown;
  /** how jobs are kept: `keepMs` after they finish (default an hour), at most `max` (default 1000) */
  jobs?: { keepMs?: number; max?: number };
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
  /** present for a long action: doors answer with a job, read with `job.get` */
  long?: true;
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
  /**
   * runs a listed action and renders its outcome; refuses a name it does not list. A long action
   * answers `{ job }` at once instead (see `starts`)
   */
  run(name: string, input: unknown, caller: Caller): unknown;
  /** whether `run` answers this action with a job instead of its outcome */
  starts(name: string): boolean;
}

/** a job as `job.get` and a long action's start answer it */
export interface JobView {
  id: string;
  action: string;
  state: "running" | "done" | "failed";
  started: string;
  finished?: string;
  /** the action's outcome, rendered by the reading door, once `state` is done */
  result?: unknown;
  /** what the run threw, once `state` is failed: as a door renders an error, without its headers */
  error?: { status: number; code: string; message: string; issues?: unknown; body?: unknown };
}

/** what change listeners hear after a mutating run succeeds at the outermost level */
export interface Change {
  action: string;
  door: string;
  /** the job's id, when the run was a long action's job: the change comes when it finishes */
  job?: string;
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

/** the action the kit adds when any action is long: reads a job by its id */
export const JOB_ACTION = "job.get";
/** the longest a `job.get` call waits for its job to finish, in seconds, below an MCP client's 60 s */
export const JOB_WAIT_MAX = 50;
/** how long `job.get` waits when the caller does not say */
export const JOB_WAIT_DEFAULT = 30;

const jobInput = z.object({
  id: z.string().min(1).describe("the job id a long action answered with"),
  wait: z
    .number()
    .min(0)
    .max(JOB_WAIT_MAX)
    .optional()
    .describe(
      `seconds to wait for the job to finish before answering (default ${JOB_WAIT_DEFAULT}, at most ${JOB_WAIT_MAX}, 0 for at once)`,
    ),
});

const JOB_SUMMARY =
  `Read a long action's job: its state, and once it is finished the result or the error. ` +
  `Waits up to ${JOB_WAIT_DEFAULT} s for it to finish; call it again while the state is running.`;

interface Job {
  id: string;
  def: AnyAction;
  owner: unknown;
  state: "running" | "done" | "failed";
  started: number;
  finished?: number;
  value?: unknown;
  error?: NonNullable<JobView["error"]>;
  /** settles when the job finishes, either way */
  done: Promise<void>;
}

/** what a job's run threw, as a door renders an error; anything else is logged and becomes internal */
function jobError(err: unknown): NonNullable<JobView["error"]> {
  const shape = errorShape(err);
  if (!shape) {
    console.error("oneset: a job failed", err);
    return { status: 500, code: "internal", message: "something broke on the server" };
  }
  const out: NonNullable<JobView["error"]> = {
    status: shape.status,
    code: shape.code,
    message: shape.message,
  };
  if (shape.issues !== undefined) out.issues = shape.issues;
  if (shape.body !== undefined) out.body = shape.body;
  return out;
}

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
  const actions = [...byName.values()];
  // the kit's job reader exists only for a registry with long actions, and never through app hooks
  const jobDef: AnyAction | undefined = actions.some((def) => def.long)
    ? {
        name: JOB_ACTION,
        area: "jobs",
        summary: JOB_SUMMARY,
        mutates: false,
        input: jobInput,
        run: () => {
          throw new Error("oneset: job.get is read by the kit, not run");
        },
      }
    : undefined;
  if (jobDef) {
    const clash = byName.get(JOB_ACTION) ?? byName.get(tools.get(toolName(JOB_ACTION)) ?? "");
    if (clash) {
      throw new Error(
        `action ${clash.name} takes the name of the kit's ${JOB_ACTION}, which reads long actions' jobs; rename it`,
      );
    }
    byName.set(JOB_ACTION, jobDef);
  }
  const isJobDef = (def: AnyAction) => def === jobDef;

  const schemas = new WeakMap<AnyAction, z.ZodObject>();
  const schemaOf = (def: AnyAction): z.ZodObject => {
    let s = schemas.get(def);
    if (!s) {
      s = hooks.schema && !isJobDef(def) ? hooks.schema(def) : (def.input as z.ZodObject);
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
    if (isJobDef(def)) return readJob(input, caller);
    authorize(def, caller);
    return execute(def, validate(def, input), caller, info);
  }

  function validate(def: AnyAction, input: unknown): Record<string, unknown> {
    const parsed = schemaOf(def).safeParse(input ?? {});
    if (!parsed.success) throw problem({ kind: "invalid_input", def, error: parsed.error });
    return parsed.data as Record<string, unknown>;
  }

  /** around and the handler, then the change event, for validated input allow already passed */
  function execute(
    def: AnyAction,
    data: Record<string, unknown>,
    caller: unknown,
    info?: Partial<RunInfo>,
  ): unknown {
    const runInfo: RunInfo = { nested: info?.nested ?? false, door: info?.door ?? "direct" };
    if (info?.job !== undefined) runInfo.job = info.job;
    const out = hooks.around
      ? hooks.around(def, data, caller, (i, ctx) => def.run(i, ctx), runInfo)
      : def.run(data, caller);
    if (!def.mutates || runInfo.nested || listeners.size === 0) return out;
    const change: Change = { action: def.name, door: runInfo.door };
    if (runInfo.job !== undefined) change.job = runInfo.job;
    if (isThenable(out)) {
      return Promise.resolve(out).then((value) => {
        emit(change);
        return value;
      });
    }
    emit(change);
    return out;
  }

  const jobs = new Map<string, Job>();
  const keepMs = hooks.jobs?.keepMs ?? 60 * 60 * 1000;
  const maxJobs = hooks.jobs?.max ?? 1000;

  /** drops finished jobs past their keep time, then the oldest finished ones over the cap */
  function sweep(now: number): void {
    for (const [id, job] of jobs) {
      if (job.finished !== undefined && now - job.finished >= keepMs) jobs.delete(id);
    }
    if (jobs.size < maxJobs) return;
    const finished = [...jobs.values()]
      .filter((job) => job.finished !== undefined)
      .sort((a, b) => (a.finished ?? 0) - (b.finished ?? 0));
    for (const job of finished) {
      if (jobs.size < maxJobs) break;
      jobs.delete(job.id);
    }
  }

  /** starts a long action's run as a job: allow and validation already answered */
  function startJob(def: AnyAction, data: Record<string, unknown>, caller: unknown, door: string): Job {
    const now = Date.now();
    sweep(now);
    let settle = () => {};
    const job: Job = {
      id: globalThis.crypto.randomUUID(),
      def,
      owner: hooks.jobOwner ? hooks.jobOwner(caller) : undefined,
      state: "running",
      started: now,
      done: new Promise<void>((resolve) => {
        settle = resolve;
      }),
    };
    jobs.set(job.id, job);
    const succeed = (value: unknown) => {
      job.state = "done";
      job.value = value;
      job.finished = Date.now();
      settle();
    };
    const fail = (err: unknown) => {
      job.state = "failed";
      job.error = jobError(err);
      job.finished = Date.now();
      settle();
    };
    try {
      const out = execute(def, data, caller, { door, job: job.id });
      if (isThenable(out)) Promise.resolve(out).then(succeed, fail);
      else succeed(out);
    } catch (err) {
      fail(err);
    }
    return job;
  }

  function viewOf(job: Job, render: (def: AnyAction, outcome: unknown) => unknown): JobView {
    const view: JobView = {
      id: job.id,
      action: job.def.name,
      state: job.state,
      started: new Date(job.started).toISOString(),
    };
    if (job.finished !== undefined) view.finished = new Date(job.finished).toISOString();
    if (job.state === "done") view.result = render(job.def, job.value);
    if (job.error) view.error = job.error;
    return view;
  }

  /**
   * job.get: the job, when this caller may run its action here and owns it; otherwise the same
   * unknown_job as for an id that never existed, so a read says nothing of other callers' jobs
   */
  function readJob(
    input: unknown,
    caller: unknown,
    listedHere: (def: AnyAction) => boolean = () => true,
    render: (def: AnyAction, outcome: unknown) => unknown = (_def, outcome) => outcome,
  ): unknown {
    const { id, wait = JOB_WAIT_DEFAULT } = validate(jobDef as AnyAction, input) as z.output<typeof jobInput>;
    sweep(Date.now());
    const job = jobs.get(id);
    const readable =
      job !== undefined &&
      (!hooks.jobOwner || hooks.jobOwner(caller) === job.owner) &&
      allows(job.def, caller) &&
      listedHere(job.def);
    if (!job || !readable) {
      throw new ActionError(
        404,
        "unknown_job",
        `no job ${id} here: jobs are kept in memory for a while after they finish and are lost when the app restarts`,
      );
    }
    if (job.state !== "running" || wait === 0) return viewOf(job, render);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, wait * 1000);
    });
    return Promise.race([job.done, waited]).then(() => {
      clearTimeout(timer);
      return viewOf(job, render);
    });
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
    const listsAction = (def: AnyAction, caller: unknown) =>
      allows(def, caller) && (options.list ? options.list(def, caller) : true);
    // the job reader is listed wherever a long action is, and only there
    const lists = (def: AnyAction, caller: unknown): boolean =>
      isJobDef(def) ? actions.some((d) => d.long && listsAction(d, caller)) : listsAction(def, caller);
    const describe = (def: AnyAction, caller: unknown): Description =>
      options.describe && !isJobDef(def)
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
      options.render && !isJobDef(def) ? options.render(def, outcome) : outcome;
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
          ...(def.long ? { long: true as const } : {}),
          inputSchema: inputSchema(def),
        })),
      starts: (name) => byName.get(name)?.long === true,
      run(name, input, caller) {
        const def = byName.get(name);
        if (!def) throw problem({ kind: "unknown_action", name });
        if (isJobDef(def)) {
          return readJob(input, caller, (d) => listsAction(d, caller), render);
        }
        // allow runs once: its own error is what the caller gets, and only then the door's list rule
        authorize(def, caller);
        if (options.list && !options.list(def, caller)) {
          throw new ActionError(403, "not_listed", `${name} is not available through ${options.name}`);
        }
        const data = validate(def, input);
        // a long action answers with its job at once; refusals and bad input above still answer now
        if (def.long) return { job: viewOf(startJob(def, data, caller, options.name), render) };
        const out = execute(def, data, caller, { door: options.name });
        return isThenable(out) ? Promise.resolve(out).then((v) => render(def, v)) : render(def, out);
      },
    };
  }

  return {
    actions,
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
