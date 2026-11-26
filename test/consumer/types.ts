// compiled against the packed tarball: every @ts-expect-error below must be an error, and
// everything else must compile
import { type ActionDef, ActionError, type ActionsOf, kit } from "oneset";
import { type ClientJob, createClient } from "oneset/client";
import { z } from "zod";

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
const expectType = <T extends true>(_ok?: T) => {};

interface Actor {
  user: string;
}
interface Ctx {
  actor: Actor;
  space: string;
}
interface Subject {
  type: string;
  id: string;
}

const { defineAction, createRegistry } = kit<Actor, Ctx, { access: "any" | "human" }, { space?: string }>();

const add = defineAction({
  name: "note.add",
  area: "notes",
  summary: "Add a note",
  access: "any",
  mutates: true,
  input: z.object({ text: z.string(), pinned: z.boolean().default(false) }),
  run: (input, ctx) => {
    // handler input and context are typed
    expectType<Equal<typeof input, { text: string; pinned: boolean }>>();
    expectType<Equal<typeof ctx, Ctx>>();
    return { id: 1, text: input.text, by: ctx.actor.user };
  },
});

const later = defineAction({
  name: "note.later",
  area: "notes",
  summary: "Add a note later",
  access: "any",
  mutates: true,
  input: z.object({ n: z.number() }),
  run: async (input) => ({ n: input.n }),
});

defineAction({
  name: "note.bad_ctx",
  area: "notes",
  summary: "",
  access: "any",
  mutates: false,
  input: z.object({}),
  // @ts-expect-error the handler context has no such field
  run: (_input, ctx) => ctx.nope,
});

defineAction({
  name: "note.bad_input",
  area: "notes",
  summary: "",
  access: "any",
  mutates: false,
  input: z.object({ text: z.string() }),
  // @ts-expect-error the handler input has no such field
  run: (input) => input.txt,
});

defineAction({
  name: "note.bad_field",
  area: "notes",
  summary: "",
  // @ts-expect-error an app field is typed by the kit's Fields
  access: "everyone",
  mutates: false,
  input: z.object({}),
  run: () => null,
});

// app fields are carried through typed
const tagged = defineAction({
  name: "note.tagged",
  area: "notes",
  summary: "",
  access: "human",
  mutates: false,
  input: z.object({}),
  colour: "red",
  run: () => null,
});
expectType<Equal<typeof tagged.access, "human">>();
expectType<Equal<typeof tagged.colour, "red">>();

/** an app's own wrapper that types a field from the action's input, like Tandem's `subject` */
function appAction<const Nm extends string, I extends z.ZodObject, O>(
  def: ActionDef<Nm, I, O, Ctx> & {
    access: "any" | "human";
    subject?: (input: z.output<I>, ctx: Ctx) => Subject;
  },
) {
  return defineAction(def);
}

const accept = appAction({
  name: "item.accept",
  area: "items",
  summary: "Accept an item",
  access: "any",
  mutates: true,
  input: z.object({ item: z.number() }),
  subject: (input, ctx) => ({ type: "item", id: `${input.item.toFixed(0)} in ${ctx.space}` }),
  run: (input) => ({ accepted: input.item }),
});

appAction({
  name: "item.bad_subject",
  area: "items",
  summary: "",
  access: "any",
  mutates: true,
  input: z.object({ item: z.number() }),
  // @ts-expect-error the wrapper types subject's input from the action's input
  subject: (input) => ({ type: "item", id: input.nope }),
  run: () => null,
});

const reg = createRegistry([add, later, accept], {
  allow(def, caller) {
    expectType<Equal<typeof caller, Actor>>();
    if (def.access === "human" && caller.user === "agent") throw new ActionError(403, "people_only", "no");
  },
  around: (_def, input, caller, next) => next(input, { actor: caller, space: "home" }),
});

const ada: Actor = { user: "ada" };
reg.run("note.add", { text: "x" }, ada);
reg.run("note.add", { text: "x", space: "work" }, ada);
reg.run("note.later", { n: 1 }, ada, { nested: true, door: "mcp" });

// @ts-expect-error a wrong action name fails to compile
reg.run("note.nope", { text: "x" }, ada);
// @ts-expect-error a wrong input field fails to compile
reg.run("note.add", { txt: "x" }, ada);
// @ts-expect-error a wrong field type fails to compile
reg.run("note.add", { text: 1 }, ada);
// @ts-expect-error the caller is typed
reg.run("note.add", { text: "x" }, { nobody: true });

// with no around, run returns the handler's own output, sync or async as written
const plain = createRegistry([add, later]);
expectType<Equal<ReturnType<typeof plain.run<"note.add">>, { id: number; text: string; by: string }>>();
expectType<Equal<ReturnType<typeof plain.run<"note.later">>, Promise<{ n: number }>>>();

// a client's view: names, inputs and awaited outputs
type Actions = ActionsOf<typeof reg>;
expectType<Equal<keyof Actions, "note.add" | "note.later" | "item.accept">>();
expectType<Equal<Actions["note.later"]["output"], { n: number }>>();
expectType<Equal<Actions["item.accept"]["output"], { accepted: number }>>();
expectType<
  Equal<Actions["note.add"]["input"], { text: string; pinned?: boolean | undefined } & { space?: string }>
>();

declare function act<N extends keyof Actions>(
  name: N,
  input: Actions[N]["input"],
): Promise<Actions[N]["output"]>;
act("note.later", { n: 2 }).then((out) => out.n.toFixed());
// @ts-expect-error a client cannot call a name that is not there
act("note.gone", {});
// @ts-expect-error nor send a wrong field
act("note.later", { m: 2 });

// the package's browser client, typed by the same view
const client = createClient<Actions>({ url: "http://127.0.0.1:1" });
client.act("note.later", { n: 2 }).then((out) => out.n.toFixed());
// @ts-expect-error the typed client knows the names
client.act("note.gone", {});
client.onChange((change) => (change.action ? change.door.length : change.connected));
// a bare change, for an action this caller may not run, says only that something changed
client.onChange((change) =>
  change.action === undefined ? change.changed || change.connected || change.reconnected : change.door,
);
// { wait: false } returns a job only for a long action; an ordinary one answers its own result
// @ts-expect-error so the type may not promise a job
const notJob: Promise<ClientJob> = client.act("note.later", { n: 1 }, { wait: false });
void notJob;
const either: Promise<ClientJob | { n: number }> = client.act("note.later", { n: 1 }, { wait: false });
void either;

// allow decides synchronously: an existing void-returning helper fits, an async one does not
const allowHelper: (def: { name: string }, caller: Actor) => void = (_def, caller) => {
  if (caller.user === "agent") throw new ActionError(403, "no", "no");
};
createRegistry([add], { allow: allowHelper });
createRegistry([add], {
  allow(def, caller) {
    if (def.access === "human" && caller.user === "agent") throw new ActionError(403, "no", "no");
  },
});
createRegistry([add], {
  // @ts-expect-error an allow that returns a promise is refused at compile time
  allow: async () => {},
});
