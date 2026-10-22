#!/usr/bin/env node
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { mergeDesignGraph } from "@understand-anything/core/figma";
import { saveGraph, saveMeta } from "@understand-anything/core";
import { assertSafeDataDir } from "../understand/ensure-safe-data-dir.mjs";

// Usage: node figma-merge.mjs <projectRoot> [--force]
// Exit codes: 0 ok, 1 merge failed, 2 unsafe data dir, 3 refused to overwrite
// a code graph (pass --force to replace it).
const args = process.argv.slice(2);
const force = args.includes("--force");
const [projectRoot] = args.filter((a) => !a.startsWith("--"));
if (!projectRoot) {
  console.error("Usage: node figma-merge.mjs <projectRoot> [--force]");
  process.exit(1);
}

// The data dir lives in the (untrusted) repo: refuse symlinks anywhere in it.
let outDir;
try {
  outDir = assertSafeDataDir(projectRoot);
} catch (err) {
  console.error(`Unsafe data directory: ${err.message}`);
  process.exit(2);
}

function readJsonIfPresent(file) {
  if (!existsSync(file)) return { present: false };
  try {
    return { present: true, value: JSON.parse(readFileSync(file, "utf8")) };
  } catch {
    return { present: true, value: undefined }; // exists but unparseable
  }
}

const CODE_NODE_TYPES = new Set(["file", "function", "class"]);

// Classify what is already in the data dir. Design and knowledge graphs carry
// kind:"design"/"knowledge" and may be replaced freely. Graphs from /understand
// are validated by core, which drops `kind`, so they are recognised by what
// they contain: code-type nodes, or a meta.json recording a git commit.
// Anything we cannot read is treated as "might be someone's work" - refuse.
function existingGraphVerdict() {
  const graph = readJsonIfPresent(join(outDir, "knowledge-graph.json"));
  const meta = readJsonIfPresent(join(outDir, "meta.json"));
  const metaIsCode =
    meta.value &&
    typeof meta.value === "object" &&
    typeof meta.value.gitCommitHash === "string" &&
    meta.value.gitCommitHash !== "" &&
    meta.value.figmaVersion === undefined;

  if (!graph.present) {
    return metaIsCode ? "a meta.json recording a git commit (from /understand)" : null;
  }
  const g = graph.value;
  if (g === null || typeof g !== "object" || Array.isArray(g)) {
    return "an unreadable knowledge-graph.json";
  }
  if (g.kind === "design" || g.kind === "knowledge") return null;
  if (g.kind === "codebase") return "a code graph (kind: codebase)";
  if (Array.isArray(g.nodes) && g.nodes.some((n) => n && CODE_NODE_TYPES.has(n.type))) {
    return "a code graph (file/function/class nodes)";
  }
  if (metaIsCode) return "a graph whose meta.json records a git commit (from /understand)";
  return null;
}

// Design graphs share knowledge-graph.json + meta.json with /understand.
const existing = existingGraphVerdict();
if (existing) {
  if (!force) {
    console.error(
      `Refusing to overwrite ${existing} in ${outDir}. A design graph would replace it. ` +
      `Re-run with --force to replace it, or analyze the design from a different project folder.`,
    );
    process.exit(3);
  }
  console.error(`--force: replacing ${existing} in ${outDir}`);
}

const interDir = join(outDir, "intermediate");
const manifest = JSON.parse(readFileSync(join(interDir, "scan-manifest.json"), "utf8"));
const analyses = readdirSync(interDir)
  .filter((f) => /^analysis-batch-.*\.json$/.test(f))
  .map((f) => JSON.parse(readFileSync(join(interDir, f), "utf8")));

const result = mergeDesignGraph(
  { nodes: manifest.nodes, edges: manifest.edges },
  analyses,
  manifest.project,
);
if (!result.success || !result.data) {
  console.error("Merge failed:", result.fatal ?? "unknown error");
  process.exit(1);
}

// Written via core's persistence layer: temp file + rename, never through a symlink.
saveGraph(projectRoot, result.data);
saveMeta(projectRoot, {
  lastAnalyzedAt: new Date().toISOString(),
  figmaVersion: manifest.figmaVersion ?? "",
  version: "1.0.0",
  analyzedFiles: result.data.nodes.length,
});

console.error(
  `Design graph: ${result.data.nodes.length} nodes, ${result.data.edges.length} edges, ` +
  `${result.data.layers.length} layers, ${result.data.tour.length} tour steps`,
);
for (const issue of result.issues) {
  if (issue.level !== "auto-corrected") console.error(`[${issue.level}] ${issue.message}`);
}
