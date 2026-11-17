// a door the app writes itself with reg.door, shaped like diskzokej's dj loop: its own list
// rule, draft-7 schemas, its own render, unlisted calls refused, and allow's own error first
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { z } from "zod";
import { ActionError, kit } from "../src/index.ts";

interface Who {
  owner: boolean;
  via: "browser" | "key" | "dj";
}

const { defineAction, createRegistry } = kit<
  Who,
  Who,
  { access: "owner" | "browser"; dj?: boolean; mcp?: false }
>();

const doorsSeen: string[] = [];

const actions = [
  defineAction({
    name: "library.search",
    area: "library",
    summary: "Search the library",
    access: "owner",
    dj: true,
    mutates: false,
    input: z.object({ words: z.string(), limit: z.number().int().default(10) }),
    text: (result: string[]) => result.join("\n"),
    run: (input) => [`${input.words} 1`, `${input.words} 2`],
  }),
  defineAction({
    name: "set.play",
    area: "sets",
    summary: "Play a set",
    access: "owner",
    mutates: true,
    input: z.object({ ids: z.array(z.string()) }),
    run: (input) => ({ playing: input.ids.length }),
  }),
  defineAction({
    name: "keys.create",
    area: "keys",
    summary: "Make an agent key",
    access: "browser",
    dj: true,
    mutates: true,
    input: z.object({ label: z.string() }),
    run: (input) => ({ key: input.label }),
  }),
] as const;

const reg = createRegistry(actions, {
  allow(def, who) {
    if (!who.owner) throw new ActionError(401, "signed_out", "sign in required");
    if (def.access === "browser" && who.via !== "browser") {
      throw new ActionError(403, "forbidden", `${def.name} is only for the owner in his own browser`);
    }
  },
  around(_def, input, who, next, info) {
    doorsSeen.push(info.door);
    return next(input, who);
  },
});

const dj = reg.door({
  name: "dj",
  list: (def) => def.dj === true,
  draft: "draft-7",
  render: (def, result) =>
    "text" in def && typeof def.text === "function" ? def.text(result as never) : JSON.stringify(result),
});

const djCaller: Who = { owner: true, via: "dj" };

describe("an app-written door", () => {
  test("lists only what its own rule and allow let through", () => {
    // keys.create carries dj: true but allow refuses it outside the browser, so the default
    // part of listing (allow must pass) still applies under the app's rule
    assert.deepEqual(
      dj.catalog(djCaller).map((e) => e.name),
      ["library.search"],
    );
    assert.deepEqual(
      dj.catalog({ owner: true, via: "browser" }).map((e) => e.name),
      ["library.search", "keys.create"],
    );
  });

  test("the catalog speaks the wire format with draft-7 schemas", () => {
    const [entry] = dj.catalog(djCaller);
    assert.deepEqual(Object.keys(entry ?? {}), ["name", "tool", "area", "summary", "mutates", "inputSchema"]);
    assert.equal(entry?.tool, "library_search");
    assert.equal(entry?.inputSchema.$schema, "http://json-schema.org/draft-07/schema#");
    assert.deepEqual(entry?.inputSchema.required, ["words"]);
  });

  test("a door's default draft is 2020-12", () => {
    const http = reg.door({ name: "http" });
    assert.equal(
      http.catalog(djCaller)[0]?.inputSchema.$schema,
      "https://json-schema.org/draft/2020-12/schema",
    );
  });

  test("runs a listed action, renders it and tells around which door it came through", () => {
    doorsSeen.length = 0;
    assert.equal(dj.run("library.search", { words: "dnb" }, djCaller), "dnb 1\ndnb 2");
    assert.deepEqual(doorsSeen, ["dj"]);
  });

  test("refuses an action it does not list, even though reg.run would run it", () => {
    assert.deepEqual(reg.run("set.play", { ids: ["a"] }, djCaller), { playing: 1 });
    assert.throws(
      () => dj.run("set.play", { ids: ["a"] }, djCaller),
      (err: unknown) => err instanceof ActionError && err.code === "not_listed" && err.status === 403,
    );
  });

  test("allow's own error wins over the not-listed refusal", () => {
    assert.throws(
      () => dj.run("keys.create", { label: "x" }, djCaller),
      (err: unknown) => err instanceof ActionError && err.code === "forbidden",
    );
    assert.throws(
      () => dj.run("set.play", { ids: [] }, { owner: false, via: "dj" }),
      (err: unknown) => err instanceof ActionError && err.code === "signed_out",
    );
  });

  test("an unknown name is the kit's unknown_action, not a refusal", () => {
    assert.throws(
      () => dj.run("nope.nope", {}, djCaller),
      (err: unknown) => err instanceof ActionError && err.code === "unknown_action",
    );
  });

  test("describe sets the summary a door shows; default annotations follow mutates", () => {
    const shown = reg.door({
      name: "shown",
      describe: (def) => ({ summary: `${def.summary}!`, title: def.name }),
    });
    assert.equal(shown.catalog(djCaller)[0]?.summary, "Search the library!");
    assert.deepEqual(shown.describe(reg.get("library.search")!, djCaller), {
      summary: "Search the library!",
      title: "library.search",
    });
    const plain = reg.door({ name: "plain" });
    assert.deepEqual(plain.describe(reg.get("set.play")!, djCaller), {
      summary: "Play a set",
      annotations: { readOnlyHint: false },
    });
  });
});
