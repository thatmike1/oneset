// long actions: every door answers at once with a job, the kit's job.get reads it, and the change
// event comes when the work finishes. Through the core door, HTTP, MCP with the official SDK
// client, the served CLI as a child process, the browser client and the change stream
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { createClient } from "../src/doors/browser.js";
import { doors } from "../src/doors/index.ts";
import { ActionError, createRegistry, defineAction, type JobView } from "../src/index.ts";
import { FetchEventSource, openEvents, raw, type Served, serve } from "./helpers.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** a gate a test opens by hand, so it decides when a long run finishes */
function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

/** a looks app: one slow roll (the uncharted case), a fast read, and ways for a roll to fail */
function looksApp(options: { gates?: Map<string, ReturnType<typeof gate>>; ms?: number } = {}) {
  const rolls: string[] = [];
  const ran: string[] = [];
  const actions = [
    defineAction({
      name: "look.roll",
      area: "looks",
      summary: "Roll six new looks",
      mutates: true,
      long: true,
      input: z.object({ for: z.string().min(1), fail: z.enum(["action", "plain", "sync"]).optional() }),
      run: async (input) => {
        ran.push(input.for);
        if (input.fail === "sync") throw new ActionError(409, "busy", "a roll is running");
        const g = options.gates?.get(input.for);
        if (g) await g.opened;
        else await sleep(options.ms ?? 30);
        if (input.fail === "action") {
          throw new ActionError(422, "no_chart", "there is no chart to roll against", {
            issues: [{ path: ["for"], message: "chart missing" }],
          });
        }
        if (input.fail === "plain") throw new Error("the model fell over");
        rolls.push(input.for);
        return { looks: 6, for: input.for };
      },
    }),
    defineAction({
      name: "look.count",
      area: "looks",
      summary: "How many rolls",
      mutates: false,
      input: z.object({}),
      run: () => rolls.length,
    }),
  ] as const;
  return { actions, rolls, ran };
}

describe("a long action through a door", () => {
  test("answers at once with a running job, and job.get reads it until it is done", async () => {
    const gates = new Map([["a puppy page", gate()]]);
    const app = looksApp({ gates });
    const reg = createRegistry(app.actions);
    const door = reg.door({ name: "page", render: (def, out) => ({ rendered: def.name, out }) });
    assert.equal(door.starts("look.roll"), true);
    assert.equal(door.starts("look.count"), false);
    const started = door.run("look.roll", { for: "a puppy page" }, undefined) as { job: JobView };
    assert.equal(typeof (started as { then?: unknown }).then, "undefined", "the start does not wait");
    assert.equal(started.job.state, "running");
    assert.equal(started.job.action, "look.roll");
    assert.match(started.job.id, /^[0-9a-f-]{36}$/);
    const id = started.job.id;
    assert.equal((door.run("job.get", { id, wait: 0 }, undefined) as JobView).state, "running");
    gates.get("a puppy page")?.open();
    const done = (await door.run("job.get", { id }, undefined)) as JobView;
    assert.equal(done.state, "done");
    assert.deepEqual(done.result, { rendered: "look.roll", out: { looks: 6, for: "a puppy page" } });
    assert.ok(done.finished && done.finished >= done.started);
  });

  test("job.get waits for the job up to wait seconds, and no longer", async () => {
    const gates = new Map([["slow", gate()]]);
    const reg = createRegistry(looksApp({ gates }).actions);
    const door = reg.door({ name: "page" });
    const { job } = door.run("look.roll", { for: "slow" }, undefined) as { job: JobView };
    const t0 = Date.now();
    const still = (await door.run("job.get", { id: job.id, wait: 0.2 }, undefined)) as JobView;
    assert.equal(still.state, "running");
    assert.ok(Date.now() - t0 >= 180);
    setTimeout(() => gates.get("slow")?.open(), 50);
    const t1 = Date.now();
    const done = (await door.run("job.get", { id: job.id, wait: 5 }, undefined)) as JobView;
    assert.equal(done.state, "done");
    assert.ok(Date.now() - t1 < 2000, "it answered when the job finished, not at the end of the wait");
    assert.throws(
      () => door.run("job.get", { id: job.id, wait: 51 }, undefined),
      (err: unknown) => err instanceof ActionError && err.code === "invalid_input",
    );
  });

  test("a refusal or bad input answers at once, with no job and no run", () => {
    const app = looksApp();
    const reg = createRegistry(app.actions, {
      allow(_def, caller: { ok?: boolean } | undefined) {
        if (!caller?.ok) throw new ActionError(401, "signed_out", "sign in");
      },
    });
    const door = reg.door({ name: "page" });
    assert.throws(
      () => door.run("look.roll", { for: "x" }, undefined),
      (err: unknown) => err instanceof ActionError && err.code === "signed_out",
    );
    assert.throws(
      () => door.run("look.roll", { for: "" }, { ok: true }),
      (err: unknown) => err instanceof ActionError && err.code === "invalid_input",
    );
    assert.deepEqual(app.ran, []);
  });

  test("what the run throws lands in the job: an ActionError as it is, anything else as internal", async () => {
    const reg = createRegistry(looksApp().actions);
    const door = reg.door({ name: "page" });
    const read = async (input: Record<string, unknown>) => {
      const { job } = door.run("look.roll", input, undefined) as { job: JobView };
      return (await door.run("job.get", { id: job.id }, undefined)) as JobView;
    };
    const action = await read({ for: "x", fail: "action" });
    assert.equal(action.state, "failed");
    assert.deepEqual(action.error, {
      status: 422,
      code: "no_chart",
      message: "there is no chart to roll against",
      issues: [{ path: ["for"], message: "chart missing" }],
    });
    assert.equal(action.result, undefined);
    // a handler that throws before its first await still answers with a job, which then failed
    const sync = await read({ for: "x", fail: "sync" });
    assert.deepEqual([sync.state, sync.error?.code], ["failed", "busy"]);
    const original = console.error;
    const logged: unknown[] = [];
    console.error = (...args: unknown[]) => logged.push(args);
    try {
      const plain = await read({ for: "x", fail: "plain" });
      assert.deepEqual(plain.error, {
        status: 500,
        code: "internal",
        message: "something broke on the server",
      });
      assert.equal(logged.length, 1, "the real error is logged on the server");
    } finally {
      console.error = original;
    }
  });

  test("reg.run from app code, and a nested run, run the long action inline", async () => {
    const app = looksApp();
    const reg = createRegistry(app.actions);
    assert.deepEqual(await reg.run("look.roll", { for: "direct" }, undefined), { looks: 6, for: "direct" });
    assert.deepEqual(
      await reg.run("look.roll", { for: "nested" }, undefined, { nested: true, door: "http" }),
      {
        looks: 6,
        for: "nested",
      },
    );
    assert.deepEqual(app.rolls, ["direct", "nested"]);
  });

  test("job.get is listed only where a long action is, and skips the app's hooks", () => {
    const seen: string[] = [];
    const reg = createRegistry(looksApp().actions, {
      allow(def, caller: { rolls?: boolean } | undefined) {
        seen.push(`allow ${def.name}`);
        if (def.name === "look.roll" && !caller?.rolls) throw new ActionError(403, "no", "no rolls");
      },
      schema: (def) => def.input.extend({ space: z.string().optional() }),
    });
    const door = reg.door({
      name: "page",
      describe: (def) => ({ summary: `app: ${def.summary}` }),
    });
    assert.deepEqual(
      door.catalog({ rolls: true }).map((a) => [a.name, a.tool, a.long]),
      [
        ["look.roll", "look_roll", true],
        ["look.count", "look_count", undefined],
        ["job.get", "job_get", undefined],
      ],
    );
    assert.deepEqual(
      door.catalog({ rolls: false }).map((a) => a.name),
      ["look.count"],
    );
    const jobEntry = door.catalog({ rolls: true }).find((a) => a.name === "job.get");
    assert.match(jobEntry?.summary ?? "", /^Read a long action's job/);
    assert.deepEqual(Object.keys(jobEntry?.inputSchema.properties ?? {}), ["id", "wait"]);
    assert.ok(!seen.includes("allow job.get"), "the app's allow never sees the kit's action");
    // no long action, no job.get
    const plain = createRegistry([looksApp().actions[1]]);
    assert.equal(plain.get("job.get"), undefined);
    assert.throws(
      () => plain.door({ name: "page" }).run("job.get", { id: "x" }, undefined),
      (err: unknown) => err instanceof ActionError && err.code === "unknown_action",
    );
  });

  test("a caller reads a job only when it may run that action there, and owns it", async () => {
    const reg = createRegistry(looksApp().actions, {
      allow(def, who: { user: string; rolls: boolean }) {
        if (def.name === "look.roll" && !who.rolls) throw new ActionError(403, "no", "no rolls");
      },
      jobOwner: (who) => who.user,
    });
    const page = reg.door({ name: "page" });
    const narrow = reg.door({ name: "narrow", list: (def) => def.name !== "look.roll" });
    const mike = { user: "mike", rolls: true };
    const { job } = page.run("look.roll", { for: "x" }, mike) as { job: JobView };
    const unknown = (err: unknown) =>
      err instanceof ActionError && err.code === "unknown_job" && err.status === 404;
    assert.throws(
      () => page.run("job.get", { id: job.id, wait: 0 }, { user: "gabca", rolls: true }),
      unknown,
    );
    assert.throws(
      () => page.run("job.get", { id: job.id, wait: 0 }, { user: "mike", rolls: false }),
      unknown,
    );
    assert.throws(() => narrow.run("job.get", { id: job.id, wait: 0 }, mike), unknown);
    assert.throws(() => page.run("job.get", { id: "no-such-job", wait: 0 }, mike), unknown);
    assert.equal(((await page.run("job.get", { id: job.id }, mike)) as JobView).state, "done");
  });

  test("finished jobs are kept for keepMs and at most max of them; running ones stay", async () => {
    const gates = new Map([["held", gate()]]);
    const reg = createRegistry(looksApp({ gates, ms: 1 }).actions, { jobs: { keepMs: 100, max: 3 } });
    const door = reg.door({ name: "page" });
    const start = (name: string) =>
      (door.run("look.roll", { for: name }, undefined) as { job: JobView }).job.id;
    const read = (id: string, wait = 0) => door.run("job.get", { id, wait }, undefined);
    const held = start("held");
    const first = start("first");
    await read(first, 5);
    const ids = [start("a"), start("b"), start("c")];
    for (const id of ids) await read(id, 5);
    // over the cap: the oldest finished job went first, the running one stayed
    assert.throws(() => read(first), /unknown_job|no job/);
    assert.equal((read(held) as JobView).state, "running");
    await sleep(120);
    for (const id of ids) assert.throws(() => read(id), /no job/);
    gates.get("held")?.open();
    assert.equal(((await read(held, 5)) as JobView).state, "done");
  });

  test("an app action that takes the name job.get clashes with the kit's", () => {
    const own = defineAction({
      name: "job.get",
      area: "jobs",
      summary: "the app's own",
      mutates: false,
      input: z.object({}),
      run: () => 1,
    });
    assert.throws(() => createRegistry([...looksApp().actions, own]), /job\.get/);
    assert.doesNotThrow(() => createRegistry([looksApp().actions[1], own]), "fine with no long action");
  });
});

describe("a long action through the mounted doors", () => {
  const gates = new Map<string, ReturnType<typeof gate>>();
  const app = looksApp({ gates, ms: 150 });
  const reg = createRegistry(app.actions);
  let served: Served;
  const dir = mkdtempSync(join(tmpdir(), "oneset-jobs-"));
  before(async () => {
    served = await serve(
      doors(reg, {
        name: "uncharted",
        instructions: "Rolls looks with look_roll.",
        mcp: { render: (def, out) => (def.name === "look.roll" ? `rolled ${JSON.stringify(out)}` : out) },
      }),
    );
  });
  after(async () => {
    await served.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const post = (path: string, body: unknown) =>
    raw(served.port, {
      method: "POST",
      path,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("HTTP answers 202 with the job, and job.get 200 with its state", async () => {
    gates.set("http", gate());
    const res = await post("/api/actions/look.roll", { for: "http" });
    assert.equal(res.status, 202);
    const { job } = res.json() as { job: JobView };
    assert.deepEqual([job.action, job.state], ["look.roll", "running"]);
    assert.deepEqual(Object.keys(res.json()), ["job"]);
    const running = await post("/api/actions/job.get", { id: job.id, wait: 0 });
    assert.equal(running.status, 200);
    assert.equal(running.json().result.state, "running");
    gates.get("http")?.open();
    const done = await post("/api/actions/job.get", { id: job.id });
    assert.deepEqual(done.json().result.result, { looks: 6, for: "http" });
    const failed = await post("/api/actions/look.roll", { for: "f", fail: "action" });
    const failedJob = await post("/api/actions/job.get", { id: failed.json().job.id });
    assert.equal(failedJob.status, 200, "the read worked; the job is what failed");
    assert.equal(failedJob.json().result.error.code, "no_chart");
    const bad = await post("/api/actions/look.roll", { for: "" });
    assert.equal(bad.status, 400, "bad input is still refused at once");
    const missing = await post("/api/actions/job.get", { id: "nope" });
    assert.equal(missing.status, 404);
    assert.equal(missing.json().error.code, "unknown_job");
  });

  test("the catalog marks the long action and lists job.get", async () => {
    const res = await raw(served.port, { path: "/api/actions" });
    assert.deepEqual(
      res.json().actions.map((a: { name: string; long?: boolean }) => [a.name, a.long ?? false]),
      [
        ["look.roll", true],
        ["look.count", false],
        ["job.get", false],
      ],
    );
  });

  test("the change event comes when the job finishes, with its id, not when it starts", async () => {
    const events = await openEvents(`${served.url}/api/actions/stream`);
    try {
      gates.set("stream", gate());
      const res = await post("/api/actions/look.roll", { for: "stream" });
      const { id } = res.json().job as JobView;
      assert.equal(await events.next(200), null, "nothing while the job runs");
      gates.get("stream")?.open();
      const event = await events.next(2000);
      assert.equal(event?.event, "change");
      assert.deepEqual(JSON.parse(event?.data ?? "{}"), { action: "look.roll", door: "http", job: id });
      // a job that fails sends nothing
      await post("/api/actions/look.roll", { for: "f", fail: "action" });
      assert.equal(await events.next(400), null);
    } finally {
      events.close();
    }
  });

  test("MCP, through the SDK client: the tool answers at once and job_get reads the job", async () => {
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${served.url}/mcp`)));
    try {
      assert.match(client.getInstructions() ?? "", /^Rolls looks with look_roll\.\n\n.*job_get/s);
      const { tools } = await client.listTools();
      assert.deepEqual(
        tools.map((t) => t.name),
        ["look_roll", "look_count", "job_get"],
      );
      assert.match(tools[0]?.description ?? "", /^Roll six new looks\. Long: .*job_get/);
      assert.match(tools[2]?.description ?? "", /^Read a long action's job/);
      assert.deepEqual(tools[2]?.annotations, { readOnlyHint: true });

      gates.set("mcp", gate());
      const t0 = Date.now();
      const started = await client.callTool({ name: "look_roll", arguments: { for: "mcp" } });
      assert.ok(Date.now() - t0 < 1000, "the call came back without waiting for the roll");
      assert.equal(started.isError, undefined);
      const text = (started.content as { text: string }[])[0]?.text ?? "";
      const job = JSON.parse(text.split("\n\n")[0] ?? "{}").job as JobView;
      assert.equal(job.state, "running");
      assert.match(text, new RegExp(`job_get with \\{"id":"${job.id}"\\}`));
      gates.get("mcp")?.open();
      const read = await client.callTool({ name: "job_get", arguments: { id: job.id } });
      const view = JSON.parse((read.content as { text: string }[])[0]?.text ?? "{}") as JobView;
      assert.equal(view.state, "done");
      assert.equal(
        view.result,
        'rolled {"looks":6,"for":"mcp"}',
        "the MCP door's render applies to the result",
      );

      const failed = await client.callTool({ name: "look_roll", arguments: { for: "f", fail: "action" } });
      const failedId = JSON.parse(
        ((failed.content as { text: string }[])[0]?.text ?? "").split("\n\n")[0] ?? "",
      ).job.id;
      const failedRead = await client.callTool({ name: "job_get", arguments: { id: failedId } });
      const failedView = JSON.parse((failedRead.content as { text: string }[])[0]?.text ?? "{}") as JobView;
      assert.equal(failedRead.isError, undefined, "reading a failed job is a successful read");
      assert.deepEqual([failedView.state, failedView.error?.code], ["failed", "no_chart"]);
      const missing = await client.callTool({ name: "job_get", arguments: { id: "nope" } });
      assert.equal(missing.isError, true);
      assert.match((missing.content as { text: string }[])[0]?.text ?? "", /^unknown_job: /);
    } finally {
      await client.close();
    }
  });

  test("the served CLI waits and prints by default, and --no-wait prints the job", async () => {
    const file = join(dir, "uncharted.mjs");
    writeFileSync(file, (await raw(served.port, { path: "/cli/uncharted.mjs" })).text);
    const cli = (args: string[]) =>
      promisify(execFile)(process.execPath, [file, ...args], {
        env: { PATH: process.env.PATH ?? "", XDG_CONFIG_HOME: join(dir, "config") },
      }).then(
        (out) => ({ code: 0, stdout: out.stdout, stderr: out.stderr }),
        (err: { code: number; stdout: string; stderr: string }) => ({
          code: err.code,
          stdout: err.stdout,
          stderr: err.stderr,
        }),
      );
    const waited = await cli(["look.roll", "--for", "cli"]);
    assert.equal(waited.code, 0, waited.stderr);
    assert.deepEqual(JSON.parse(waited.stdout), { looks: 6, for: "cli" });
    assert.match(waited.stderr, /look\.roll runs as job [0-9a-f-]{36}; waiting/);

    const detached = await cli(["look_roll", "--for", "cli2", "--no-wait"]);
    assert.equal(detached.code, 0, detached.stderr);
    const job = JSON.parse(detached.stdout) as JobView;
    assert.deepEqual([job.action, job.state], ["look.roll", "running"]);
    const read = await cli(["job_get", "--id", job.id]);
    assert.equal(JSON.parse(read.stdout).state, "done");

    const failed = await cli(["look.roll", "--for", "f", "--fail", "action"]);
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /no_chart: there is no chart to roll against/);

    const list = await cli(["actions"]);
    assert.match(list.stdout, /look\.roll +Roll six new looks \(long\)/);
    const help = await cli(["help", "look.roll"]);
    assert.match(help.stdout, /long: .*--no-wait/s);
  });

  test("the browser client's act waits for the job; { wait: false } returns it", async () => {
    const client = createClient({ url: served.url, EventSource: FetchEventSource });
    const heard: unknown[] = [];
    const stop = client.onChange((change) => heard.push(change));
    try {
      assert.deepEqual(await client.act("look.roll", { for: "page" }), { looks: 6, for: "page" });
      await assert.rejects(
        client.act("look.roll", { for: "f", fail: "action" }),
        (err: unknown) =>
          err instanceof Error &&
          (err as { code?: string }).code === "no_chart" &&
          (err as { status?: number }).status === 422 &&
          Array.isArray((err as { issues?: unknown }).issues),
      );
      const job = (await client.act("look.roll", { for: "page2" }, { wait: false })) as unknown as JobView;
      assert.equal(job.state, "running");
      const view = await client.act("job.get", { id: job.id });
      assert.equal((view as JobView).state, "done");
      for (let i = 0; i < 100 && heard.length < 3; i++) await sleep(10);
      assert.deepEqual(
        heard.map((c) => (c as { action?: string }).action ?? "connected"),
        ["connected", "look.roll", "look.roll"],
      );
    } finally {
      stop();
    }
  });

  test("the skill says start it, then read it", async () => {
    const res = await raw(served.port, { path: "/skill/SKILL.md" });
    assert.match(res.text, /- `look_roll` \(CLI `uncharted look_roll`\): Roll six new looks \(long\)/);
    assert.match(res.text, /## Long actions\n\n.*job_get/);
  });
});

describe("long actions, after review", () => {
  test("a page that subscribes after a job started still hears it finish", async () => {
    const gates = new Map([["late", gate()]]);
    const reg = createRegistry(looksApp({ gates }).actions);
    const app = await serve(doors(reg, { name: "late" }));
    try {
      // no listener exists when the job starts
      const res = await raw(app.port, {
        method: "POST",
        path: "/api/actions/look.roll",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ for: "late" }),
      });
      const { id } = res.json().job as JobView;
      const events = await openEvents(`${app.url}/api/actions/stream`);
      try {
        await sleep(50);
        gates.get("late")?.open();
        const event = await events.next(2000);
        assert.equal(event?.event, "change");
        assert.equal(JSON.parse(event?.data ?? "{}").job, id);
      } finally {
        events.close();
      }
    } finally {
      await app.close();
    }
  });

  test("an inline async run announces its change to a listener added while it ran", async () => {
    let release = () => {};
    const reg = createRegistry([
      defineAction({
        name: "x.add",
        area: "x",
        summary: "add",
        mutates: true,
        input: z.object({}),
        run: () => new Promise<number>((resolve) => (release = () => resolve(1))),
      }),
    ]);
    const out = reg.run("x.add", {}, undefined) as Promise<number>;
    const heard: unknown[] = [];
    reg.onChange((change) => heard.push(change));
    release();
    await out;
    assert.deepEqual(heard, [{ action: "x.add", door: "direct" }]);
  });

  test("a job read awaits an async renderer", async () => {
    const reg = createRegistry(looksApp({ ms: 1 }).actions);
    const app = await serve(
      doors(reg, {
        name: "async-render",
        http: { render: async (_def, out) => `rendered ${JSON.stringify(out)}` },
      }),
    );
    try {
      const post = (path: string, body: unknown) =>
        raw(app.port, {
          method: "POST",
          path,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const { id } = (await post("/api/actions/look.roll", { for: "r" })).json().job as JobView;
      const read = await post("/api/actions/job.get", { id });
      assert.equal(read.json().result.state, "done");
      assert.equal(read.json().result.result, 'rendered {"looks":6,"for":"r"}');
    } finally {
      await app.close();
    }
  });
});
