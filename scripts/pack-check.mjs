// packs the package and checks the tarball holds the built entry points and nothing else
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "oneset-pack-"));
try {
  execFileSync("pnpm", ["pack", "--pack-destination", dir], { stdio: "pipe" });
  const tarball = execFileSync("sh", ["-c", `ls ${dir}/*.tgz`])
    .toString()
    .trim();
  const files = execFileSync("tar", ["-tzf", tarball]).toString().trim().split("\n").sort();
  const pkg = JSON.parse(execFileSync("tar", ["-xzOf", tarball, "package/package.json"]).toString());
  const need = ["package/package.json", "package/dist/index.js", "package/dist/index.d.ts"];
  for (const entry of Object.values(pkg.exports)) {
    if (typeof entry === "object") for (const p of Object.values(entry)) need.push(`package/${p.slice(2)}`);
  }
  const missing = need.filter((f) => !files.includes(f));
  const stray = files.filter(
    (f) => !f.startsWith("package/dist/") && !/^package\/(package\.json|README\.md)$/.test(f),
  );
  if (missing.length || stray.length) {
    console.error(
      `pack check failed\n  missing: ${missing.join(", ") || "none"}\n  stray: ${stray.join(", ") || "none"}`,
    );
    process.exit(1);
  }
  if (pkg.dependencies && Object.keys(pkg.dependencies).length) {
    console.error(`pack check failed: runtime dependencies ${Object.keys(pkg.dependencies).join(", ")}`);
    process.exit(1);
  }
  console.log(
    `pack check ok: ${files.length} files, peer deps ${Object.keys(pkg.peerDependencies ?? {}).join(", ")}`,
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
