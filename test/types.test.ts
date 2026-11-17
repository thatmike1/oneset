// types against the packed tarball: build, pack, install into test/consumer and compile it there,
// so the published .d.ts files are what is checked, not the source
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const consumer = join(root, "test", "consumer");
const sh = (cmd: string, args: string[], cwd = root) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

test("the packed package type-checks in a consumer project and runs from plain JS", {
  timeout: 180_000,
}, () => {
  sh("pnpm", ["run", "-s", "build"]);
  const dir = mkdtempSync(join(tmpdir(), "oneset-pack-"));
  try {
    sh("pnpm", ["pack", "--pack-destination", dir]);
    const tarball = readdirSync(dir).find((f) => f.endsWith(".tgz"));
    assert.ok(tarball, "pnpm pack made no tarball");
    copyFileSync(join(dir, tarball), join(consumer, "oneset.tgz"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  rmSync(join(consumer, "node_modules"), { recursive: true, force: true });
  sh("pnpm", ["install", "--prefer-offline", "--ignore-scripts", "--config.lockfile=false"], consumer);

  try {
    sh(join(root, "node_modules", ".bin", "tsc"), ["-p", join(consumer, "tsconfig.json")]);
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    assert.fail(`the consumer did not compile:\n${e.stdout ?? ""}${e.stderr ?? ""}`);
  }
  assert.equal(sh("node", ["run.mjs"], consumer), "ok\n");
});
