// the notes example, run as its own process from the built package, answering in one test run
// over HTTP, the official SDK's MCP client, the served CLI and the browser client
import assert from "node:assert/strict";
import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { FetchEventSource } from "./helpers.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "oneset-example-"));
let child: ChildProcess;
let url = "";

before(async () => {
  // the example imports "oneset", which resolves to the built package
  execFileSync("pnpm", ["run", "-s", "build"], { cwd: root, stdio: "ignore" });
  child = spawn(process.execPath, [join(root, "examples/notes/server.mjs")], {
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  url = await new Promise<string>((resolve, reject) => {
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const match = /notes on (http:\/\/localhost:\d+)\//.exec(out);
      if (match?.[1]) resolve(match[1]);
    });
    child.on("exit", (code) => reject(new Error(`the example exited with ${code}`)));
  });
});

after(() => {
  child?.kill();
  rmSync(dir, { recursive: true, force: true });
});

test("the notes example answers over HTTP, MCP, the CLI and the browser client", {
  timeout: 60_000,
}, async () => {
  // the browser client, loaded from the app, listening before anyone changes anything
  writeFileSync(join(dir, "actions.mjs"), await (await fetch(`${url}/actions.js`)).text());
  (globalThis as { EventSource?: unknown }).EventSource = FetchEventSource;
  const page = (await import(join(dir, "actions.mjs"))) as {
    act(name: string, input?: unknown): Promise<any>;
    onChange(fn: (change: unknown) => void): () => void;
  };
  const heard: { action?: string; door?: string }[] = [];
  const stop = page.onChange((change) => heard.push(change as never));
  await new Promise((resolve) => setTimeout(resolve, 100));

  try {
    // HTTP
    const catalog = (await (await fetch(`${url}/api/actions`)).json()) as { actions: { name: string }[] };
    assert.deepEqual(
      catalog.actions.map((a: { name: string }) => a.name),
      ["note.add", "note.list"],
    );
    const added = await fetch(`${url}/api/actions/note.add`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "over http" }),
    });
    assert.deepEqual(await added.json(), { result: { id: 1, text: "over http" } });

    // MCP, through the official SDK client
    const client = new Client({ name: "example-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
    try {
      assert.equal(
        client.getInstructions(),
        "The person's notes. note_list reads them all; note_add adds one.",
      );
      const { tools } = await client.listTools();
      assert.deepEqual(
        tools.map((t) => t.name),
        ["note_add", "note_list"],
      );
      const out = await client.callTool({ name: "note_add", arguments: { text: "over mcp" } });
      assert.deepEqual(JSON.parse((out.content as { text: string }[])[0]!.text), { id: 2, text: "over mcp" });
    } finally {
      await client.close();
    }

    // the CLI, downloaded from the app and run as a child process with no login
    const cliFile = join(dir, "notes");
    writeFileSync(cliFile, await (await fetch(`${url}/cli/notes.mjs`)).text());
    const run = promisify(execFile);
    const env = { PATH: process.env.PATH ?? "", XDG_CONFIG_HOME: join(dir, "config") };
    const cliOut = await run(process.execPath, [cliFile, "note.add", "--text", "over the cli"], { env });
    assert.deepEqual(JSON.parse(cliOut.stdout), { id: 3, text: "over the cli" });

    // the browser client heard every change, and acts itself
    for (let i = 0; i < 100 && heard.length < 4; i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(heard, [
      { connected: true },
      { action: "note.add", door: "http" },
      { action: "note.add", door: "mcp" },
      { action: "note.add", door: "http" },
    ]);
    assert.deepEqual(await page.act("note.add", { text: "from the page" }), { id: 4, text: "from the page" });
    assert.deepEqual(
      (await page.act("note.list")).map((n: { text: string }) => n.text),
      ["over http", "over mcp", "over the cli", "from the page"],
    );

    // and the page itself loads the client from the app
    const html = await (await fetch(`${url}/`)).text();
    assert.match(html, /import \{ act, onChange \} from "\/actions\.js"/);
  } finally {
    stop();
  }
});
