// the hand-written MCP door: driven by the official SDK client, compared with the SDK's own
// server, and fed the raw malformed requests a well-behaved client never sends
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { doors, mcp } from "../src/doors/index.ts";
import { ActionError, createRegistry, defineAction } from "../src/index.ts";
import { notesRegistry } from "./fixtures/notes.ts";
import { raw, type Served, serve } from "./helpers.ts";

const INSTRUCTIONS = "Notes: add with note_add, read with note_list.";

async function connect(url: string, headers: Record<string, string> = {}) {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  return client;
}

const textOf = (result: unknown) => (result as { content: { text: string }[] }).content[0]?.text ?? "";

describe("the MCP door through the official SDK client", () => {
  let app: Served;
  let client: Client;
  before(async () => {
    app = await serve(
      doors(notesRegistry(), {
        name: "notes",
        instructions: INSTRUCTIONS,
        mcp: { list: (def) => def.name !== "note.fail" },
      }),
    );
    client = await connect(`${app.url}/mcp`);
  });
  after(async () => {
    await client.close();
    await app.close();
  });

  test("initialize negotiates the latest version and sends instructions", () => {
    assert.deepEqual(client.getServerVersion(), { name: "notes", version: "1.0.0" });
    assert.equal(client.getInstructions(), INSTRUCTIONS);
    // no listChanged: this stateless door never sends a list-changed notification
    assert.deepEqual(client.getServerCapabilities(), { tools: {} });
  });

  test("lists the tools it lists, with draft-7 schemas and annotations", async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name),
      ["note_add", "note_list", "note_add_later", "note_count", "note_fail_later"],
    );
    const add = tools[0]!;
    assert.equal(add.description, "Add a note");
    assert.deepEqual(add.annotations, { readOnlyHint: false });
    assert.equal(add.inputSchema.$schema, "http://json-schema.org/draft-07/schema#");
    assert.deepEqual(add.inputSchema.required, ["text"]);
  });

  test("calls a tool, sync and async", async () => {
    const added = await client.callTool({ name: "note_add", arguments: { text: "milk" } });
    assert.equal(added.isError, undefined);
    assert.deepEqual(JSON.parse(textOf(added)), { id: 1, text: "milk" });
    const later = await client.callTool({ name: "note_add_later", arguments: { text: "eggs" } });
    assert.deepEqual(JSON.parse(textOf(later)), { id: 2, text: "eggs" });
    const count = await client.callTool({ name: "note_count", arguments: {} });
    assert.equal(textOf(count), "2");
  });

  test("an unknown tool is a tool error", async () => {
    const out = await client.callTool({ name: "note_nope", arguments: {} });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "unknown_action: no action named note_nope");
  });

  test("invalid arguments are a tool error", async () => {
    const out = await client.callTool({ name: "note_add", arguments: { text: 3 } });
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^invalid_input: .*text/s);
  });

  test("a direct call to an unlisted tool is refused", async () => {
    const out = await client.callTool({ name: "note_fail", arguments: {} });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "not_listed: note.fail is not available through mcp");
  });

  test("a failing handler is a tool error that says nothing of the inside", async () => {
    const original = console.error;
    console.error = () => {};
    try {
      const out = await client.callTool({ name: "note_fail_later", arguments: {} });
      assert.equal(out.isError, true);
      assert.equal(textOf(out), "internal: something broke on the server");
    } finally {
      console.error = original;
    }
  });

  test("ping answers", async () => {
    assert.deepEqual(await client.ping(), {});
  });
});

describe("the same answers as the SDK's own server", () => {
  const defs = () => [
    defineAction({
      name: "library.search",
      area: "library",
      summary: "Search the library",
      mutates: false,
      input: z.object({
        words: z.string().describe("what to look for"),
        limit: z.number().int().min(1).max(50).default(10),
        tags: z.array(z.string()).optional(),
        sort: z.enum(["new", "old"]).optional(),
      }),
      run: (input) => ({ found: [input.words] }),
    }),
    defineAction({
      name: "set.play",
      area: "sets",
      summary: "Play a set",
      mutates: true,
      input: z.object({ ids: z.array(z.string()), start: z.boolean().default(true) }),
      run: (input) => ({ playing: input.ids.length }),
    }),
  ];
  const describeTool = (def: { name: string; summary: string; mutates: boolean }) => ({
    summary: def.summary,
    title: def.name,
    annotations: { readOnlyHint: !def.mutates, destructiveHint: false, openWorldHint: false },
  });
  let ours: Served;
  let theirs: Served;
  before(async () => {
    ours = await serve(
      doors(createRegistry(defs()), {
        name: "dz",
        instructions: INSTRUCTIONS,
        mcp: { describe: describeTool },
      }),
    );
    // the SDK's server, registered the way Tandem and diskzokej do it today
    const sdkServer = createServer(async (req, res) => {
      const server = new McpServer({ name: "dz", version: "1.0.0" }, { instructions: INSTRUCTIONS });
      for (const def of defs()) {
        const shown = describeTool(def);
        server.registerTool(
          def.name.replaceAll(".", "_"),
          {
            title: shown.title,
            description: shown.summary,
            inputSchema: def.input,
            annotations: shown.annotations,
          },
          async (args: unknown) => ({
            content: [
              {
                type: "text" as const,
                text: JSON.stringify((def.run as (input: unknown) => unknown)(args), null, 2),
              },
            ],
          }),
        );
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    });
    await new Promise<void>((resolve) => sdkServer.listen(0, "127.0.0.1", resolve));
    const port = (sdkServer.address() as AddressInfo).port;
    theirs = {
      url: `http://127.0.0.1:${port}`,
      port,
      server: sdkServer,
      close: () =>
        new Promise<void>((resolve) => {
          sdkServer.closeAllConnections();
          sdkServer.close(() => resolve());
        }),
    };
  });
  after(async () => {
    await ours.close();
    await theirs.close();
  });

  const rpc = (app: Served, body: unknown) =>
    raw(app.port, {
      method: "POST",
      path: "/mcp",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(body),
    });
  const both = async (body: unknown) => {
    const [a, b] = await Promise.all([rpc(ours, body), rpc(theirs, body)]);
    assert.equal(a.status, b.status);
    return [a.json(), b.json()];
  };

  test("initialize, for the latest, an older and an unknown version", async () => {
    for (const protocolVersion of ["2025-11-25", "2025-03-26", "1999-01-01"]) {
      const [a, b] = await both({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion, capabilities: {}, clientInfo: { name: "t", version: "1" } },
      });
      // the one deliberate difference: the SDK advertises listChanged, which this door never sends
      assert.deepEqual(a.result.capabilities, { tools: {} });
      assert.deepEqual(b.result.capabilities, { tools: { listChanged: true } });
      a.result.capabilities = b.result.capabilities;
      assert.deepEqual(a, b, protocolVersion);
    }
  });

  test("tools/list", async () => {
    const [a, b] = await both({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.deepEqual(a, b);
  });

  test("tools/call", async () => {
    const [a, b] = await both({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "library_search", arguments: { words: "dnb" } },
    });
    assert.deepEqual(a, b);
  });

  test("ping", async () => {
    const [a, b] = await both({ jsonrpc: "2.0", id: "p", method: "ping" });
    assert.deepEqual(a, b);
  });
});

describe("raw malformed requests", () => {
  let app: Served;
  before(async () => {
    app = await serve(doors(notesRegistry(), { name: "notes" }));
  });
  after(() => app.close());

  const ACCEPT = "application/json, text/event-stream";
  const post = (body: string, headers: Record<string, string> = {}) =>
    raw(app.port, {
      method: "POST",
      path: "/mcp",
      headers: { "content-type": "application/json", accept: ACCEPT, ...headers },
      body,
    });

  test("GET and DELETE are 405", async () => {
    for (const method of ["GET", "DELETE"]) {
      const res = await raw(app.port, { method, path: "/mcp", headers: { accept: "text/event-stream" } });
      assert.equal(res.status, 405, method);
      assert.equal(res.headers.allow, "POST");
      assert.equal(res.json().error.code, -32000);
    }
  });

  test("a notification is answered 202 with no body", async () => {
    const res = await post(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    assert.equal(res.status, 202);
    assert.equal(res.text, "");
    const cancelled = await post(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } }),
    );
    assert.equal(cancelled.status, 202);
  });

  test("a response from the client is answered 202", async () => {
    const res = await post(JSON.stringify({ jsonrpc: "2.0", id: 9, result: {} }));
    assert.equal(res.status, 202);
  });

  test("a wrong Accept is refused", async () => {
    for (const accept of ["application/json", "text/event-stream", "*/*"]) {
      const res = await post(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }), { accept });
      assert.equal(res.status, 406, accept);
    }
    const none = await raw(app.port, {
      method: "POST",
      path: "/mcp",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(none.status, 406);
  });

  test("Accept is read as media ranges, not searched for substrings", async () => {
    const ping = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    for (const accept of [
      "application/json;q=0, text/event-stream;q=0",
      "application/json, text/event-stream;q=0",
      "application/json;q=0.000, text/event-stream",
      "application/json-seq, text/event-stream",
      "application/jsonx, text/event-stream",
      "text/event-stream-ish, application/json",
      "application/json;q=nope, text/event-stream",
    ]) {
      const res = await post(ping, { accept });
      assert.equal(res.status, 406, accept);
    }
    for (const accept of [
      "Application/JSON; charset=utf-8, Text/Event-Stream;q=0.5",
      "text/event-stream , application/json;q=1",
      "text/html, application/json;q=0.9, text/event-stream;q=0.001",
    ]) {
      const res = await post(ping, { accept });
      assert.equal(res.status, 200, accept);
    }
  });

  test("a wrong Content-Type is refused", async () => {
    const res = await post(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }), {
      "content-type": "text/plain",
    });
    assert.equal(res.status, 415);
    assert.deepEqual(res.json(), {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Unsupported Media Type: Content-Type must be application/json" },
      id: null,
    });
  });

  test("a body that is not JSON is a parse error", async () => {
    const res = await post("{nope");
    assert.equal(res.status, 400);
    assert.equal(res.json().error.code, -32700);
    assert.equal(res.json().id, null);
  });

  test("JSON that is not a JSON-RPC message is an invalid request", async () => {
    for (const body of [
      {},
      { jsonrpc: "1.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", id: 1, method: 5 },
      { jsonrpc: "2.0", id: { x: 1 }, method: "ping" },
      { jsonrpc: "2.0", id: 1, method: "ping", params: "x" },
      [],
      "ping",
    ]) {
      const res = await post(JSON.stringify(body));
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.json().error.code, -32600);
    }
  });

  test("an unsupported protocol version header is a 400", async () => {
    const res = await post(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }), {
      "mcp-protocol-version": "1999-01-01",
    });
    assert.equal(res.status, 400);
    const ok = await post(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }), {
      "mcp-protocol-version": "2025-06-18",
    });
    assert.deepEqual(ok.json(), { jsonrpc: "2.0", id: 1, result: {} });
  });

  test("an unknown method is a JSON-RPC error, kept apart from tool errors", async () => {
    const res = await post(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "resources/list" }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.json(), {
      jsonrpc: "2.0",
      id: 4,
      error: { code: -32601, message: "Method not found: resources/list" },
    });
  });

  test("initialize with missing or mistyped params is an invalid-params error", async () => {
    const good = { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } };
    for (const params of [
      undefined,
      [],
      {},
      { ...good, protocolVersion: undefined },
      { ...good, protocolVersion: 20251125 },
      { ...good, capabilities: undefined },
      { ...good, capabilities: [] },
      { ...good, capabilities: null },
      { ...good, clientInfo: undefined },
      { ...good, clientInfo: "t" },
      { ...good, clientInfo: { name: "t" } },
      { ...good, clientInfo: { name: 1, version: "1" } },
    ]) {
      const msg: Record<string, unknown> = { jsonrpc: "2.0", id: 2, method: "initialize" };
      if (params !== undefined) msg.params = params;
      const res = await post(JSON.stringify(msg));
      assert.equal(res.status, 200, JSON.stringify(params));
      assert.equal(res.json().error?.code, -32602, JSON.stringify(params));
      assert.equal(res.json().id, 2);
    }
    // a well-formed initialize for a version this door does not know still negotiates
    const unknown = await post(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "initialize",
        params: { ...good, protocolVersion: "1999-01-01" },
      }),
    );
    assert.equal(unknown.json().result.protocolVersion, "2025-11-25");
  });

  test("params that are not an object, or tool arguments that are not one, are invalid params", async () => {
    for (const msg of [
      { jsonrpc: "2.0", id: 6, method: "ping", params: [] },
      { jsonrpc: "2.0", id: 6, method: "tools/list", params: [] },
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: ["note_count"] },
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "note_count", arguments: [] } },
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "note_count", arguments: "x" } },
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "note_count", arguments: null } },
    ]) {
      const res = await post(JSON.stringify(msg));
      assert.equal(res.json().error?.code, -32602, JSON.stringify(msg));
    }
  });

  test("only advertised tool names run: an action's dotted name is an unknown tool", async () => {
    const reg = notesRegistry();
    const handle = mcp(reg, { name: "notes" });
    const alone = createServer((req, res) => void handle(req, res, undefined));
    await new Promise<void>((resolve) => alone.listen(0, "127.0.0.1", resolve));
    const port = (alone.address() as AddressInfo).port;
    const callTool = async (name: string) =>
      (
        await raw(port, {
          method: "POST",
          path: "/mcp",
          headers: { "content-type": "application/json", accept: ACCEPT },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name, arguments: { text: "x" } },
          }),
        })
      ).json().result;
    try {
      const dotted = await callTool("note.add");
      assert.equal(dotted.isError, true);
      assert.equal(dotted.content[0].text, "unknown_action: no action named note.add");
      assert.deepEqual(reg.run("note.list", {}, undefined), [], "nothing ran");
      const advertised = await callTool("note_add");
      assert.equal(advertised.isError, undefined);
      assert.equal((reg.run("note.list", {}, undefined) as unknown[]).length, 1);
    } finally {
      alone.closeAllConnections();
      await new Promise<void>((resolve) => alone.close(() => resolve()));
    }
  });

  test("tools/call with no tool name is a protocol error, not a tool error", async () => {
    const res = await post(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: {} }));
    assert.equal(res.json().error.code, -32602);
  });

  // batches left the transport in 2025-06-18: one message per POST. The SDK still runs them;
  // this door refuses them before anything runs, on every version
  test("a batch is refused and nothing in it runs", async () => {
    const reg = notesRegistry();
    const handle = mcp(reg, { name: "notes" });
    const alone = createServer((req, res) => {
      const body = req.headers["x-body"] ? JSON.parse(String(req.headers["x-body"])) : undefined;
      void handle(req, res, undefined, body);
    });
    await new Promise<void>((resolve) => alone.listen(0, "127.0.0.1", resolve));
    const port = (alone.address() as AddressInfo).port;
    const batch = [
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "note_add", arguments: { text: "x" } } },
    ];
    try {
      for (const version of ["2025-11-25", "2025-06-18", "2025-03-26", undefined]) {
        const headers: Record<string, string> = { "content-type": "application/json", accept: ACCEPT };
        if (version) headers["mcp-protocol-version"] = version;
        const read = await raw(port, { method: "POST", path: "/mcp", headers, body: JSON.stringify(batch) });
        // a body the app already read goes through the same check
        const given = await raw(port, {
          method: "POST",
          path: "/mcp",
          headers: { ...headers, "x-body": JSON.stringify(batch) },
        });
        for (const res of [read, given]) {
          assert.equal(res.status, 400, String(version));
          assert.equal(res.json().error.code, -32600);
          assert.equal(res.json().id, null);
        }
      }
      assert.deepEqual(reg.run("note.list", {}, undefined), [], "nothing ran");
    } finally {
      alone.closeAllConnections();
      await new Promise<void>((resolve) => alone.close(() => resolve()));
    }
  });

  test("an oversized body is refused", async () => {
    const small = await serve(doors(notesRegistry(), { name: "notes", maxBody: 100 }));
    try {
      const res = await raw(small.port, {
        method: "POST",
        path: "/mcp",
        headers: { "content-type": "application/json", accept: ACCEPT },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(200) } }),
      });
      assert.equal(res.status, 413);
    } finally {
      await small.close();
    }
  });

  test("the guard still applies in front of it, answering in MCP's error shape", async () => {
    for (const headers of [{ origin: "https://evil.example" }, { host: "evil.example" }] as Record<
      string,
      string
    >[]) {
      const res = await post(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }), headers);
      assert.equal(res.status, 403);
      assert.equal(res.json().error.code, -32000);
      assert.equal(res.json().id, null);
    }
  });
});

describe("the MCP door mounted alone, with a caller the app resolved", () => {
  interface Who {
    owner: boolean;
  }
  const reg = createRegistry(
    [
      defineAction({
        name: "dj.ask",
        area: "dj",
        summary: "Ask the in-app dj (spends credit)",
        mutates: false,
        mcp: false,
        input: z.object({ message: z.string() }),
        run: () => "a set",
      }),
      defineAction({
        name: "library.overview",
        area: "library",
        summary: "The map of the library",
        mutates: false,
        input: z.object({}),
        run: () => "3500 tracks",
      }),
    ],
    {
      allow(_def, who: Who) {
        if (!who.owner) throw new ActionError(403, "forbidden", "owner only");
      },
    },
  );
  const handle = mcp(reg, {
    name: "diskzokej",
    list: (def) => (def as { mcp?: boolean }).mcp !== false,
    render: (_def, out) => out,
  });
  let app: Served;
  before(async () => {
    const server = createServer((req, res) => {
      if (req.url !== "/mcp") return void res.writeHead(404).end();
      if (req.headers.authorization !== "Bearer key") {
        res.writeHead(401, { "www-authenticate": 'Bearer realm="agents"' });
        return void res.end();
      }
      void handle(req, res, { owner: true });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    app = {
      url: `http://127.0.0.1:${port}`,
      port,
      server,
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    };
  });
  after(() => app.close());

  test("the SDK client lists and calls through it, and the hidden tool is uncallable", async () => {
    const client = await connect(`${app.url}/mcp`, { authorization: "Bearer key" });
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(
        tools.map((t) => t.name),
        ["library_overview"],
      );
      assert.equal(textOf(await client.callTool({ name: "library_overview", arguments: {} })), "3500 tracks");
      const hidden = await client.callTool({ name: "dj_ask", arguments: { message: "hi" } });
      assert.equal(hidden.isError, true);
      assert.match(textOf(hidden), /^not_listed: /);
    } finally {
      await client.close();
    }
  });

  test("a body the app already read is used as is", async () => {
    const res = await new Promise<{ status: number; body: string }>((resolve) => {
      const server = createServer((req, r) => {
        void handle(req, r, { owner: true }, { jsonrpc: "2.0", id: 7, method: "ping" });
      });
      server.listen(0, "127.0.0.1", async () => {
        const port = (server.address() as AddressInfo).port;
        const out = await raw(port, {
          method: "POST",
          path: "/mcp",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        });
        server.close();
        resolve({ status: out.status, body: out.text });
      });
    });
    assert.deepEqual(JSON.parse(res.body), { jsonrpc: "2.0", id: 7, result: {} });
  });
});

describe("the MCP door mounted alone keeps the guard", () => {
  const ACCEPT = "application/json, text/event-stream";
  const call = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "note_add", arguments: { text: "x" } },
  });
  /** a server that mounts mcp() alone and hands it the caller, the way Tandem and diskzokej do */
  async function alone(options: { hosts?: string[]; origins?: string[] }, caller: unknown) {
    const reg = notesRegistry();
    const handle = mcp(reg, { name: "notes", ...options });
    const server = createServer((req, res) => void handle(req, res, caller));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    return {
      port,
      count: () => (reg.run("note.list", {}, caller) as unknown[]).length,
      post: (headers: Record<string, string> = {}) =>
        raw(port, {
          method: "POST",
          path: "/mcp",
          headers: { "content-type": "application/json", accept: ACCEPT, ...headers },
          body: call,
        }),
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    };
  }

  for (const [label, caller] of [
    ["without a caller", undefined],
    ["with a caller", { user: "mike" }],
  ] as const) {
    test(`a foreign Host or Origin is refused before anything runs, ${label}`, async () => {
      const app = await alone({}, caller);
      try {
        for (const headers of [
          { host: "evil.example" } as Record<string, string>,
          { host: `localhost:${app.port + 1}` },
          { origin: "https://evil.example" },
          { origin: `http://localhost:${app.port + 1}` },
          { origin: "null" },
          { host: "evil.example", origin: "https://evil.example" },
        ]) {
          const res = await app.post(headers);
          assert.equal(res.status, 403, JSON.stringify(headers));
          assert.equal(res.json().jsonrpc, "2.0");
          assert.equal(res.json().error.code, -32000);
          assert.equal(res.json().id, null);
        }
        assert.equal(app.count(), 0, "nothing ran");
        // no Origin, a same-origin page and the loopback names still pass
        assert.equal((await app.post()).status, 200);
        assert.equal((await app.post({ origin: `http://localhost:${app.port}` })).status, 200);
        assert.equal((await app.post({ host: `[::1]:${app.port}` })).status, 200);
        assert.equal(app.count(), 3);
      } finally {
        await app.close();
      }
    });
  }

  test("hosts and origins widen it, as they do for doors()", async () => {
    const app = await alone(
      { hosts: ["notes.example.com"], origins: ["https://chatgpt.com"] },
      { user: "mike" },
    );
    try {
      assert.equal(
        (await app.post({ host: "notes.example.com", origin: "https://notes.example.com" })).status,
        200,
      );
      assert.equal((await app.post({ origin: "https://chatgpt.com" })).status, 200);
      assert.equal((await app.post({ host: "other.example.com" })).status, 403);
      assert.equal((await app.post({ origin: "https://claude.ai" })).status, 403);
    } finally {
      await app.close();
    }
  });
});
