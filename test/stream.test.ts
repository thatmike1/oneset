// the change stream, read with fetch (Node 22 has no EventSource): one event after a mutating
// run succeeds at the outermost level, async ones included; nothing for a read, a failure, a
// rollback or a nested run
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { doors } from "../src/doors/index.ts";
import { notesRegistry } from "./fixtures/notes.ts";
import { type Actor, openDb, tandem } from "./fixtures/tandem.ts";
import { json, openEvents, raw, type Served, serve } from "./helpers.ts";

describe("the change stream on the notes app", () => {
  const reg = notesRegistry();
  let app: Served;
  before(async () => {
    app = await serve(doors(reg, { name: "notes" }));
  });
  after(() => app.close());

  test("is an event stream behind the guard", async () => {
    const events = await openEvents(`${app.url}/api/actions/stream`);
    assert.equal(events.status, 200);
    assert.match(events.headers.get("content-type") ?? "", /^text\/event-stream/);
    events.close();
    const foreign = await raw(app.port, {
      path: "/api/actions/stream",
      headers: { origin: "https://evil.example" },
    });
    assert.equal(foreign.status, 403);
  });

  test("one event after a mutating run, through any door", async () => {
    const events = await openEvents(`${app.url}/api/actions/stream`);
    try {
      await raw(app.port, { path: "/api/actions/note.add", ...json({ text: "via http" }) });
      assert.deepEqual(JSON.parse((await events.next())?.data ?? "null"), {
        action: "note.add",
        door: "http",
      });
      reg.run("note.add", { text: "direct" }, undefined);
      const direct = await events.next();
      assert.equal(direct?.event, "change");
      assert.deepEqual(JSON.parse(direct?.data ?? "null"), { action: "note.add", door: "direct" });
      assert.equal(await events.next(150), null, "exactly one event each");
    } finally {
      events.close();
    }
  });

  test("an async run's event comes once it has finished", async () => {
    const events = await openEvents(`${app.url}/api/actions/stream`);
    try {
      const pending = reg.run("note.add_later", { text: "later" }, undefined);
      const early = await events.next(1);
      assert.equal(early, null, "nothing before the run finishes");
      await pending;
      assert.deepEqual(JSON.parse((await events.next())?.data ?? "null"), {
        action: "note.add_later",
        door: "direct",
      });
    } finally {
      events.close();
    }
  });

  test("nothing for a read, a failed run or a nested run", async () => {
    const events = await openEvents(`${app.url}/api/actions/stream`);
    const original = console.error;
    console.error = () => {};
    try {
      reg.run("note.list", {}, undefined);
      assert.throws(() => reg.run("note.fail", {}, undefined));
      await assert.rejects(Promise.resolve(reg.run("note.fail_later", {}, undefined)));
      await raw(app.port, { path: "/api/actions/note.fail_later", ...json({}) });
      reg.run("note.add", { text: "inner" }, undefined, { nested: true });
      reg.run("note.add", { text: "marker" }, undefined);
      // the first event to arrive is the marker's: none of the runs before it sent one
      assert.deepEqual(JSON.parse((await events.next())?.data ?? "null"), {
        action: "note.add",
        door: "direct",
      });
      assert.equal(await events.next(150), null);
    } finally {
      console.error = original;
      events.close();
    }
  });

  test("a closed stream stops listening and runs carry on", async () => {
    const events = await openEvents(`${app.url}/api/actions/stream`);
    events.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((reg.run("note.add", { text: "after" }, undefined) as { text: string }).text, "after");
  });
});

describe("the change stream on the Tandem-shaped app", () => {
  const mike: Actor = { user: "mike", agent: null };
  const app = tandem(openDb());
  let served: Served;
  before(async () => {
    served = await serve(doors(app.reg, { name: "tandem", caller: () => mike }));
  });
  after(() => served.close());

  test("one event for a run with nested calls, none for a rolled-back one", async () => {
    const events = await openEvents(`${served.url}/api/actions/stream`);
    try {
      assert.throws(() => app.reg.run("item.pair", { title: "x", fail: true }, mike));
      const res = await raw(served.port, { path: "/api/actions/item.pair", ...json({ title: "twin" }) });
      assert.deepEqual(res.json(), { result: { status: "done", result: { ids: [1, 2] } } });
      assert.deepEqual(JSON.parse((await events.next())?.data ?? "null"), {
        action: "item.pair",
        door: "http",
      });
      assert.equal(await events.next(150), null, "the two nested item.create runs sent nothing");
    } finally {
      events.close();
    }
  });
});
