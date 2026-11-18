# oneset

Agent access by default for a Node app. You write the app's actions once, and both the person (through the page) and their agent (through MCP or a CLI) use them. It mounts on the `node:http` server the app already has, and its only runtime requirement is `zod`, as a peer dependency.

Private for now: not published to npm. Apps install it from a packed tarball (`pnpm pack`).

## The notes example

A whole app: two actions, one mount, a small page. It lives in the repo as `examples/notes/server.mjs` (not in the package, so here it is in full; a test keeps the two the same).

```js
// a notes app: its actions written once, used by a person through the page and by their agent
// through MCP or the CLI. Run it with `node examples/notes/server.mjs`, then open /setup
import { createServer } from "node:http";
import { createRegistry, defineAction } from "oneset";
import { doors } from "oneset/doors";
import { z } from "zod";

const notes = [];

const reg = createRegistry([
  defineAction({
    name: "note.add",
    area: "notes",
    summary: "Add a note",
    mutates: true,
    input: z.object({ text: z.string().min(1).describe("what to remember") }),
    run: ({ text }) => {
      const note = { id: notes.length + 1, text };
      notes.push(note);
      return note;
    },
  }),
  defineAction({
    name: "note.list",
    area: "notes",
    summary: "Every note, oldest first",
    mutates: false,
    input: z.object({}),
    run: () => notes,
  }),
]);

const handle = doors(reg, {
  name: "notes",
  instructions: "The person's notes. note_list reads them all; note_add adds one.",
  when: "Use when the person asks to note something down, or what their notes say.",
});

const page = `<!doctype html><meta charset="utf-8"><title>Notes</title>
<form><input name="text" required> <button>Add</button></form><ul id="list"></ul>
<script type="module">
  import { act, onChange } from "/actions.js";
  const list = document.getElementById("list");
  const show = async () => list.replaceChildren(...(await act("note.list")).map((n) => Object.assign(document.createElement("li"), { textContent: n.text })));
  document.querySelector("form").onsubmit = async (e) => { e.preventDefault(); await act("note.add", { text: e.target.text.value }); e.target.reset(); };
  onChange(show);
  show();
</script>`;

const server = createServer(async (req, res) => {
  if (await handle(req, res)) return;
  if (req.url === "/")
    return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
  res.writeHead(404).end();
});
server.listen(Number(process.env.PORT ?? 3000), "127.0.0.1", () => {
  console.log(`notes on http://localhost:${server.address().port}/ (agent setup at /setup)`);
});
```

From a checkout of this repo, run it with `pnpm build && node examples/notes/server.mjs`, then open `http://localhost:3000/setup` for the lines to paste. That one mount serves:

| Path | What |
| --- | --- |
| `GET /api/actions` | the catalog: `{ app, actions: [{ name, tool, area, summary, mutates, inputSchema }] }` |
| `POST /api/actions/<name>` | a run: `{ result }`, or `{ error: { code, message, issues? } }` with the error's status |
| `POST /mcp` | the MCP door (stateless streamable HTTP, hand-written; the SDK is a dev dependency only) |
| `GET /cli/<name>.mjs` | a zero-dependency CLI with the app's name and address filled in |
| `GET /skill/SKILL.md` | a Claude Code skill listing the MCP tools |
| `GET /actions.js` | the browser client: `act(name, input)`, `onChange(fn)`; also in the package as `oneset/client` |
| `GET /api/actions/stream` | server-sent `change` events after every successful outermost mutating run |
| `GET /setup` | the MCP, CLI and skill lines to paste once |

A `base` option moves them all under a prefix.

## The pieces

- `kit<Caller, RunCtx, Fields?, ExtraInput?>()` returns a typed `defineAction` and `createRegistry`. The untyped ones are exported directly.
- `createRegistry(definitions, hooks)` takes one list (a repeated name throws) and the hooks `schema(def)`, `allow(def, caller)`, `around(def, input, caller, next, info)` and `error(problem)`.
- `reg.run(name, input, caller, info?)` runs allow, then validation against `schema(def)`, then `around`. The core never awaits: a sync chain returns a value, an async one a promise.
- `reg.door({ name, list, describe, render, draft })` makes a door an app can use itself: `catalog(caller)` and `run(name, input, caller)`, which refuses what it does not list.
- `ActionError(status, code, message, { issues, body, headers })` is the one error to throw. Doors render any thrown error by its `status`, `code`, `message` and `issues`.
- `doors(reg, options)` takes the app's `name` and `version` (what MCP clients see; the version defaults to 1.0.0, so pass the app's own), `instructions` and `when`, and mounts everything behind the guard (foreign Host and Origin refused, JSON bodies only, bodies capped). `hosts` and `origins` widen it; a non-loopback host with no `caller` refuses to start unless `openWithoutSignIn: true`.
- `oneset/client` is the browser client from the package. Its `createClient({ url, fetch, EventSource })` makes a client a module can be handed, so code that node tests import can use it with a test server and an EventSource stand-in; the page itself still loads `/actions.js`. `onChange` listeners hear `{ action, door }` for a run, `{ connected: true }` once the stream is live and `{ reconnected: true }` after a drop; a listener that keeps fetched state refetches on all three.
- `mcp(reg, options)` from `oneset/doors` is the MCP door alone, `(req, res, caller, body?)`, for apps that keep their own routes and resolve their caller themselves. It keeps the same Host and Origin guard and takes the same `hosts`, `origins` and `maxBody`, so an app behind a proxy passes its public host in `hosts`. `handle.resolving(req, res, resolve, body?)` takes a function instead of a caller and calls it only once the request has passed the door's own checks, which is how `doors()` mounts it.

## Tests

```sh
export PATH="$HOME/.local/bin:$PATH"
pnpm install
pnpm test        # node:test, straight from the TypeScript source
pnpm gate        # Biome check, typecheck, build, tests, pack check
```

The suite covers the core against two fixtures (a notes app, and a Tandem-shaped app on `node:sqlite` with spaces, transactions, nested calls and proposals), an app-written door, the guard with and without a caller, the MCP door through the official SDK client and side by side with the SDK's own server, raw malformed MCP requests, the change stream read with `fetch`, the served CLI as a child process, the browser client, type tests compiled against the packed tarball, and the notes example answering over HTTP, MCP, the CLI and the browser client in one run.

## Not done, or done differently from the plan

Everything in step 1 of the plan is built and tested. These are the places where the code does something the plan did not spell out or says differently:

- **Unknown MCP tool.** Returned as a tool error, as the plan and the SDK do. The MCP spec (2025-11-25) lists an unknown tool as a protocol error (-32602). One line to flip.
- **`kit` has two optional extra type parameters**, `Fields` (the app's own definition fields, so hooks can read them) and `ExtraInput` (fields a `schema` hook adds to every input, like Tandem's `space`).
- **A door's `list` narrows what `allow` lets through**, rather than replacing it, as diskzokej's MCP door does today.
- **The skill resolves the caller** like the API does, so for an app with sign-in it needs the key. The CLI, `/actions.js` and `/setup` are public files.
- **The example is 58 lines**, not about 40: the two actions and the mount are about 40, and the rest is the small page that shows the browser client.
