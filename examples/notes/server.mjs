// a notes app: its actions written once, used by a person through the page and by their agent
// through MCP or the CLI. Save it as server.mjs, run `node server.mjs`, then open /setup
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
