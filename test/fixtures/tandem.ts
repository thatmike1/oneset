// a Tandem-shaped app on node:sqlite: spaces added by schema and moved into the context, a
// transaction per mutating run that nested calls join, proposals with a dry run as a person,
// its own error codes and commit listeners. Everything here is what Tandem keeps on the hooks.
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { type ActionDef, ActionError, kit } from "../../src/index.ts";

export interface Actor {
  user: string;
  /** set for an agent acting for the user */
  agent: string | null;
}

export interface Space {
  id: string;
  slug: string;
}

export interface Logged {
  id: number;
  space: string;
  action: string;
  subject: string;
}

export interface Ctx {
  db: DatabaseSync;
  actor: Actor;
  space: Space;
  proposalId: string | null;
  log(entry: { subject: string; summary: string }): number;
  call(name: string, input: Record<string, unknown>): unknown;
}

export type Access = "any" | "propose" | "human";
export interface Subject {
  type: string;
  id: string;
  summary: string;
}

/** the fields Tandem adds to a definition; the kit carries them and never reads them */
export interface Fields {
  access: Access;
  spaced?: boolean;
  subject?: (input: never, ctx: Ctx) => Subject;
}

export type Outcome =
  | { status: "done"; result: unknown }
  | { status: "proposed"; proposalId: string; summary: string };

/** the app's own error type, which the kit's two errors are turned into */
export class TandemError extends ActionError {}

const k = kit<Actor, Ctx, Fields, { space?: string }>();

/** Tandem's own wrapper: `subject` is typed from the action's input, which the kit leaves to the app */
export function tandemAction<const Nm extends string, I extends z.ZodObject, O>(
  def: ActionDef<Nm, I, O, Ctx> & {
    access: Access;
    spaced?: boolean;
    subject?: (input: z.output<I>, ctx: Ctx) => Subject;
  },
) {
  return k.defineAction(def);
}

const fail = (status: number, code: string, message: string): never => {
  throw new TandemError(status, code, message);
};

const itemActions = {
  list: tandemAction({
    name: "item.list",
    area: "items",
    summary: "Items in the space",
    access: "any",
    mutates: false,
    input: z.object({}),
    run: (_input, ctx) =>
      plain<{ id: number; title: string; status: string }>(
        ctx.db
          .prepare("select id, title, status from items where space_id = ? order by id")
          .all(ctx.space.id),
      ),
  }),
  create: tandemAction({
    name: "item.create",
    area: "items",
    summary: "Create an item",
    access: "any",
    mutates: true,
    input: z.object({ title: z.string().min(1) }),
    run(input, ctx) {
      const row = ctx.db
        .prepare("insert into items (space_id, title, status) values (?, ?, 'open') returning id")
        .get(ctx.space.id, input.title) as { id: number };
      ctx.log({ subject: `item:${row.id}`, summary: `created ${input.title}` });
      return { id: row.id };
    },
  }),
  /** a nested call: creates one item through another action, then a second, in one transaction */
  pair: tandemAction({
    name: "item.pair",
    area: "items",
    summary: "Create two items at once",
    access: "any",
    mutates: true,
    input: z.object({ title: z.string().min(1), fail: z.boolean().default(false) }),
    run(input, ctx) {
      const a = ctx.call("item.create", { title: `${input.title} 1` }) as { id: number };
      const b = ctx.call("item.create", { title: `${input.title} 2` }) as { id: number };
      if (input.fail) fail(409, "pair_failed", "the second half did not fit");
      return { ids: [a.id, b.id] };
    },
  }),
  accept: tandemAction({
    name: "item.accept",
    area: "items",
    summary: "Accept an item",
    access: "propose",
    mutates: true,
    input: z.object({ item: z.number().int() }),
    subject: (input, ctx) => ({
      type: "item",
      id: String(input.item),
      summary: `accept #${input.item} in ${ctx.space.slug}`,
    }),
    run(input, ctx) {
      dryRunActors.push(ctx.actor);
      const changed = ctx.db
        .prepare("update items set status = 'accepted' where id = ? and space_id = ?")
        .run(input.item, ctx.space.id);
      if (changed.changes === 0) fail(404, "not_found", `no item #${input.item}`);
      ctx.log({ subject: `item:${input.item}`, summary: "accepted" });
      return { accepted: input.item };
    },
  }),
};

/** a second area that reuses the local key `list` */
const peopleActions = {
  list: tandemAction({
    name: "people.list",
    area: "people",
    summary: "People in the space",
    access: "any",
    mutates: false,
    input: z.object({}),
    run: (_input, ctx) =>
      plain<{ user: string }>(
        ctx.db.prepare("select user from members where space_id = ? order by user").all(ctx.space.id),
      ),
  }),
  whoami: tandemAction({
    name: "people.whoami",
    area: "people",
    summary: "Who you are",
    access: "any",
    spaced: false,
    mutates: false,
    input: z.object({}),
    run: (_input, ctx) => ({ user: ctx.actor.user, agent: ctx.actor.agent, space: ctx.space }),
  }),
};

const keyActions = {
  create: tandemAction({
    name: "keys.create",
    area: "keys",
    summary: "Create an agent key",
    access: "human",
    spaced: false,
    mutates: true,
    input: z.object({ label: z.string() }),
    run: (input, ctx) => ({ key: `${ctx.actor.user}:${input.label}` }),
  }),
};

/** the actors the accept handler ran as, so a test can see the dry run ran as a person */
export const dryRunActors: Actor[] = [];

/** sqlite rows have a null prototype; tests compare plain objects */
const plain = <T>(rows: unknown[]): T[] => rows.map((r) => ({ ...(r as object) }) as T);

export function openDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    create table spaces (id text primary key, slug text unique not null);
    create table members (space_id text not null, user text not null);
    create table items (id integer primary key, space_id text not null, title text not null, status text not null);
    create table events (id integer primary key, space_id text, action text not null, subject text not null,
      summary text not null, user text not null, agent text, proposal_id text);
    create table proposals (id text primary key, space_id text not null, action text not null, input text not null,
      summary text not null, subject_type text not null, subject_id text not null);
    insert into spaces values ('s-home', 'home'), ('s-work', 'work');
    insert into members values ('s-home', 'mike'), ('s-work', 'mike'), ('s-home', 'jindra');
  `);
  return db;
}

export function tandem(db: DatabaseSync) {
  const listeners = new Set<(events: Logged[]) => void>();
  // events of the outermost run in progress; nested runs add to it
  let running: Logged[] | null = null;
  let depth = 0;

  function resolveSpace(actor: Actor, slug: string | undefined): Space {
    const rows = db
      .prepare(
        "select s.id, s.slug from spaces s join members m on m.space_id = s.id where m.user = ? order by s.slug",
      )
      .all(actor.user) as unknown as Space[];
    if (slug === undefined) return rows.find((r) => r.slug === "home") ?? fail(404, "no_space", "no space");
    return rows.find((r) => r.slug === slug) ?? fail(404, "no_space", `you are not in a space named ${slug}`);
  }

  function makeCtx(
    def: { name: string },
    actor: Actor,
    space: Space,
    events: Logged[],
    proposalId: string | null,
  ) {
    const ctx: Ctx = {
      db,
      actor,
      space,
      proposalId,
      log(entry) {
        const row = db
          .prepare(
            `insert into events (space_id, action, subject, summary, user, agent, proposal_id)
             values (?, ?, ?, ?, ?, ?, ?) returning id`,
          )
          .get(
            space?.id ?? null,
            def.name,
            entry.subject,
            entry.summary,
            actor.user,
            actor.agent,
            proposalId,
          ) as {
          id: number;
        };
        events.push({ id: row.id, space: space?.id, action: def.name, subject: entry.subject });
        return row.id;
      },
      call(name, input) {
        const out = reg.run(name as never, { ...input, space: space.slug } as never, actor, {
          nested: true,
          door: "nested",
        }) as Outcome;
        if (out.status !== "done") fail(500, "proposed", `nested call to ${name} became a proposal`);
        return (out as { result: unknown }).result;
      },
    };
    return ctx;
  }

  /** one transaction per outermost mutating run; nested runs join it */
  function tx<T>(fn: () => T): T {
    if (depth > 0) {
      depth++;
      try {
        return fn();
      } finally {
        depth--;
      }
    }
    db.exec("begin immediate");
    depth = 1;
    try {
      const out = fn();
      db.exec("commit");
      return out;
    } catch (err) {
      db.exec("rollback");
      throw err;
    } finally {
      depth = 0;
    }
  }

  const reg = k.createRegistry(
    [...Object.values(itemActions), ...Object.values(peopleActions), ...Object.values(keyActions)],
    {
      schema: (def) =>
        def.spaced === false
          ? def.input
          : def.input.extend({ space: z.string().optional().describe("space slug; defaults to home") }),
      allow(def, caller) {
        if (def.access === "human" && caller.agent) {
          throw new TandemError(403, "people_only", `${def.name} is for people only`);
        }
      },
      around(def, rawInput, caller, next, info): Outcome {
        const { space: slug, ...input } = rawInput as { space?: string };
        const space = def.spaced === false ? (null as unknown as Space) : resolveSpace(caller, slug);
        const outer = !info.nested;
        const events: Logged[] = outer ? [] : (running ?? []);
        if (outer) running = events;
        try {
          const ctx = makeCtx(def, caller, space, events, null);
          if (!def.mutates) return { status: "done", result: next(input, ctx) };
          const out = tx((): Outcome => {
            if (def.access === "propose" && caller.agent) {
              // dry run in a savepoint, as the person would run it: a proposal is only stored
              // when the action would succeed right now
              db.exec("savepoint dry_run");
              const before = events.length;
              try {
                next(input, makeCtx(def, { user: caller.user, agent: null }, space, events, null));
              } finally {
                db.exec("rollback to dry_run");
                db.exec("release dry_run");
                events.length = before;
              }
              const subject = def.subject?.(input as never, ctx) ?? {
                type: "space",
                id: space.id,
                summary: def.summary,
              };
              const id = randomUUID();
              db.prepare(
                `insert into proposals (id, space_id, action, input, summary, subject_type, subject_id)
                 values (?, ?, ?, ?, ?, ?, ?)`,
              ).run(id, space.id, def.name, JSON.stringify(input), subject.summary, subject.type, subject.id);
              makeCtx(def, caller, space, events, id).log({
                subject: `${subject.type}:${subject.id}`,
                summary: "proposed",
              });
              return { status: "proposed", proposalId: id, summary: subject.summary };
            }
            return { status: "done", result: next(input, ctx) };
          });
          if (outer && events.length > 0) {
            for (const fn of listeners) {
              try {
                fn([...events]);
              } catch (err) {
                console.error("onCommitted listener failed", err);
              }
            }
          }
          return out;
        } finally {
          if (outer) running = null;
        }
      },
      error(problem) {
        if (problem.kind === "unknown_action") {
          return new TandemError(404, "unknown_action", `no action named ${problem.name}`);
        }
        return new TandemError(400, "invalid_input", z.prettifyError(problem.error), {
          issues: problem.error.issues,
        });
      },
    },
  );

  return {
    reg,
    onCommitted(fn: (events: Logged[]) => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
