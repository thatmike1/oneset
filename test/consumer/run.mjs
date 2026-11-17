// the packed package from plain JavaScript: core and doors load and a run works
import { createRegistry, defineAction } from "oneset";
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
const doors = await import("oneset/doors");
process.stdout.write(`ok ${Object.keys(doors).sort().join(",")}\n`);
