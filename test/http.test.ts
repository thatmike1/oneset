// the HTTP door: the catalog and runs in the one wire format, errors rendered by status and code
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { after, before, describe, test } from "node:test";
import { z } from "zod";
import { doors } from "../src/doors/index.ts";
import { ActionError, createRegistry, defineAction } from "../src/index.ts";
import { notesRegistry } from "./fixtures/notes.ts";
import { json, raw, type Served, serve } from "./helpers.ts";

describe("the http door", () => {
  let app: Served;
  const changes: unknown[] = [];
  before(async () => {
    const reg = notesRegistry();
    reg.onChange((c) => changes.push(c));
    app = await serve(doors(reg, { name: "notes" }));
  });
  after(() => app.close());

  test("GET /api/actions is the catalog", async () => {
    const res = await raw(app.port, { path: "/api/actions" });
    assert.equal(res.status, 200);
    assert.match(String(res.headers["content-type"]), /^application\/json/);
    const body = res.json();
    assert.deepEqual(Object.keys(body), ["app", "actions"]);
    assert.equal(body.app, "notes");
    assert.deepEqual(body.actions[0], {
      name: "note.add",
      tool: "note_add",
      area: "notes",
      summary: "Add a note",
      mutates: true,
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { text: { type: "string", minLength: 1 } },
        required: ["text"],
      },
    });
  });

  test("POST /api/actions/<name> runs it and answers { result }", async () => {
    const res = await raw(app.port, { path: "/api/actions/note.add", ...json({ text: "milk" }) });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json(), { result: { id: 1, text: "milk" } });
    assert.deepEqual(changes.at(-1), { action: "note.add", door: "http" });
  });

  test("an async handler is awaited", async () => {
    const res = await raw(app.port, { path: "/api/actions/note.add_later", ...json({ text: "eggs" }) });
    assert.deepEqual(res.json(), { result: { id: 2, text: "eggs" } });
  });

  test("an empty body is an empty input", async () => {
    const res = await raw(app.port, {
      method: "POST",
      path: "/api/actions/note.count",
      headers: { "content-type": "application/json" },
    });
    assert.deepEqual(res.json(), { result: 2 });
  });

  test("an unknown action is 404 { error }", async () => {
    const res = await raw(app.port, { path: "/api/actions/note.nope", ...json({}) });
    assert.equal(res.status, 404);
    assert.deepEqual(res.json(), { error: { code: "unknown_action", message: "no action named note.nope" } });
  });

  test("invalid input is 400 with issues", async () => {
    const res = await raw(app.port, { path: "/api/actions/note.add", ...json({ text: "" }) });
    assert.equal(res.status, 400);
    const { error } = res.json();
    assert.equal(error.code, "invalid_input");
    assert.equal(error.issues[0].path[0], "text");
  });

  test("a thrown plain error is a 500 that says nothing of the inside", async () => {
    const original = console.error;
    console.error = () => {};
    try {
      const res = await raw(app.port, { path: "/api/actions/note.fail_later", ...json({}) });
      assert.equal(res.status, 500);
      assert.deepEqual(res.json(), { error: { code: "internal", message: "something broke on the server" } });
    } finally {
      console.error = original;
    }
  });

  test("any thrown error with a status and code is rendered by them, ActionError or not", async () => {
    class HttpError extends Error {
      status = 410;
      code = "link_gone";
    }
    const reg = createRegistry([
      defineAction({
        name: "x.gone",
        area: "x",
        summary: "gone",
        mutates: false,
        input: z.object({}),
        run: () => {
          throw new HttpError("this link was used already");
        },
      }),
    ]);
    const other = await serve(doors(reg, { name: "x" }));
    try {
      const res = await raw(other.port, { path: "/api/actions/x.gone", ...json({}) });
      assert.equal(res.status, 410);
      assert.deepEqual(res.json(), { error: { code: "link_gone", message: "this link was used already" } });
    } finally {
      await other.close();
    }
  });

  test("a wrong method on a kit path is 405, and other paths fall through to the app", async () => {
    const res = await raw(app.port, { method: "DELETE", path: "/api/actions" });
    assert.equal(res.status, 405);
    assert.equal(res.headers.allow, "GET");
    const get = await raw(app.port, { path: "/api/actions/note.add" });
    assert.equal(get.status, 405);
    assert.equal(get.headers.allow, "POST");
    const other = await raw(app.port, { path: "/elsewhere" });
    assert.deepEqual([other.status, other.text], [404, "app"]);
  });
});

describe("errors with extras, callers and door options", () => {
  let app: Served;
  const reg = createRegistry(
    [
      defineAction({
        name: "tape.set",
        area: "tape",
        summary: "Set the tape",
        mutates: true,
        input: z.object({ v: z.number() }),
        run: (input) => {
          if (input.v < 0) {
            throw new ActionError(409, "stale", "the tape moved", { body: { tape: [1, 2] } });
          }
          return input.v;
        },
      }),
      defineAction({
        name: "tape.secret",
        area: "tape",
        summary: "Not on the http door",
        mutates: false,
        input: z.object({}),
        run: () => "secret",
      }),
      defineAction({
        name: "tape.who",
        area: "tape",
        summary: "Who is asking",
        mutates: false,
        input: z.object({}),
        run: (_input, ctx: { user: string; door: string }) => ctx,
      }),
    ],
    {
      allow(_def, caller: { user: string } | undefined) {
        if (!caller) throw new ActionError(401, "signed_out", "sign in");
      },
    },
  );
  before(async () => {
    app = await serve(
      doors(reg, {
        name: "tape",
        caller: async (req, door) => {
          const auth = req.headers.authorization;
          if (auth === "Bearer bad") {
            throw new ActionError(401, "bad_key", "that key is unknown", {
              headers: { "www-authenticate": 'Bearer realm="agents"' },
            });
          }
          return auth === "Bearer good" ? { user: "mike", door } : undefined;
        },
        http: {
          list: (def) => def.name !== "tape.secret",
          render: (def, outcome) => (def.name === "tape.set" ? { value: outcome } : outcome),
        },
      }),
    );
  });
  after(() => app.close());

  const good = { authorization: "Bearer good" };

  test("ActionError's body replaces the plain error body", async () => {
    const res = await raw(app.port, {
      path: "/api/actions/tape.set",
      ...json({ v: -1 }),
      headers: { ...good, "content-type": "application/json" },
    });
    assert.equal(res.status, 409);
    assert.deepEqual(res.json(), { tape: [1, 2] });
  });

  test("a refused caller's headers are sent", async () => {
    const res = await raw(app.port, { path: "/api/actions", headers: { authorization: "Bearer bad" } });
    assert.equal(res.status, 401);
    assert.equal(res.headers["www-authenticate"], 'Bearer realm="agents"');
    assert.deepEqual(res.json(), { error: { code: "bad_key", message: "that key is unknown" } });
  });

  test("the caller is resolved per request and per door, and the catalog follows it", async () => {
    const none = await raw(app.port, { path: "/api/actions" });
    assert.deepEqual(none.json().actions, []);
    const res = await raw(app.port, { path: "/api/actions", headers: good });
    assert.deepEqual(
      res.json().actions.map((a: { name: string }) => a.name),
      ["tape.set", "tape.who"],
    );
    const who = await raw(app.port, {
      path: "/api/actions/tape.who",
      ...json({}),
      headers: { ...good, "content-type": "application/json" },
    });
    assert.deepEqual(who.json(), { result: { user: "mike", door: "http" } });
  });

  test("render shapes the result", async () => {
    const res = await raw(app.port, {
      path: "/api/actions/tape.set",
      ...json({ v: 3 }),
      headers: { ...good, "content-type": "application/json" },
    });
    assert.deepEqual(res.json(), { result: { value: 3 } });
  });

  test("an action the http door does not list cannot be run through it", async () => {
    const res = await raw(app.port, {
      path: "/api/actions/tape.secret",
      ...json({}),
      headers: { ...good, "content-type": "application/json" },
    });
    assert.equal(res.status, 403);
    assert.equal(res.json().error.code, "not_listed");
    assert.equal(reg.run("tape.secret", {}, { user: "mike" }), "secret");
  });

  test("allow's error comes before the not-listed refusal", async () => {
    const res = await raw(app.port, { path: "/api/actions/tape.secret", ...json({}) });
    assert.equal(res.status, 401);
    assert.equal(res.json().error.code, "signed_out");
  });
});

describe("base", () => {
  test("moves every kit path under a prefix", async () => {
    const app = await serve(doors(notesRegistry(), { name: "notes", base: "/kit" }));
    try {
      assert.equal((await raw(app.port, { path: "/kit/api/actions" })).status, 200);
      assert.deepEqual((await raw(app.port, { path: "/api/actions" })).text, "app");
      const res = await raw(app.port, { path: "/kit/api/actions/note.add", ...json({ text: "x" }) });
      assert.deepEqual(res.json(), { result: { id: 1, text: "x" } });
    } finally {
      await app.close();
    }
  });

  test("a base must start with a slash and not end with one", () => {
    assert.throws(() => doors(notesRegistry(), { name: "notes", base: "kit" }), /base/);
    assert.throws(() => doors(notesRegistry(), { name: "notes", base: "/kit/" }), /base/);
  });
});

describe("malformed paths", () => {
  // the server runs in a child process, the way the example mounts the doors, so a crash shows
  // up as a dead process instead of taking the test runner down with it
  const SERVER = `
    import { createServer } from "node:http";
    import { doors } from ${JSON.stringify(new URL("../src/doors/index.ts", import.meta.url).href)};
    import { notesRegistry } from ${JSON.stringify(new URL("./fixtures/notes.ts", import.meta.url).href)};
    const handle = doors(notesRegistry(), { name: "notes" });
    const server = createServer(async (req, res) => {
      if (await handle(req, res)) return;
      res.writeHead(404).end("app");
    });
    server.listen(0, "127.0.0.1", () => console.log(server.address().port));
  `;
  let child: ChildProcess;
  let port = 0;
  let exited: number | null = null;
  before(async () => {
    child = spawn(process.execPath, ["--input-type=module", "--no-warnings", "-e", SERVER], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.on("exit", (code) => {
      exited = code ?? -1;
    });
    port = await new Promise<number>((resolve, reject) => {
      child.stdout?.once("data", (d: Buffer) => resolve(Number(String(d).trim())));
      child.once("exit", () => reject(new Error("the server did not start")));
    });
  });
  after(() => {
    child.kill();
  });

  test("a bad percent-encoding in an action name is a 400 and the server stays up", async () => {
    for (const path of ["/api/actions/%", "/api/actions/%E0%A4%A", "/api/actions/note%2"]) {
      const res = await raw(port, { path, ...json({}) });
      assert.equal(res.status, 400, path);
      assert.equal(res.json().error.code, "bad_path");
    }
    assert.equal(exited, null, "the server is still running");
    assert.equal((await raw(port, { path: "/api/actions" })).status, 200);
  });

  test("the guard still answers first for a foreign Host", async () => {
    const res = await raw(port, { path: "/api/actions/%", ...json({}), headers: { host: "evil.example" } });
    assert.equal(res.status, 403);
  });

  test("a request target URL cannot parse falls through to the app", async () => {
    for (const path of ["//", "//[", "//a:b@"]) {
      const res = await raw(port, { path });
      assert.equal(res.status, 404, path);
      assert.equal(res.text, "app");
    }
    assert.equal(exited, null, "the server is still running");
  });
});
