// the notes fixture: a tiny app with sync and async handlers and no sign-in
import { z } from "zod";
import { createRegistry, defineAction, type Hooks } from "../../src/index.ts";

export interface Note {
  id: number;
  text: string;
}

export function notesActions(store: Note[] = []) {
  let next = store.length + 1;
  return [
    defineAction({
      name: "note.add",
      area: "notes",
      summary: "Add a note",
      mutates: true,
      input: z.object({ text: z.string().min(1) }),
      run: (input): Note => {
        const note = { id: next++, text: input.text };
        store.push(note);
        return note;
      },
    }),
    defineAction({
      name: "note.list",
      area: "notes",
      summary: "List every note",
      mutates: false,
      input: z.object({}),
      run: () => [...store],
    }),
    defineAction({
      name: "note.add_later",
      area: "notes",
      summary: "Add a note after a short wait",
      mutates: true,
      input: z.object({ text: z.string().min(1) }),
      run: async (input): Promise<Note> => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        const note = { id: next++, text: input.text };
        store.push(note);
        return note;
      },
    }),
    defineAction({
      name: "note.count",
      area: "notes",
      summary: "How many notes there are",
      mutates: false,
      input: z.object({}),
      run: async () => store.length,
    }),
    defineAction({
      name: "note.fail_later",
      area: "notes",
      summary: "Always fails, asynchronously",
      mutates: true,
      input: z.object({}),
      run: async (): Promise<never> => {
        throw new Error("it broke");
      },
    }),
    defineAction({
      name: "note.fail",
      area: "notes",
      summary: "Always fails",
      mutates: true,
      input: z.object({}),
      run: (): never => {
        throw new Error("it broke");
      },
    }),
  ] as const;
}

export function notesRegistry(hooks?: Hooks, store: Note[] = []) {
  return createRegistry(notesActions(store), hooks);
}
