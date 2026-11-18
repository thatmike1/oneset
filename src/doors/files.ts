// the files the doors serve: the CLI and the browser client with the app's name and address
// filled in, the skill generated from the MCP door's tools, and the setup page
import { readFileSync } from "node:fs";
import type { CatalogEntry } from "../core.ts";

/** the app's name as a file, command and MCP server name: lowercase, dashes */
export function slugOf(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) throw new Error(`oneset: the app name "${name}" has no letters or digits to name the CLI with`);
  return slug;
}

/** the prefix of the CLI's env vars: NOTES for NOTES_URL and NOTES_KEY */
export const envPrefixOf = (slug: string): string => slug.toUpperCase().replaceAll("-", "_");

const templates = new Map<string, string>();
function template(file: string): string {
  let text = templates.get(file);
  if (text === undefined) {
    text = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    templates.set(file, text);
  }
  return text;
}

/** swaps the line after `// oneset:settings` for the served settings */
function fill(file: string, constName: string, settings: Record<string, string>): string {
  const marker = "// oneset:settings\n";
  const text = template(file);
  const at = text.indexOf(marker);
  if (at < 0) throw new Error(`oneset: ${file} has lost its settings marker`);
  const lineStart = at + marker.length;
  const lineEnd = text.indexOf("\n", lineStart);
  return `${text.slice(0, lineStart)}const ${constName} = ${JSON.stringify(settings)};${text.slice(lineEnd)}`;
}

export interface AppInfo {
  name: string;
  slug: string;
  /** where the kit's paths start, base included: http://localhost:3000/kit */
  url: string;
  /** whether the app signs callers in, so agents need a key */
  signIn: boolean;
  instructions?: string;
  when?: string;
}

export function cliSource(app: AppInfo): string {
  return fill("cli.mjs", "APP", { name: app.name, slug: app.slug, url: app.url, env: envPrefixOf(app.slug) });
}

export function browserSource(app: AppInfo): string {
  return fill("browser.js", "SETTINGS", { url: app.url });
}

export function setupLines(app: AppInfo) {
  const key = app.signIn;
  const mcp = key
    ? `claude mcp add --transport http ${app.slug} ${app.url}/mcp --header "Authorization: Bearer <agent key>"`
    : `claude mcp add --transport http ${app.slug} ${app.url}/mcp`;
  const mcpJson = JSON.stringify(
    {
      mcpServers: {
        [app.slug]: {
          type: "http",
          url: `${app.url}/mcp`,
          ...(key ? { headers: { Authorization: "Bearer <agent key>" } } : {}),
        },
      },
    },
    null,
    2,
  );
  const auth = key ? ' -H "Authorization: Bearer <agent key>"' : "";
  const cli =
    `mkdir -p ~/.local/bin && curl -fsSL ${app.url}/cli/${app.slug}.mjs -o ~/.local/bin/${app.slug} ` +
    `&& chmod +x ~/.local/bin/${app.slug}${key ? ` && ${app.slug} login ${app.url} "<agent key>"` : ""}`;
  const skill =
    `mkdir -p ~/.claude/skills/${app.slug} && curl -fsSL${auth} ${app.url}/skill/SKILL.md ` +
    `-o ~/.claude/skills/${app.slug}/SKILL.md`;
  return { mcp, mcpJson, cli, skill };
}

export function skillMarkdown(app: AppInfo, tools: CatalogEntry[]): string {
  const description = app.when
    ? `${app.name}: ${app.when}`
    : `${app.name}'s actions, for its people and their agents.`;
  const lines = setupLines(app);
  const list = tools.map((t) => `- \`${t.tool}\` (CLI \`${app.slug} ${t.name}\`): ${t.summary}`).join("\n");
  return `---
name: ${app.slug}
description: ${JSON.stringify(description)}
---

# ${app.name}

${app.instructions ? `${app.instructions}\n\n` : ""}## How to reach it

- MCP server \`${app.slug}\`, tools named like \`${tools[0]?.tool ?? "area_action"}\`. If it is missing: \`${lines.mcp}\`
- Otherwise the CLI: \`${app.slug} <action> --field value\` (\`${app.slug} actions\` lists them, \`${app.slug} help <action>\` shows the fields). Install: \`${lines.cli}\`

## Tools

${list || "(none for this caller)"}
`;
}

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );

export function setupPage(app: AppInfo): string {
  const lines = setupLines(app);
  const block = (title: string, text: string, note = "") => `
  <section>
    <h2>${escapeHtml(title)}</h2>${note ? `\n    <p>${note}</p>` : ""}
    <div class="line"><pre><code>${escapeHtml(text)}</code></pre><button type="button">Copy</button></div>
  </section>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(app.name)}: agent setup</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 60rem; margin: 2rem auto; padding: 0 1rem; color: #1d1d1f; }
  h1 { font-size: 1.4rem; } h2 { font-size: 1rem; margin: 1.6rem 0 .4rem; }
  .line { display: flex; gap: .5rem; align-items: flex-start; }
  pre { flex: 1; margin: 0; padding: .6rem .8rem; background: #f3f3f5; border-radius: 6px; overflow-x: auto; }
  button { font: inherit; padding: .5rem .9rem; border: 1px solid #ccc; border-radius: 6px; background: #fff; cursor: pointer; }
  p { margin: .2rem 0 .5rem; color: #555; }
  @media (prefers-color-scheme: dark) { body { background: #111; color: #eee; } pre { background: #222; } button { background: #222; color: #eee; border-color: #444; } p { color: #aaa; } }
</style>
</head>
<body>
<h1>Give an agent ${escapeHtml(app.name)}</h1>
<p>Paste each line once on the machine the agent runs on.${
    app.signIn ? " Replace &lt;agent key&gt; with a key from the app." : " No sign-in or key needed."
  }</p>${block("MCP, for Claude Code", lines.mcp)}${block(
    "MCP, for other clients",
    lines.mcpJson,
    "The same server as JSON config.",
  )}${block("CLI", lines.cli, `Then <code>${escapeHtml(app.slug)} actions</code> lists what it can do.`)}${block(
    "Skill",
    lines.skill,
    "Tells the agent when to reach for these tools.",
  )}
<script>
  for (const button of document.querySelectorAll("button")) {
    button.addEventListener("click", async () => {
      await navigator.clipboard.writeText(button.previousElementSibling.textContent);
      button.textContent = "Copied";
      setTimeout(() => (button.textContent = "Copy"), 1500);
    });
  }
</script>
</body>
</html>
`;
}
