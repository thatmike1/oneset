#!/usr/bin/env node
// an app's agent CLI: one zero-dependency file, served by the app with its name and address
// filled in. It reads the action catalog from the server, so every action is a command here.
//   <app> actions                        every action you may run, by area
//   <app> help note.add                  its fields
//   <app> note.add --text "milk"         run one; fields as --name value (note_add, the MCP
//                                        tool's spelling, works too)
//   <app> note.add --json '{"text":"x"}' the whole input as JSON (or --json - for stdin)
//   <app> look.roll --no-wait            a long action: print its job instead of waiting for it
//   <app> job.get --id <job id>          read a long action's job
//   <app> login <url> [key]              point it at another server, with an agent key if it needs one
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// oneset:settings
const APP = { name: "app", slug: "app", url: "http://localhost:3000", env: "APP" };

const CONFIG = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), APP.slug, "config.json");

function loadConfig() {
  let file = {};
  try {
    file = JSON.parse(readFileSync(CONFIG, "utf8"));
  } catch {}
  return {
    url: process.env[`${APP.env}_URL`] ?? file.url ?? APP.url,
    key: process.env[`${APP.env}_KEY`] ?? file.key,
  };
}

function die(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

async function call(cfg, method, path, body) {
  const headers = {};
  if (cfg.key) headers.authorization = `Bearer ${cfg.key}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  let res;
  try {
    res = await fetch(`${cfg.url.replace(/\/$/, "")}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    die(`cannot reach ${cfg.url}: ${err.cause?.code ?? err.message}`);
  }
  const data = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }));
  if (!res.ok) die(`${data.error?.code ?? res.status}: ${data.error?.message ?? "request failed"}`);
  return data;
}

/** turns --field value pairs into input, coercing by the field's JSON schema type */
function parseFlags(args, schema) {
  const props = schema.properties ?? {};
  const input = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) die(`unexpected argument ${arg}; fields are passed as --name value`);
    const [rawName, inline] = arg.slice(2).split(/=(.*)/s);
    const value = inline ?? args[++i];
    if (value === undefined) die(`--${rawName} needs a value`);
    if (rawName === "json") {
      Object.assign(input, JSON.parse(value === "-" ? readFileSync(0, "utf8") : value));
      continue;
    }
    const name = rawName.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    input[name] = coerce(value, props[name]);
  }
  return input;
}

function coerce(value, prop = {}) {
  const types = new Set([prop.type, ...(prop.anyOf ?? []).map((p) => p.type)].flat().filter(Boolean));
  if (types.has("array") || types.has("object")) {
    try {
      return JSON.parse(value);
    } catch {
      if (types.has("array")) return value.split(",").map((s) => s.trim());
    }
  }
  if ((types.has("integer") || types.has("number")) && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (types.has("boolean") && /^(true|false)$/.test(value)) return value === "true";
  if (types.has("null") && value === "null") return null;
  return value;
}

function fieldHelp(entry) {
  const props = entry.inputSchema.properties ?? {};
  const required = new Set(entry.inputSchema.required ?? []);
  const lines = [`${entry.name}: ${entry.summary}`, ""];
  if (entry.long) {
    lines.push(
      "long: it runs as a job. This CLI waits for the result and prints it; --no-wait prints the job",
      `instead, which ${APP.slug} job.get --id <job id> reads later.`,
      "",
    );
  }
  for (const [name, p] of Object.entries(props)) {
    const type = p.enum ? p.enum.join("|") : (p.type ?? (p.anyOf ?? []).map((a) => a.type).join("|"));
    const flag = name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    lines.push(
      `  --${flag} ${type}${required.has(name) ? " (required)" : ""}${p.description ? `  ${p.description}` : ""}`,
    );
  }
  if (Object.keys(props).length === 0) lines.push("  (no fields)");
  return lines.join("\n");
}

/** an action by its name or its MCP tool name, so text written for agents names it one way */
const find = (actions, name) => actions.find((a) => a.name === name) ?? actions.find((a) => a.tool === name);

const print = (result) =>
  process.stdout.write(`${typeof result === "string" ? result : JSON.stringify(result, null, 2)}\n`);

const [cmd, ...rest] = process.argv.slice(2);
const cfg = loadConfig();

if (!cmd || cmd === "--help" || cmd === "-h") {
  process.stdout.write(
    `${APP.slug} <action> [--field value ...] [--no-wait] | actions | help <action> | login <url> [key]\n` +
      `talks to ${cfg.url} (set ${APP.env}_URL and ${APP.env}_KEY, or run login, to change it)\n`,
  );
} else if (cmd === "login") {
  const [url, key] = rest;
  if (!url) die(`usage: ${APP.slug} login <url> [agent key]`);
  const { app, actions } = await call({ url, key }, "GET", "/api/actions");
  mkdirSync(join(CONFIG, ".."), { recursive: true });
  writeFileSync(CONFIG, JSON.stringify(key ? { url, key } : { url }, null, 2), { mode: 0o600 });
  process.stdout.write(`connected to ${app}: ${actions.length} actions; saved to ${CONFIG}\n`);
} else if (cmd === "actions") {
  const { actions } = await call(cfg, "GET", "/api/actions");
  let area = "";
  for (const a of actions) {
    if (a.area !== area) {
      area = a.area;
      process.stdout.write(`${area}\n`);
    }
    process.stdout.write(`  ${a.name.padEnd(22)} ${a.summary}${a.long ? " (long)" : ""}\n`);
  }
} else if (cmd === "help") {
  const { actions } = await call(cfg, "GET", "/api/actions");
  const entry = find(actions, rest[0]);
  if (!entry) die(`no action ${rest[0]}; run ${APP.slug} actions`);
  process.stdout.write(`${fieldHelp(entry)}\n`);
} else {
  const { actions } = await call(cfg, "GET", "/api/actions");
  const entry = find(actions, cmd);
  if (!entry) die(`no action ${cmd}; run ${APP.slug} actions`);
  const noWait = rest.includes("--no-wait");
  const out = await call(
    cfg,
    "POST",
    `/api/actions/${encodeURIComponent(entry.name)}`,
    parseFlags(
      rest.filter((a) => a !== "--no-wait"),
      entry.inputSchema,
    ),
  );
  if (!out.job) print(out.result);
  else if (noWait) print(out.job);
  else {
    // a long action: wait here, where no client timeout cuts the call short, and say how to
    // read the job if this process is stopped first
    const { id } = out.job;
    process.stderr.write(
      `${entry.name} runs as job ${id}; waiting for it (stopping this leaves it running: ${APP.slug} job.get --id ${id})\n`,
    );
    let job = out.job;
    while (job.state === "running") {
      job = (await call(cfg, "POST", "/api/actions/job.get", { id })).result;
    }
    if (job.state === "failed")
      die(`${job.error?.code ?? "failed"}: ${job.error?.message ?? "the job failed"}`);
    print(job.result);
  }
}
