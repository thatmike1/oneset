// the guard: always on, with or without a caller. Foreign Host and Origin refused, JSON bodies
// only, bodies capped; no Origin passes; hosts and origins widen it; a deployed app with no
// sign-in does not start
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { doors } from "../src/doors/index.ts";
import { notesRegistry } from "./fixtures/notes.ts";
import { raw, type Served, serve } from "./helpers.ts";

const setups = [
  { label: "without a caller", caller: undefined },
  { label: "with a caller", caller: true },
] as const;

for (const setup of setups) {
  describe(`the guard ${setup.label}`, () => {
    let app: Served;
    let callerCalls = 0;
    before(async () => {
      callerCalls = 0;
      app = await serve(
        doors(notesRegistry(), {
          name: "notes",
          maxBody: 2048,
          ...(setup.caller
            ? {
                caller: () => {
                  callerCalls++;
                  return { user: "mike" };
                },
              }
            : {}),
        }),
      );
    });
    after(() => app.close());

    const post = (headers: Record<string, string>, body = '{"text":"x"}') =>
      raw(app.port, {
        method: "POST",
        path: "/api/actions/note.add",
        headers: { "content-type": "application/json", ...headers },
        body,
      });

    test("a request with no Origin passes, as agents and CLIs send none", async () => {
      const res = await post({});
      assert.equal(res.status, 200);
    });

    test("the loopback names on the listening port pass", async () => {
      for (const host of [`localhost:${app.port}`, `127.0.0.1:${app.port}`, `[::1]:${app.port}`]) {
        const res = await raw(app.port, { path: "/api/actions", headers: { host } });
        assert.equal(res.status, 200, host);
      }
    });

    test("a same-origin page passes", async () => {
      const res = await post({ origin: `http://localhost:${app.port}` });
      assert.equal(res.status, 200);
    });

    test("a foreign Host is refused, reads included", async () => {
      const before = callerCalls;
      for (const host of [
        "evil.example",
        `localhost:${app.port + 1}`,
        `attacker.localhost.evil:${app.port}`,
      ]) {
        const read = await raw(app.port, { path: "/api/actions", headers: { host } });
        assert.equal(read.status, 403, host);
        assert.equal(read.json().error.code, "foreign_host");
        const write = await post({ host });
        assert.equal(write.status, 403);
      }
      assert.equal(callerCalls, before, "the caller is never resolved for a refused request");
    });

    test("a foreign Origin is refused, reads included", async () => {
      for (const origin of ["https://evil.example", `http://localhost:${app.port + 1}`, "null"]) {
        const write = await post({ origin });
        assert.equal(write.status, 403, origin);
        assert.equal(write.json().error.code, "foreign_origin");
        const read = await raw(app.port, { path: "/api/actions", headers: { origin } });
        assert.equal(read.status, 403);
      }
    });

    // only a serialized origin passes: scheme, host and port, nothing else. The host alone of
    // a URL with credentials or a path is a loopback name, which used to be enough
    test("an Origin that is a URL but not an origin is refused", async () => {
      const port = app.port;
      for (const origin of [
        `http://evil@localhost:${port}`,
        `http://user:pw@localhost:${port}`,
        `http://localhost:${port}/not-an-origin`,
        `http://localhost:${port}/`,
        `http://localhost:${port}?x`,
        `http://localhost:${port}#x`,
        `http://localhost:${port}\\x`,
        `http://localhost:${port}:`,
        `http://loc%61lhost:${port}`,
        `http://[0:0:0:0:0:0:0:1]:${port}`,
        `ftp://localhost:${port}`,
      ]) {
        const write = await post({ origin });
        assert.equal(write.status, 403, origin);
        assert.equal(write.json().error.code, "foreign_origin");
      }
      for (const origin of [`HTTP://LOCALHOST:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`]) {
        const res = await raw(app.port, { path: "/api/actions", headers: { origin } });
        assert.equal(res.status, 200, origin);
      }
    });

    test("a body that is not JSON is refused", async () => {
      for (const type of [
        "text/plain",
        "application/x-www-form-urlencoded",
        "multipart/form-data; boundary=x",
      ]) {
        const res = await post({ "content-type": type });
        assert.equal(res.status, 415, type);
        assert.equal(res.json().error.code, "json_only");
      }
      const none = await raw(app.port, {
        method: "POST",
        path: "/api/actions/note.add",
        body: '{"text":"x"}',
      });
      assert.equal(none.status, 415);
      const charset = await post({ "content-type": "application/json; charset=utf-8" });
      assert.equal(charset.status, 200);
    });

    test("a body that does not parse is a 400", async () => {
      const res = await post({}, "{nope");
      assert.equal(res.status, 400);
      assert.equal(res.json().error.code, "bad_json");
    });

    test("an oversized body is refused, with or without a content-length", async () => {
      const big = JSON.stringify({ text: "x".repeat(4000) });
      const declared = await post({}, big);
      assert.equal(declared.status, 413);
      assert.equal(declared.json().error.code, "too_large");
      const streamed = await raw(app.port, {
        method: "POST",
        path: "/api/actions/note.add",
        headers: { "content-type": "application/json" },
        body: big,
        chunked: true,
      });
      assert.equal(streamed.status, 413);
    });
  });
}

describe("hosts and origins options", () => {
  let app: Served;
  before(async () => {
    app = await serve(
      doors(notesRegistry(), {
        name: "notes",
        hosts: ["notes.example.com"],
        origins: ["https://chatgpt.com"],
        caller: () => ({ user: "mike" }),
      }),
    );
  });
  after(() => app.close());

  test("hosts widens the Host check and the same-origin check with it", async () => {
    const res = await raw(app.port, {
      path: "/api/actions",
      headers: { host: "notes.example.com", origin: "https://notes.example.com" },
    });
    assert.equal(res.status, 200);
    for (const origin of ["https://notes.example.com:443", "http://notes.example.com"]) {
      const same = await raw(app.port, {
        path: "/api/actions",
        headers: { host: "notes.example.com", origin },
      });
      assert.equal(same.status, 200, origin);
    }
    for (const origin of ["https://mike@notes.example.com", "https://notes.example.com/app"]) {
      const odd = await raw(app.port, {
        path: "/api/actions",
        headers: { host: "notes.example.com", origin },
      });
      assert.equal(odd.status, 403, origin);
    }
    const local = await raw(app.port, { path: "/api/actions" });
    assert.equal(local.status, 200, "loopback still passes");
    const other = await raw(app.port, { path: "/api/actions", headers: { host: "other.example.com" } });
    assert.equal(other.status, 403);
  });

  test("origins lets a connector that sends an Origin through", async () => {
    const res = await raw(app.port, { path: "/api/actions", headers: { origin: "https://chatgpt.com" } });
    assert.equal(res.status, 200);
    const other = await raw(app.port, { path: "/api/actions", headers: { origin: "https://claude.ai" } });
    assert.equal(other.status, 403);
  });
});

describe("a deployed app with no sign-in", () => {
  test("doors() throws for a non-loopback host with no caller", () => {
    assert.throws(() => doors(notesRegistry(), { name: "notes", hosts: ["notes.example.com"] }), /caller/);
  });

  test("loopback hosts, a caller, or the deliberate override let it start", () => {
    assert.doesNotThrow(() =>
      doors(notesRegistry(), { name: "notes", hosts: ["localhost:8080", "127.0.0.1"] }),
    );
    assert.doesNotThrow(() =>
      doors(notesRegistry(), { name: "notes", hosts: ["notes.example.com"], caller: () => ({}) }),
    );
    assert.doesNotThrow(() =>
      doors(notesRegistry(), { name: "notes", hosts: ["notes.example.com"], openWithoutSignIn: true }),
    );
  });
});
