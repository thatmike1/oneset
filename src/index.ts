// oneset: an app's actions written once, used by people through the page and agents through MCP or a CLI
import type { z } from "zod";
import { type ActionDef, buildRegistry, type Hooks, type Registry } from "./core.ts";

export type {
  ActionDef,
  ActionsOf,
  AnyAction,
  BareChange,
  CatalogEntry,
  Change,
  Description,
  Door,
  DoorOptions,
  DoorRunOptions,
  Draft,
  Hooks,
  JobView,
  JsonSchema,
  KitProblem,
  Registry,
  RunInfo,
} from "./core.ts";
export { JOB_ACTION, JOB_WAIT_DEFAULT, JOB_WAIT_MAX, toolName } from "./core.ts";
export { ActionError, type ActionErrorExtra, errorShape, type RenderedError } from "./errors.ts";

/**
 * refuses an `allow` whose return type is a promise: it would decide after the run started. A
 * void-returning function still fits, since void says nothing about a promise; the run refuses
 * one that returns a promise anyway
 */
type SyncAllow<H> = H extends { allow?: (...args: any[]) => infer R }
  ? [Extract<R, PromiseLike<unknown>>] extends [never]
    ? unknown
    : { allow: "allow must decide synchronously: resolve async facts in the caller resolver" }
  : unknown;

/**
 * a typed setup: `defineAction` and `createRegistry` that know the caller the doors pass in,
 * the context handlers receive, the fields the app adds to a definition, and any input
 * fields its `schema` hook adds for every action
 */
export function kit<
  Caller = any,
  RunCtx = Caller,
  Fields extends object = {},
  ExtraInput extends object = {},
>() {
  type Def = ActionDef<string, z.ZodObject, unknown, RunCtx> & Fields;

  /** returns the definition as written, with its name, input, output and app fields typed */
  function defineAction<const Nm extends string, I extends z.ZodObject, O, const E extends Fields = Fields>(
    def: ActionDef<Nm, I, O, RunCtx> & E,
  ): ActionDef<Nm, I, O, RunCtx> & E {
    return def;
  }

  /** one list of definitions, keyed by name (a repeated name throws), and the hooks */
  function createRegistry<
    const D extends readonly (ActionDef<string, any, any, RunCtx> & Fields)[],
    H extends Hooks<Caller, RunCtx, Def> = {},
  >(
    definitions: D,
    hooks?: H & Hooks<Caller, RunCtx, Def> & SyncAllow<H>,
  ): Registry<D[number], Caller, ExtraInput, H, Def> {
    return buildRegistry(definitions, hooks as Hooks) as never;
  }

  return { defineAction, createRegistry };
}

const untyped = kit();
/** `defineAction` for an app that does not type its caller */
export const defineAction: typeof untyped.defineAction = untyped.defineAction;
/** `createRegistry` for an app that does not type its caller */
export const createRegistry: typeof untyped.createRegistry = untyped.createRegistry;
