// the served files: the CLI run as a child process, the skill, the browser client, the setup
// page, and `base` and `url` moving all of them
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { promisify } from "node:util";
import { z } from "zod";
import { setupLines } from "../src/doors/files.ts";
import { doors } from "../src/doors/index.ts";
import { ActionError, createRegistry, defineAction } from "../src/index.ts";
import { notesRegistry } from "./fixtures/notes.ts";
import { FetchEventSource, raw, type Served, serve } from "./helpers.ts";

const run = promisify(execFile);
const dir = mkdtempSync(join(tmpdir(), "oneset-served-"));
after(() => rmSync(dir, { recursive: true, force: true }));

/** runs the served CLI in a child process with its own config folder */
async function cli(file: string, args: string[], env: Record<string, string> = {}) {
  try {
    const out = await run(process.execPath, [file, ...args], {
      env: { PATH: process.env.PATH ?? "", XDG_CONFIG_HOME: join(dir, "config"), ...env },
    });
    return { code: 0, stdout: out.stdout, stderr: out.stderr };
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

describe("the served CLI", () => {
  let app: Served;
  let file: string;
  before(async () => {
    app = await serve(doors(notesRegistry(), { name: "Notes" }));
    const res = await raw(app.port, { path: "/cli/notes.mjs" });
    assert.equal(res.status, 200);
    assert.match(String(res.headers["content-type"]), /^text\/javascript/);
    file = join(dir, "notes.mjs");
    writeFileSync(file, res.text);
  });
  after(() => app.close());

  test("is served with the app's name, address and env prefix filled in", () => {
    const text = readFileSync(file, "utf8");
    assert.match(text, /^#!\/usr\/bin\/env node/);
    assert.ok(
      text.includes(
        `const APP = {"name":"Notes","slug":"notes","url":"http://127.0.0.1:${app.port}","env":"NOTES"};`,
      ),
    );
  });

  test("needs no login or env vars for a local app", async () => {
    const actions = await cli(file, ["actions"]);
    assert.equal(actions.code, 0, actions.stderr);
    assert.match(actions.stdout, /^notes\n {2}note\.add +Add a note\n/);
    const help = await cli(file, ["help", "note.add"]);
    assert.match(help.stdout, /--text string \(required\)/);
  });

  test("runs an action from flags and prints the result", async () => {
    const add = await cli(file, ["note.add", "--text", "milk"]);
    assert.equal(add.code, 0, add.stderr);
    assert.deepEqual(JSON.parse(add.stdout), { id: 1, text: "milk" });
    const json = await cli(file, ["note.add", "--json", '{"text":"eggs"}']);
    assert.deepEqual(JSON.parse(json.stdout), { id: 2, text: "eggs" });
    const count = await cli(file, ["note.count"]);
    assert.equal(count.stdout, "2\n");
  });

  test("takes an action by its MCP tool spelling too, so instructions name it once", async () => {
    const help = await cli(file, ["help", "note_add"]);
    assert.equal(help.code, 0, help.stderr);
    assert.match(help.stdout, /^note\.add: Add a note/);
    const count = await cli(file, ["note_count"]);
    assert.equal(count.code, 0, count.stderr);
    assert.match(count.stdout, /^\d+\n$/);
  });

  test("an error exits non-zero with the code and message", async () => {
    const bad = await cli(file, ["note.add", "--text", ""]);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /^invalid_input: /);
    const unknown = await cli(file, ["note.nope"]);
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /no action note\.nope/);
  });

  test("the env prefix points it elsewhere", async () => {
    const out = await cli(file, ["actions"], { NOTES_URL: "http://127.0.0.1:9" });
    assert.equal(out.code, 1);
    assert.match(out.stderr, /cannot reach http:\/\/127\.0\.0\.1:9/);
  });

  test("login checks against the catalog before saving", async () => {
    const config = join(dir, "config", "notes", "config.json");
    const bad = await cli(file, ["login", "http://127.0.0.1:9"]);
    assert.equal(bad.code, 1);
    assert.throws(() => readFileSync(config));
    const good = await cli(file, ["login", app.url]);
    assert.equal(good.code, 0, good.stderr);
    assert.match(good.stdout, /connected to Notes: 6 actions/);
    assert.deepEqual(JSON.parse(readFileSync(config, "utf8")), { url: app.url });
  });
});

describe("the CLI with an agent key", () => {
  let app: Served;
  let file: string;
  const reg = createRegistry(
    [
      defineAction({
        name: "item.list",
        area: "items",
        summary: "Items",
        mutates: false,
        input: z.object({}),
        run: (_input, who: { user: string }) => [`${who.user}'s item`],
      }),
    ],
    {},
  );
  before(async () => {
    app = await serve(
      doors(reg, {
        name: "keyed",
        caller: (req) => {
          if (req.headers.authorization !== "Bearer sekret") {
            throw new ActionError(401, "no_key", "send your agent key as a bearer token");
          }
          return { user: "mike" };
        },
      }),
    );
    file = join(dir, "keyed.mjs");
    writeFileSync(file, (await raw(app.port, { path: "/cli/keyed.mjs" })).text);
  });
  after(() => app.close());

  test("login refuses a wrong key and keeps a right one", async () => {
    const wrong = await cli(file, ["login", app.url, "nope"]);
    assert.equal(wrong.code, 1);
    assert.match(wrong.stderr, /^no_key: /);
    const right = await cli(file, ["login", app.url, "sekret"]);
    assert.equal(right.code, 0, right.stderr);
    const list = await cli(file, ["item.list"]);
    assert.deepEqual(JSON.parse(list.stdout), ["mike's item"]);
  });

  test("the key also comes from the env", async () => {
    const out = await cli(file, ["item.list"], { KEYED_KEY: "sekret", XDG_CONFIG_HOME: join(dir, "empty") });
    assert.deepEqual(JSON.parse(out.stdout), ["mike's item"]);
  });

  test("the setup page and the skill line ask for a key", async () => {
    const page = await raw(app.port, { path: "/setup", headers: { authorization: "Bearer sekret" } });
    assert.match(page.text, /--header &quot;Authorization: Bearer &lt;agent key&gt;&quot;/);
    assert.match(page.text, /keyed login http:\/\/127\.0\.0\.1:\d+ &quot;&lt;agent key&gt;&quot;/);
    const skill = await raw(app.port, { path: "/skill/SKILL.md" });
    assert.equal(skill.status, 401, "the skill is resolved for a caller like the API");
  });
});

describe("the setup lines", () => {
  test("a url with shell characters is quoted, and the shell reads it back unchanged", async () => {
    for (const url of [
      "https://example.test/notes(v2)",
      "https://example.test/a&b",
      "https://example.test/it's",
    ]) {
      for (const signIn of [false, true]) {
        const lines = setupLines({ name: "Test", slug: "test", url, signIn });
        for (const [kind, line] of Object.entries({ mcp: lines.mcp, cli: lines.cli, skill: lines.skill })) {
          const parsed = await run("bash", ["-n", "-c", line]).then(
            () => "ok",
            (err: { stderr: string }) => err.stderr,
          );
          assert.equal(parsed, "ok", `${kind} line, ${url}: ${line}`);
        }
        // the quoted address is the address: print the words bash would pass to claude
        const words = await run("bash", [
          "-c",
          `set -- ${lines.mcp.replace(/^claude /, "")}; printf '%s\\n' "$@"`,
        ]);
        assert.ok(words.stdout.split("\n").includes(`${url}/mcp`), words.stdout);
      }
    }
  });

  test("every shell line parses, with and without a key", async () => {
    for (const signIn of [false, true]) {
      const lines = setupLines({ name: "Keyed", slug: "keyed", url: "http://127.0.0.1:9/kit", signIn });
      for (const [kind, line] of Object.entries({ mcp: lines.mcp, cli: lines.cli, skill: lines.skill })) {
        const parsed = await run("bash", ["-n", "-c", line]).then(
          () => "ok",
          (err: { stderr: string }) => err.stderr,
        );
        assert.equal(parsed, "ok", `${kind} line, signIn ${signIn}: ${line}`);
      }
    }
  });
});

describe("the skill", () => {
  let app: Served;
  before(async () => {
    app = await serve(
      doors(notesRegistry(), {
        name: "notes",
        instructions: "Add notes with note_add; read them with note_list.",
        when: "Use when the person mentions their notes: lists, reminders, things to keep.",
        mcp: { list: (def) => !def.name.includes("fail") },
      }),
    );
  });
  after(() => app.close());

  test("is generated from the MCP door's tools with the instructions and when-line", async () => {
    const res = await raw(app.port, { path: "/skill/SKILL.md" });
    assert.equal(res.status, 200);
    assert.match(String(res.headers["content-type"]), /^text\/markdown/);
    const [, front, body] = res.text.split(/^---\n/m);
    assert.equal(
      front,
      `name: notes\ndescription: "notes: Use when the person mentions their notes: lists, reminders, things to keep."\n`,
    );
    assert.match(body ?? "", /^\n# notes\n\nAdd notes with note_add; read them with note_list\.\n/);
    assert.match(
      body ?? "",
      /claude mcp add --scope user --transport http notes http:\/\/127\.0\.0\.1:\d+\/mcp/,
    );
    assert.match(body ?? "", /- `note_add` \(CLI `notes note_add`\): Add a note\n/);
    assert.ok(!(body ?? "").includes("note_fail"), "tools the MCP door hides stay out");
  });
});

describe("the browser client", () => {
  const reg = notesRegistry();
  let app: Served;
  /** the served module's surface */
  let client: {
    act(name: string, input?: unknown): Promise<any>;
    actions(): Promise<{ name: string }[]>;
    onChange(fn: (change: unknown) => void): () => void;
    ActionError: new (...args: any[]) => Error & { status: number; code: string; issues?: unknown };
  };
  before(async () => {
    app = await serve(doors(reg, { name: "notes" }));
    const res = await raw(app.port, { path: "/actions.js" });
    assert.equal(res.status, 200);
    assert.match(String(res.headers["content-type"]), /^text\/javascript/);
    const file = join(dir, "actions.mjs");
    writeFileSync(file, res.text);
    (globalThis as { EventSource?: unknown }).EventSource = FetchEventSource;
    client = await import(file);
  });
  after(() => app.close());

  test("act runs an action and returns its result", async () => {
    assert.deepEqual(await client.act("note.add", { text: "from the page" }), {
      id: 1,
      text: "from the page",
    });
    assert.equal(await client.act("note.count"), 1);
    assert.deepEqual((await client.actions()).map((a: { name: string }) => a.name).slice(0, 2), [
      "note.add",
      "note.list",
    ]);
  });

  test("a failure throws an ActionError with status, code and issues", async () => {
    await assert.rejects(client.act("note.add", { text: "" }), (err: unknown) => {
      const e = err as InstanceType<typeof client.ActionError>;
      return (
        e instanceof client.ActionError &&
        e.status === 400 &&
        e.code === "invalid_input" &&
        Array.isArray(e.issues)
      );
    });
  });

  test("onChange hears the stream open, an agent's change, then a reconnect", async () => {
    const heard: unknown[] = [];
    const waitFor = async (list: unknown[], n: number) => {
      for (let i = 0; i < 100 && list.length < n; i++) await new Promise((r) => setTimeout(r, 10));
    };
    const stop = client.onChange((change: unknown) => heard.push(change));
    try {
      // the first open is a change too: what happened between the page's fetch and the stream
      // going live is only caught by refetching once it is live
      await waitFor(heard, 1);
      assert.deepEqual(heard, [{ connected: true }]);
      reg.run("note.add", { text: "from an agent" }, undefined, { door: "mcp" });
      await waitFor(heard, 2);
      assert.deepEqual(heard[1], { action: "note.add", door: "mcp" });
      // a listener added while the stream is already live hears that it is
      const late: unknown[] = [];
      const stopLate = client.onChange((change: unknown) => late.push(change));
      await waitFor(late, 1);
      assert.deepEqual(late, [{ connected: true }]);
      stopLate();
      // drop every connection: the client comes back and listeners refetch
      app.server.closeAllConnections();
      await waitFor(heard, 3);
      assert.deepEqual(heard[2], { reconnected: true });
    } finally {
      stop();
    }
  });
});

describe("the browser client from the package", () => {
  test("createClient takes the address, fetch and EventSource, so a tested module can use it", async () => {
    const reg = notesRegistry();
    const app = await serve(doors(reg, { name: "notes", base: "/kit" }));
    const { createClient } = await import("../src/doors/browser.js");
    const fetched: string[] = [];
    const client = createClient({
      url: `${app.url}/kit/`,
      fetch: (url, init) => {
        fetched.push(url);
        return fetch(url, init);
      },
      EventSource: FetchEventSource,
    });
    const heard: unknown[] = [];
    const stop = client.onChange((change) => heard.push(change));
    try {
      for (let i = 0; i < 100 && heard.length < 1; i++) await new Promise((r) => setTimeout(r, 10));
      assert.deepEqual(await client.act("note.add", { text: "from a test" }), { id: 1, text: "from a test" });
      for (let i = 0; i < 100 && heard.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
      assert.deepEqual(heard, [{ connected: true }, { action: "note.add", door: "http" }]);
      assert.deepEqual(fetched, [`${app.url}/kit/api/actions/note.add`]);
    } finally {
      stop();
      await app.close();
    }
  });
});

describe("the browser client's listeners", () => {
  test("an async listener that rejects is caught, and the later listeners still hear", async () => {
    const reg = notesRegistry();
    const app = await serve(doors(reg, { name: "notes" }));
    const file = join(dir, "actions-listeners.mjs");
    writeFileSync(file, (await raw(app.port, { path: "/actions.js" })).text);
    (globalThis as { EventSource?: unknown }).EventSource = FetchEventSource;
    const client: { onChange(fn: (change: unknown) => unknown): () => void } = await import(file);
    const heard: unknown[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => unhandled.push(err);
    process.on("unhandledRejection", onUnhandled);
    const original = console.error;
    console.error = () => {};
    const stopFailing = client.onChange(async () => {
      throw new Error("async listener broke");
    });
    const stop = client.onChange((change) => heard.push(change));
    try {
      await new Promise((r) => setTimeout(r, 100));
      reg.run("note.add", { text: "from an agent" }, undefined, { door: "mcp" });
      for (let i = 0; i < 100 && heard.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      stopFailing();
      stop();
      console.error = original;
      process.off("unhandledRejection", onUnhandled);
      await app.close();
    }
    assert.deepEqual(heard, [{ connected: true }, { action: "note.add", door: "mcp" }]);
    assert.deepEqual(unhandled, []);
  });
});

describe("the setup page", () => {
  test("gives the MCP line, the JSON config, the CLI line and the skill line, escaped", async () => {
    const app = await serve(doors(notesRegistry(), { name: "notes <&>" }));
    try {
      const res = await raw(app.port, { path: "/setup" });
      assert.equal(res.status, 200);
      assert.match(String(res.headers["content-type"]), /^text\/html/);
      const url = `http://127.0.0.1:${app.port}`;
      assert.ok(res.text.includes(`claude mcp add --scope user --transport http notes ${url}/mcp`));
      assert.ok(res.text.includes(`&quot;url&quot;: &quot;${url}/mcp&quot;`));
      assert.ok(res.text.includes(`curl -fsSL ${url}/cli/notes.mjs -o ~/.local/bin/notes`));
      assert.ok(res.text.includes(`curl -fsSL ${url}/skill/SKILL.md -o ~/.claude/skills/notes/SKILL.md`));
      assert.ok(res.text.includes("<title>notes &lt;&amp;&gt;: agent setup</title>"));
      assert.ok(!res.text.includes("<&>"));
      assert.ok(res.text.includes("No sign-in or key needed."));
    } finally {
      await app.close();
    }
  });
});

describe("base and url", () => {
  test("base moves every path, and the served files point under it", async () => {
    const app = await serve(doors(notesRegistry(), { name: "notes", base: "/kit" }));
    try {
      const root = `http://127.0.0.1:${app.port}/kit`;
      for (const path of ["/api/actions", "/cli/notes.mjs", "/skill/SKILL.md", "/actions.js", "/setup"]) {
        assert.equal((await raw(app.port, { path: `/kit${path}` })).status, 200, path);
        assert.equal((await raw(app.port, { path })).text, "app", `${path} without the base is the app's`);
      }
      assert.ok((await raw(app.port, { path: "/kit/cli/notes.mjs" })).text.includes(`"url":"${root}"`));
      assert.ok(
        (await raw(app.port, { path: "/kit/actions.js" })).text.includes(
          `const SETTINGS = {"url":"${root}"};`,
        ),
      );
      assert.ok((await raw(app.port, { path: "/kit/setup" })).text.includes(`${root}/mcp`));
      const mcp = await raw(app.port, {
        method: "POST",
        path: "/kit/mcp",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      assert.deepEqual(mcp.json(), { jsonrpc: "2.0", id: 1, result: {} });
    } finally {
      await app.close();
    }
  });

  test("url sets the address the served files give out", async () => {
    const app = await serve(
      doors(notesRegistry(), {
        name: "notes",
        url: "https://notes.example.com/",
        hosts: ["notes.example.com"],
        openWithoutSignIn: true,
      }),
    );
    try {
      const res = await raw(app.port, { path: "/setup", headers: { host: "notes.example.com" } });
      assert.ok(
        res.text.includes("claude mcp add --scope user --transport http notes https://notes.example.com/mcp"),
      );
    } finally {
      await app.close();
    }
  });
});

describe("a null error body", () => {
  test("the browser client and the CLI fall back to the HTTP status instead of a TypeError", async () => {
    const reg = createRegistry([
      defineAction({
        name: "note.gone",
        area: "notes",
        summary: "always 409 with a null body",
        mutates: false,
        input: z.object({}),
        run: () => {
          throw new ActionError(409, "no_note", "no note", { body: null });
        },
      }),
    ]);
    const app = await serve(doors(reg, { name: "nulls" }));
    try {
      const { createClient } = await import("../src/doors/browser.js");
      await assert.rejects(createClient({ url: app.url }).act("note.gone"), (err: unknown) => {
        const e = err as { name: string; status: number; code: string };
        return e.name === "ActionError" && e.status === 409 && e.code === "http";
      });
      const file = join(dir, "nulls.mjs");
      writeFileSync(file, (await raw(app.port, { path: "/cli/nulls.mjs" })).text);
      const out = await cli(file, ["note.gone"]);
      assert.equal(out.code, 1);
      assert.equal(out.stderr, "409: request failed\n");
    } finally {
      await app.close();
    }
  });
});
