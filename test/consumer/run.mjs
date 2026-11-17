// the packed package from plain JavaScript: core and doors load, a run works, and the doors
// serve the files the build copies next to the compiled code
import { createServer } from "node:http";
import { createRegistry, defineAction } from "oneset";
import { doors } from "oneset/doors";
import { z } from "zod";

const reg = createRegistry([
  defineAction({
    name: "note.add",
    area: "notes",
    summary: "Add a note",
    mutates: true,
    input: z.object({ text: z.string() }),
    run: (input) => ({ text: input.text }),
  }),
]);
const out = reg.run("note.add", { text: "from the tarball" });
if (out.text !== "from the tarball") throw new Error("wrong result");

const handle = doors(reg, { name: "packed" });
const server = createServer(async (req, res) => {
  if (!(await handle(req, res))) res.writeHead(404).end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
try {
  for (const path of ["/cli/packed.mjs", "/actions.js", "/skill/SKILL.md", "/setup", "/api/actions"]) {
    const res = await fetch(base + path);
    if (res.status !== 200) throw new Error(`${path} answered ${res.status}`);
  }
} finally {
  server.close();
}
process.stdout.write("ok\n");
