// the core against the notes fixture: lookup, allow, schema, around, errors, sync and async, change listeners
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { z } from "zod";
import { ActionError, createRegistry, defineAction } from "../src/index.ts";
import { notesActions, notesRegistry } from "./fixtures/notes.ts";

const isThenable = (v: unknown) => typeof (v as { then?: unknown })?.then === "function";

function rejects(fn: () => unknown, check: (err: ActionError) => void): void {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown instanceof ActionError, `expected an ActionError, got ${String(thrown)}`);
  check(thrown);
}

describe("running", () => {
  test("a sync chain returns a plain value, not a promise", () => {
    const reg = notesRegistry();
    const note = reg.run("note.add", { text: "milk" }, undefined);
    assert.equal(isThenable(note), false);
    assert.deepEqual(note, { id: 1, text: "milk" });
    assert.deepEqual(reg.run("note.list", {}, undefined), [{ id: 1, text: "milk" }]);
  });

  test("an async chain returns a promise of the handler's value", async () => {
    const reg = notesRegistry();
    const out = reg.run("note.add_later", { text: "eggs" }, undefined);
    assert.equal(isThenable(out), true);
    assert.deepEqual(await out, { id: 1, text: "eggs" });
    assert.equal(await reg.run("note.count", {}, undefined), 1);
  });

  test("the input is validated and parsed before the handler sees it", () => {
    const seen: unknown[] = [];
    const reg = createRegistry([
      defineAction({
        name: "x.echo",
        area: "x",
        summary: "echo",
        mutates: false,
        input: z.object({ n: z.coerce.number(), tag: z.string().default("none") }),
        run: (input) => {
          seen.push(input);
          return input;
        },
      }),
    ]);
    reg.run("x.echo", { n: "4" } as never, undefined);
    assert.deepEqual(seen, [{ n: 4, tag: "none" }]);
  });

  test("a missing input counts as an empty object", () => {
    const reg = notesRegistry();
    assert.deepEqual(reg.run("note.list", undefined as never, undefined), []);
  });

  test("with no around, the handler's context is the caller", () => {
    let ctxSeen: unknown;
    const reg = createRegistry([
      defineAction({
        name: "x.who",
        area: "x",
        summary: "who",
        mutates: false,
        input: z.object({}),
        run: (_input, ctx) => {
          ctxSeen = ctx;
          return null;
        },
      }),
    ]);
    const caller = { user: "mike" };
    reg.run("x.who", {}, caller);
    assert.equal(ctxSeen, caller);
  });
});

describe("registering", () => {
  test("definitions are keyed by name and a repeated name throws", () => {
    const defs = notesActions();
    assert.throws(() => createRegistry([...defs, defs[0]]), /note\.add/);
  });

  test("two names that make the same tool name throw", () => {
    const mk = (name: string) =>
      defineAction({ name, area: "x", summary: "s", mutates: false, input: z.object({}), run: () => 1 });
    assert.throws(() => createRegistry([mk("a.b_c"), mk("a.b.c")]), /a_b_c/);
  });

  test("the registry lists and finds its actions", () => {
    const reg = notesRegistry();
    assert.deepEqual(
      reg.actions.map((d) => d.name),
      ["note.add", "note.list", "note.add_later", "note.count", "note.fail_later", "note.fail"],
    );
    assert.equal(reg.get("note.add")?.summary, "Add a note");
    assert.equal(reg.get("nope"), undefined);
  });
});

describe("the kit's own errors", () => {
  test("an unknown action is a 404 unknown_action by default", () => {
    const reg = notesRegistry();
    rejects(
      () => reg.run("note.nope" as never, {} as never, undefined),
      (err) => {
        assert.equal(err.status, 404);
        assert.equal(err.code, "unknown_action");
        assert.match(err.message, /note\.nope/);
      },
    );
  });

  test("invalid input is a 400 invalid_input with issues by default", () => {
    const reg = notesRegistry();
    rejects(
      () => reg.run("note.add", { text: 5 } as never, undefined),
      (err) => {
        assert.equal(err.status, 400);
        assert.equal(err.code, "invalid_input");
        assert.ok(Array.isArray(err.issues) && err.issues.length === 1);
        assert.match(err.message, /text/);
      },
    );
  });

  test("the error hook replaces both, here with a one-line bad_input and no issues", () => {
    const reg = notesRegistry({
      error(problem) {
        if (problem.kind === "unknown_action")
          return new ActionError(404, "no_such", `what is ${problem.name}`);
        const line = problem.error.issues
          .map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
          .join("; ");
        return new ActionError(400, "bad_input", line);
      },
    });
    rejects(
      () => reg.run("x.y" as never, {} as never, undefined),
      (err) => assert.deepEqual([err.code, err.message], ["no_such", "what is x.y"]),
    );
    rejects(
      () => reg.run("note.add", {} as never, undefined),
      (err) => {
        assert.equal(err.code, "bad_input");
        assert.match(err.message, /^text: /);
        assert.equal(err.issues, undefined);
      },
    );
  });

  test("an ActionError carries issues, a replacement body and headers", () => {
    const err = new ActionError(401, "signed_out", "sign in", {
      body: { tape: [] },
      headers: { "www-authenticate": "Bearer" },
      issues: [1],
    });
    assert.ok(err instanceof Error);
    assert.deepEqual([err.status, err.code, err.message], [401, "signed_out", "sign in"]);
    assert.deepEqual(err.body, { tape: [] });
    assert.deepEqual(err.headers, { "www-authenticate": "Bearer" });
    assert.deepEqual(err.issues, [1]);
  });
});

describe("hooks", () => {
  test("allow runs before validation and its own error comes through", () => {
    const order: string[] = [];
    const reg = notesRegistry({
      allow(def, caller: { owner?: boolean } | undefined) {
        order.push(`allow ${def.name}`);
        if (!caller?.owner) throw new ActionError(401, "signed_out", "sign in first");
      },
    });
    rejects(
      () => reg.run("note.add", { text: 5 } as never, {}),
      (err) => assert.equal(err.code, "signed_out"),
    );
    assert.deepEqual(order, ["allow note.add"]);
    assert.deepEqual(reg.run("note.add", { text: "a" }, { owner: true }), { id: 1, text: "a" });
  });

  test("schema sets what is validated, so a field the hook adds reaches around", () => {
    let aroundInput: unknown;
    let handlerInput: unknown;
    const reg = createRegistry(
      [
        defineAction({
          name: "x.add",
          area: "x",
          summary: "add",
          mutates: true,
          input: z.object({ text: z.string() }),
          run: (input) => {
            handlerInput = input;
            return input.text;
          },
        }),
      ],
      {
        schema: (def) => def.input.extend({ space: z.string().optional() }),
        around(_def, input, caller, next) {
          aroundInput = input;
          const { space, ...rest } = input;
          return next(rest, { caller, space });
        },
      },
    );
    assert.equal(reg.run("x.add", { text: "hi", space: "work" } as never, undefined), "hi");
    assert.deepEqual(aroundInput, { text: "hi", space: "work" });
    assert.deepEqual(handlerInput, { text: "hi" });
    rejects(
      () => reg.run("x.add", { text: "hi", space: 3 } as never, undefined),
      (err) => assert.equal(err.code, "invalid_input"),
    );
    assert.deepEqual(Object.keys(z.toJSONSchema(reg.schema(reg.actions[0]!)).properties ?? {}), [
      "text",
      "space",
    ]);
  });

  test("around builds the context, may call next twice and may return something else", () => {
    const seen: unknown[] = [];
    const reg = createRegistry(
      [
        defineAction({
          name: "x.add",
          area: "x",
          summary: "add",
          mutates: true,
          input: z.object({ n: z.number() }),
          run: (input, ctx: { as: string }) => {
            seen.push([input.n, ctx.as]);
            return input.n * 2;
          },
        }),
      ],
      {
        around(_def, input, _caller, next, info) {
          const dry = next(input, { as: "person" });
          const real = next({ n: (input.n as number) + 1 }, { as: "agent" });
          return { proposed: true, dry, real, info };
        },
      },
    );
    assert.deepEqual(reg.run("x.add", { n: 1 }, undefined), {
      proposed: true,
      dry: 2,
      real: 4,
      info: { nested: false, door: "direct" },
    });
    assert.deepEqual(seen, [
      [1, "person"],
      [2, "agent"],
    ]);
  });

  test("info carries the door and the nested flag", () => {
    const infos: unknown[] = [];
    const reg = notesRegistry({
      around(_def, input, caller, next, info) {
        infos.push(info);
        return next(input, caller);
      },
    });
    reg.run("note.list", {}, undefined);
    reg.run("note.list", {}, undefined, { door: "mcp" });
    reg.run("note.list", {}, undefined, { nested: true });
    assert.deepEqual(infos, [
      { nested: false, door: "direct" },
      { nested: false, door: "mcp" },
      { nested: true, door: "direct" },
    ]);
  });
});

describe("change listeners", () => {
  test("fire once after a sync mutating run, never for a read", () => {
    const reg = notesRegistry();
    const changes: unknown[] = [];
    reg.onChange((c) => changes.push(c));
    reg.run("note.list", {}, undefined);
    reg.run("note.add", { text: "a" }, undefined, { door: "http" });
    assert.deepEqual(changes, [{ action: "note.add", door: "http" }]);
  });

  test("fire after an async mutating run resolves, not before", async () => {
    const reg = notesRegistry();
    const changes: unknown[] = [];
    reg.onChange((c) => changes.push(c));
    const out = reg.run("note.add_later", { text: "a" }, undefined);
    assert.equal(changes.length, 0);
    await out;
    assert.deepEqual(changes, [{ action: "note.add_later", door: "direct" }]);
  });

  test("stay quiet for a failed run, sync or async, and for a nested run", async () => {
    const reg = notesRegistry();
    const changes: unknown[] = [];
    reg.onChange((c) => changes.push(c));
    assert.throws(() => reg.run("note.fail", {}, undefined), /it broke/);
    await assert.rejects(Promise.resolve(reg.run("note.fail_later", {}, undefined)), /it broke/);
    reg.run("note.add", { text: "inner" }, undefined, { nested: true });
    assert.deepEqual(changes, []);
  });

  test("a failing listener does not break the run or the other listeners", async () => {
    const reg = notesRegistry();
    const changes: unknown[] = [];
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      reg.onChange(() => {
        throw new Error("listener broke");
      });
      reg.onChange((c) => changes.push(c));
      assert.deepEqual(reg.run("note.add", { text: "a" }, undefined), { id: 1, text: "a" });
      assert.deepEqual(await reg.run("note.add_later", { text: "b" }, undefined), { id: 2, text: "b" });
    } finally {
      console.error = original;
    }
    assert.equal(changes.length, 2);
    assert.equal(errors.length, 2);
  });

  test("an async listener that rejects is caught too, and the later listeners still hear", async () => {
    const reg = notesRegistry();
    const changes: unknown[] = [];
    const errors: unknown[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => unhandled.push(err);
    process.on("unhandledRejection", onUnhandled);
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      reg.onChange(async () => {
        throw new Error("async listener broke");
      });
      reg.onChange((c) => changes.push(c));
      assert.deepEqual(reg.run("note.add", { text: "a" }, undefined), { id: 1, text: "a" });
      // a rejection nobody handles is reported once the microtasks run out
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      console.error = original;
      process.off("unhandledRejection", onUnhandled);
    }
    assert.deepEqual(unhandled, []);
    assert.equal(changes.length, 1);
    assert.equal(errors.length, 1);
  });

  test("an unsubscribed listener stops hearing", () => {
    const reg = notesRegistry();
    const changes: unknown[] = [];
    const off = reg.onChange((c) => changes.push(c));
    off();
    reg.run("note.add", { text: "a" }, undefined);
    assert.equal(changes.length, 0);
  });
});
