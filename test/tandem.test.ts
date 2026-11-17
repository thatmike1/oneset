// the core against a Tandem-shaped app: everything Tandem's registry and proposals do, on the hooks
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, test } from "node:test";
import { ActionError } from "../src/index.ts";
import { type Actor, dryRunActors, type Logged, openDb, TandemError, tandem } from "./fixtures/tandem.ts";

let db: DatabaseSync;
let app: ReturnType<typeof tandem>;
const mike: Actor = { user: "mike", agent: null };
const mikesAgent: Actor = { user: "mike", agent: "key-1" };
const jindra: Actor = { user: "jindra", agent: null };

const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;

function rejects(fn: () => unknown, code: string): ActionError {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown instanceof ActionError, `expected ${code}, got ${String(thrown)}`);
  assert.equal(thrown.code, code);
  return thrown;
}

beforeEach(() => {
  db = openDb();
  app = tandem(db);
  dryRunActors.length = 0;
});

describe("areas with repeated local keys", () => {
  test("both `list` actions are registered under their own names", () => {
    const names = app.reg.actions.map((d) => d.name);
    assert.ok(names.includes("item.list"));
    assert.ok(names.includes("people.list"));
    assert.deepEqual(app.reg.run("people.list", {}, mike), {
      status: "done",
      result: [{ user: "jindra" }, { user: "mike" }],
    });
  });
});

describe("space", () => {
  test("schema adds `space` and around moves it into the context", () => {
    const out = app.reg.run("people.whoami", {}, mike);
    assert.deepEqual(out, { status: "done", result: { user: "mike", agent: null, space: null } });
    app.reg.run("item.create", { title: "at home" }, mike);
    app.reg.run("item.create", { title: "at work", space: "work" }, mike);
    assert.deepEqual(app.reg.run("item.list", { space: "work" }, mike), {
      status: "done",
      result: [{ id: 2, title: "at work", status: "open" }],
    });
    assert.deepEqual(app.reg.run("item.list", {}, mike), {
      status: "done",
      result: [{ id: 1, title: "at home", status: "open" }],
    });
    const rows = db.prepare("select space_id from items order by id").all() as { space_id: string }[];
    assert.deepEqual(
      rows.map((r) => r.space_id),
      ["s-home", "s-work"],
    );
  });

  test("the validated schema includes `space` only where the app adds it", () => {
    const keys = (name: string) => Object.keys(app.reg.schema(app.reg.get(name)!).shape);
    assert.deepEqual(keys("item.create"), ["title", "space"]);
    assert.deepEqual(keys("people.whoami"), []);
  });

  test("the catalog and MCP schemas show the field the schema hook adds", () => {
    const props = (door: ReturnType<typeof app.reg.door>, name: string) =>
      Object.keys(door.catalog(mike).find((e) => e.name === name)?.inputSchema.properties ?? {});
    for (const draft of ["draft-2020-12", "draft-7"] as const) {
      const door = app.reg.door({ name: draft, draft });
      assert.deepEqual(props(door, "item.create"), ["title", "space"]);
      assert.deepEqual(props(door, "people.whoami"), []);
    }
  });

  test("a space the caller is not in is the app's own error", () => {
    rejects(() => app.reg.run("item.list", { space: "work" }, jindra), "no_space");
  });
});

describe("transactions", () => {
  test("a nested call joins the outer transaction and logs once per change", () => {
    const out = app.reg.run("item.pair", { title: "twin", space: "work" }, mike);
    assert.deepEqual(out, { status: "done", result: { ids: [1, 2] } });
    assert.equal(count("select count(*) n from items where space_id = 's-work'"), 2);
    assert.equal(count("select count(*) n from events"), 2);
  });

  test("a failure after nested calls rolls every one of them back", () => {
    rejects(() => app.reg.run("item.pair", { title: "twin", fail: true }, mike), "pair_failed");
    assert.equal(count("select count(*) n from items"), 0);
    assert.equal(count("select count(*) n from events"), 0);
  });
});

describe("proposals", () => {
  test("an agent's call to a propose action becomes a proposal after a dry run as the person", () => {
    app.reg.run("item.create", { title: "ship it", space: "work" }, mike);
    const out = app.reg.run("item.accept", { item: 1, space: "work" }, mikesAgent);
    assert.equal((out as { status: string }).status, "proposed");
    assert.equal((out as { summary: string }).summary, "accept #1 in work");
    assert.deepEqual(dryRunActors, [{ user: "mike", agent: null }]);
    // the dry run left nothing behind; only the proposal and its event are stored
    assert.deepEqual(app.reg.run("item.list", { space: "work" }, mike), {
      status: "done",
      result: [{ id: 1, title: "ship it", status: "open" }],
    });
    assert.equal(count("select count(*) n from proposals"), 1);
    assert.deepEqual(
      db
        .prepare("select summary, agent, proposal_id is not null p from events order by id")
        .all()
        .map((r) => ({ ...r })),
      [
        { summary: "created ship it", agent: null, p: 0 },
        { summary: "proposed", agent: "key-1", p: 1 },
      ],
    );
  });

  test("a dry run that fails stores nothing and gives the agent the person's error", () => {
    rejects(() => app.reg.run("item.accept", { item: 99 }, mikesAgent), "not_found");
    assert.equal(count("select count(*) n from proposals"), 0);
    assert.equal(count("select count(*) n from events"), 0);
  });

  test("a person's call runs at once", () => {
    app.reg.run("item.create", { title: "ship it" }, mike);
    assert.deepEqual(app.reg.run("item.accept", { item: 1 }, mike), {
      status: "done",
      result: { accepted: 1 },
    });
  });

  test("people-only actions refuse agents with the app's own error", () => {
    const err = rejects(() => app.reg.run("keys.create", { label: "x" }, mikesAgent), "people_only");
    assert.equal(err.status, 403);
    assert.deepEqual(app.reg.run("keys.create", { label: "x" }, mike), {
      status: "done",
      result: { key: "mike:x" },
    });
  });
});

describe("the app's own errors for the kit's two", () => {
  test("an unknown action is the app's error type", () => {
    const err = rejects(() => app.reg.run("item.nope" as never, {}, mike), "unknown_action");
    assert.ok(err instanceof TandemError);
    assert.equal(err.message, "no action named item.nope");
  });

  test("invalid input is the app's error type, with issues and Tandem's message", () => {
    const err = rejects(() => app.reg.run("item.create", { title: "" }, mike), "invalid_input");
    assert.ok(err instanceof TandemError);
    assert.equal(err.status, 400);
    assert.match(err.message, /✖ .*\n {2}→ at title/);
    assert.equal((err.issues as unknown[]).length, 1);
  });
});

describe("commit listeners", () => {
  test("fire exactly once per outermost run, with nested events included", () => {
    const heard: Logged[][] = [];
    app.onCommitted((events) => heard.push(events));
    app.reg.run("item.pair", { title: "twin" }, mike);
    assert.equal(heard.length, 1);
    assert.deepEqual(
      heard[0]?.map((e) => e.subject),
      ["item:1", "item:2"],
    );
  });

  test("do not fire for a rollback, a read, or a failed dry run", () => {
    const heard: Logged[][] = [];
    app.onCommitted((events) => heard.push(events));
    try {
      app.reg.run("item.pair", { title: "twin", fail: true }, mike);
    } catch {}
    app.reg.run("item.list", {}, mike);
    try {
      app.reg.run("item.accept", { item: 5 }, mikesAgent);
    } catch {}
    assert.equal(heard.length, 0);
  });

  test("fire once for a proposal, with only the proposal's event", () => {
    app.reg.run("item.create", { title: "a" }, mike);
    const heard: Logged[][] = [];
    app.onCommitted((events) => heard.push(events));
    app.reg.run("item.accept", { item: 1 }, mikesAgent);
    assert.equal(heard.length, 1);
    assert.equal(heard[0]?.length, 1);
  });

  test("the kit's change listeners also fire once for the outer run and not for its nested ones", () => {
    const changes: unknown[] = [];
    app.reg.onChange((c) => changes.push(c));
    app.reg.run("item.pair", { title: "twin" }, mike, { door: "http" });
    assert.deepEqual(changes, [{ action: "item.pair", door: "http" }]);
  });

  test("and not for a rolled-back run", () => {
    const changes: unknown[] = [];
    app.reg.onChange((c) => changes.push(c));
    try {
      app.reg.run("item.pair", { title: "twin", fail: true }, mike);
    } catch {}
    assert.deepEqual(changes, []);
  });
});
