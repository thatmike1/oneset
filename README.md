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
| `GET /api/actions` | the catalog: `{ app, actions: [{ name, tool, area, summary, mutates, long?, inputSchema }] }` |
| `POST /api/actions/<name>` | a run: `{ result }`, or `{ error: { code, message, issues? } }` with the error's status; a long action answers 202 `{ job }` |
| `POST /mcp` | the MCP door (stateless streamable HTTP, hand-written; the SDK is a dev dependency only) |
| `GET /cli/<name>.mjs` | a zero-dependency CLI with the app's name and address filled in |
| `GET /skill/SKILL.md` | a Claude Code skill listing the MCP tools |
| `GET /actions.js` | the browser client: `act(name, input)`, `onChange(fn)`; also in the package as `oneset/client` |
| `GET /api/actions/stream` | a server-sent `change` event to every subscriber after every successful outermost mutating run (a long one's when its job finishes): `{ action, door }` if the subscriber's caller may run that action, a bare `{ changed: true }` if not, `job` only for the job's owner |
| `GET /setup` | the MCP, CLI and skill lines to paste once |

A `base` option moves them all under a prefix.

## Long actions

An action that takes longer than a client waits (uncharted's `look.roll` is 70 to 75 s; an MCP client gives up at about 60) is marked `long: true`. Every door then answers at once with a job, and the kit adds one action, `job.get` (MCP `job_get`), that reads it. Start it, then read it.

```js
defineAction({ name: "look.roll", area: "looks", summary: "Roll six new looks", mutates: true, long: true, input, run });
```

The contract:

- **What answers at once.** Allow, the door's list rule and input validation run before the job starts, so a refusal or bad input is the usual immediate error. Only `around` and the handler run in the job. A handler that throws, even before its first `await`, fails the job; it is not an immediate error.
- **The start.** HTTP answers `202` with `{ job: { id, action, state, started, finished? } }`, the state `running` unless the handler finished synchronously. The start never carries the result or the error and never calls a renderer, so a renderer that fails cannot cost the caller its id; the outcome is read with `job.get`. MCP answers a normal tool result whose text is that `{ job }` JSON followed by one line telling the agent to call `job_get` with the id. The catalog marks the action `long: true`, and the MCP tool description ends with "Long: answers at once with a job id; read the result with job_get."
- **`job.get { id, wait? }`.** Answers `{ id, action, state, started, finished?, result?, error? }`, where `state` is `running`, `done` or `failed`. It waits up to `wait` seconds (default 30, at most 50, so one read stays under a 60 s client timeout; `0` answers at once) and answers as soon as the job finishes. A reader that disconnects stops waiting on the server; the job goes on. A failed job is a successful read: over HTTP `200 { result: { state: "failed", error } }`, over MCP a tool result without `isError`. `result` is rendered by the reading door's `render`, awaited when it returns a promise, so MCP shows the job's result the way a direct call would have; a renderer that throws fails that read, not the job.
- **Errors in a job.** A thrown ActionError (or anything with a numeric `status` and a string `code`) becomes `error: { status, code, message, issues?, body? }`, headers dropped. Anything else is logged on the server and becomes `{ status: 500, code: "internal", message: "something broke on the server" }`, as a direct call would.
- **Who reads a job.** `job.get` is listed wherever a long action is listed for that caller, and only there. It skips the app's `allow`, `schema`, `around`, `describe` and `render` hooks for itself, and checks the job's own action instead: a caller reads a job only when that action would be listed for it on the door it reads through. The id is a random UUID, so holding it is the rest of the check by default; an app with sign-in adds `jobOwner(caller)` to its hooks, and then only a caller with the same owner (`===`) reads the job. Every refusal is `404 unknown_job`, the same answer as for an id that never existed.
- **Where jobs live.** In memory, in the registry, shared by every door. A finished job is kept for an hour, and at most 1000 finished jobs are kept: when one more finishes, the oldest finished one goes. Reads never drop anything but expired jobs, and running jobs are never dropped. `createRegistry(defs, { jobs: { keepMs, max } })` changes both numbers. Expiry is lazy: it happens on the next start or read, not on a timer. A restart loses every job: the work that was running dies with the process, as a direct call's would, and its id then reads `unknown_job`.
- **The change stream.** The action's `change` event fires when the job finishes successfully, not when it starts, and after its state is set, so a listener that reads the job finds it done. It carries the job id: `{ action, door, job }`. A failed job sends nothing, and neither does one whose `around` called `info.skipChange()`. Every subscriber the app lets onto the stream hears every change; what the event carries depends on its caller, resolved when the stream opens. A caller the HTTP door would list the action for gets `{ action, door }`; any other gets a bare `{ changed: true }`, which says only that something changed (no action, subject, result or job), so a read-only viewer of a shared list still refetches when an editor adds to it. The job id goes only to the job's owner by `jobOwner`. An app whose one stream serves parties that must not learn even that the other changed something (several tenants) passes `doors(reg, { hears(change, subscriber, by) { ... } })`: it sees the change, the subscriber's caller and the caller whose run made the change, and a subscriber it does not return exactly `true` for hears nothing of that change. It decides synchronously: a promise is silence even when it resolves `true`, and a hook that throws or returns a promise that rejects is logged and counts as false, never a crash. The default is everyone. In an app with sign-in and no `jobOwner`, no stream carries job ids, the starter's own included, since an id is enough to read a job there. In an app with no `caller` resolver everyone is the one person behind the guard, so every subscriber gets the id.
- **The CLI** waits by default: it prints the job id to stderr, reads `job.get` until the job is done, then prints the result (or exits 1 with `code: message`). A shell call has no 60 s timeout, and a script wants the outcome and the exit code. `--no-wait`, where a flag goes, prints the job and returns; after a field it is that field's value (`--text --no-wait` sends the text "--no-wait"). An action field named `noWait` goes in through `--json '{"noWait":true}'`. `actions` and `help` mark long actions.
- **The browser client's `act`** waits too and returns the result or throws the ActionError, so a page uses a long action like any other; `act(name, input, { wait: false })` returns the job for a long action and the result for any other, and its type says so.
- **App code and nested runs** run inline: `reg.run` and a call from inside another action return the result (a promise), with no job. The job belongs to the door call; a nested job would detach the work from the outer action and hand its code a ticket it did not ask for. An app-written door from `reg.door` does start jobs; `door.starts(name)` says when.
- **Guidance.** When any action is long (an app's own `job.get` with no long action gets none of this), the MCP `instructions` get a paragraph after the app's own, the served skill a "Long actions" section and `(long)` on the tool, and the CLI's `actions` and `help` say so. An app with a long action needs nothing else; an app with its own action named `job.get` (or `job_get`) is refused at `createRegistry`, since the kit's reader takes that name.

## The pieces

- **Naming actions in text.** Write the MCP spelling (`look_roll`) in `instructions` and anything else an agent reads: the MCP tools use it, the skill lists it for both, and the CLI takes it as well as the dotted name (`uncharted look_roll --for x`).
- `kit<Caller, RunCtx, Fields?, ExtraInput?>()` returns a typed `defineAction` and `createRegistry`. The untyped ones are exported directly.
- `createRegistry(definitions, hooks)` takes one list (a repeated name throws) and the hooks `schema(def)`, `allow(def, caller)`, `around(def, input, caller, next, info)`, `error(problem)` and, for long actions, `jobOwner(caller)` and the `jobs` settings. `allow` decides synchronously: an `allow` typed to return a promise does not compile (a `() => void` helper still does), and one that returns a promise at run time refuses every call, so resolve async facts in the caller resolver.
- `reg.run(name, input, caller, info?)` runs allow, then validation against `schema(def)`, then `around`. A mutating run that succeeds sends a change event when it finishes; an `around` that rolls back and still returns normally (a dry run, `{ committed: false }`) calls `info.skipChange()` so none goes out. Throwing or rejecting suppresses it too, but turns the call into an error. `reg.onChange(fn)` hears each change as `fn(change)`; `reg.onChangeFrom(fn)` also passes `{ caller }`, whose run made it. The core never awaits: a sync chain returns a value, an async one a promise.
- `reg.door({ name, list, describe, render, draft })` makes a door an app can use itself: `catalog(caller)` and `run(name, input, caller)`, which refuses what it does not list.
- `ActionError(status, code, message, { issues, body, headers })` is the one error to throw. Doors render any thrown error by its `status`, `code`, `message` and `issues`.
- `doors(reg, options)` takes the app's `name` and `version` (what MCP clients see; the version defaults to 1.0.0, so pass the app's own), `instructions` and `when`, and mounts everything behind the guard (foreign Host and Origin refused, JSON bodies only, bodies capped). `hosts` and `origins` widen it; a non-loopback host with no `caller` refuses to start unless `openWithoutSignIn: true`.
- `oneset/client` is the browser client from the package. Its `createClient({ url, fetch, EventSource })` makes a client a module can be handed, so code that node tests import can use it with a test server and an EventSource stand-in; the page itself still loads `/actions.js`. `onChange` listeners hear `{ action, door }` for a run of an action this caller may run, `{ changed: true }` for a run of one it may not (a read-only page still learns that shared data changed), `{ connected: true }` once the stream is live and `{ reconnected: true }` after a drop. A listener that keeps fetched state refetches on any of them; one that waits for a particular action refetches on that action and on anything without an `action`.
- `mcp(reg, options)` from `oneset/doors` is the MCP door alone, `(req, res, caller, body?)`, for apps that keep their own routes and resolve their caller themselves. It keeps the same Host and Origin guard and takes the same `hosts`, `origins` and `maxBody`, so an app behind a proxy passes its public host in `hosts`. `handle.resolving(req, res, resolve, body?)` takes a function instead of a caller and calls it only once the request has passed the door's own checks, which is how `doors()` mounts it.

## Tests

```sh
export PATH="$HOME/.local/bin:$PATH"
pnpm install
pnpm test        # node:test, straight from the TypeScript source
pnpm gate        # Biome check, typecheck, build, tests, pack check
```

The suite covers the core against two fixtures (a notes app, and a Tandem-shaped app on `node:sqlite` with spaces, transactions, nested calls and proposals), an app-written door, the guard with and without a caller, the MCP door through the official SDK client and side by side with the SDK's own server, raw malformed MCP requests, the change stream read with `fetch`, the served CLI as a child process, the browser client, long actions through the core door, HTTP, the SDK client, the CLI, the browser client and the change stream, type tests compiled against the packed tarball, and the notes example answering over HTTP, MCP, the CLI and the browser client in one run.

## Not done, or done differently from the plan

Everything in step 1 of the plan is built and tested. These are the places where the code does something the plan did not spell out or says differently:

- **Unknown MCP tool.** Returned as a tool error, as the plan and the SDK do. The MCP spec (2025-11-25) lists an unknown tool as a protocol error (-32602). One line to flip.
- **`kit` has two optional extra type parameters**, `Fields` (the app's own definition fields, so hooks can read them) and `ExtraInput` (fields a `schema` hook adds to every input, like Tandem's `space`).
- **A door's `list` narrows what `allow` lets through**, rather than replacing it, as diskzokej's MCP door does today.
- **The skill resolves the caller** like the API does, so for an app with sign-in it needs the key. The CLI, `/actions.js` and `/setup` are public files.
- **The example is 58 lines**, not about 40: the two actions and the mount are about 40, and the rest is the small page that shows the browser client.
