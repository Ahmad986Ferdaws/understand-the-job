import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  UnsafeDataDirError,
  assertSafeUaDir,
  loadConfig,
  loadDomainGraph,
  loadFingerprints,
  loadGraph,
  loadMeta,
  resolveUaDirName,
  saveConfig,
  saveDomainGraph,
  saveFingerprints,
  saveGraph,
  saveMeta,
} from "./index.js";
import { safeReadFile, safeWriteFile } from "./safe-io.js";
import type { KnowledgeGraph } from "../types.js";
import type { FingerprintStore } from "../fingerprint.js";

// Creating symlinks on Windows needs elevated rights; the guards themselves
// are exercised on POSIX CI.
const describePosix = process.platform === "win32" ? describe.skip : describe;

const graph: KnowledgeGraph = {
  version: "1.0.0",
  project: {
    name: "p",
    languages: [],
    frameworks: [],
    description: "d",
    analyzedAt: "2026-01-01T00:00:00.000Z",
    gitCommitHash: "abc1234",
  },
  nodes: [
    {
      id: "file:a.ts",
      type: "file",
      name: "a.ts",
      filePath: "a.ts",
      summary: "s",
      tags: [],
      complexity: "simple",
    },
  ],
  edges: [],
  layers: [],
  tour: [],
};

const fingerprints: FingerprintStore = {
  version: "1.0.0",
  gitCommitHash: "abc1234",
  generatedAt: "2026-01-01T00:00:00.000Z",
  files: {},
};

describePosix("persistence refuses to follow symlinks", () => {
  let root: string; // the "hostile repo"
  let outside: string; // somewhere a hostile symlink would point
  let victim: string; // a file the attacker wants overwritten

  beforeEach(() => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "ua-sec-")));
    root = join(base, "repo");
    outside = join(base, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    victim = join(outside, ".zshrc");
    writeFileSync(victim, "# precious\n");
  });

  afterEach(() => {
    rmSync(join(root, ".."), { recursive: true, force: true });
  });

  describe("symlinked data file inside a real .ua/", () => {
    it("saveFingerprints replaces the symlink and never writes through it", () => {
      mkdirSync(join(root, ".ua"));
      symlinkSync(victim, join(root, ".ua", "fingerprints.json"));

      saveFingerprints(root, fingerprints);

      expect(readFileSync(victim, "utf-8")).toBe("# precious\n");
      const target = join(root, ".ua", "fingerprints.json");
      expect(lstatSync(target).isSymbolicLink()).toBe(false);
      expect(loadFingerprints(root)).toEqual(fingerprints);
    });

    it.each([
      ["knowledge-graph.json", () => saveGraph(root, graph)],
      ["meta.json", () => saveMeta(root, { lastAnalyzedAt: "t", gitCommitHash: "abc1234", version: "1.0.0", analyzedFiles: 0 })],
      ["config.json", () => saveConfig(root, { autoUpdate: false })],
      ["domain-graph.json", () => saveDomainGraph(root, graph)],
    ])("%s is replaced, not written through", (name, save) => {
      mkdirSync(join(root, ".ua"));
      symlinkSync(victim, join(root, ".ua", name));

      save();

      expect(readFileSync(victim, "utf-8")).toBe("# precious\n");
      expect(lstatSync(join(root, ".ua", name)).isSymbolicLink()).toBe(false);
    });

    it("a dangling symlink target is not created", () => {
      const ghost = join(outside, "ghost");
      mkdirSync(join(root, ".ua"));
      symlinkSync(ghost, join(root, ".ua", "meta.json"));

      saveMeta(root, { lastAnalyzedAt: "t", gitCommitHash: "abc1234", version: "1.0.0", analyzedFiles: 0 });

      expect(existsSync(ghost)).toBe(false);
    });

    it("loaders refuse a symlinked file instead of reading its target", () => {
      mkdirSync(join(root, ".ua"));
      const secret = join(outside, "secret.json");
      writeFileSync(secret, JSON.stringify(graph));
      for (const name of ["knowledge-graph.json", "domain-graph.json", "meta.json", "fingerprints.json", "config.json"]) {
        symlinkSync(secret, join(root, ".ua", name));
      }

      expect(() => loadGraph(root)).toThrow(UnsafeDataDirError);
      expect(() => loadDomainGraph(root)).toThrow(UnsafeDataDirError);
      expect(() => loadMeta(root)).toThrow(UnsafeDataDirError);
      // Lenient loaders swallow parse errors, but never a symlink refusal.
      expect(() => loadFingerprints(root)).toThrow(UnsafeDataDirError);
      expect(() => loadConfig(root)).toThrow(UnsafeDataDirError);
    });
  });

  describe("symlinked data directory", () => {
    it("refuses every write when .ua is a symlink out of the project", () => {
      const target = join(outside, "ua-target");
      mkdirSync(target);
      symlinkSync(target, join(root, ".ua"));

      expect(() => saveGraph(root, graph)).toThrow(UnsafeDataDirError);
      expect(() => saveMeta(root, { lastAnalyzedAt: "t", gitCommitHash: "", version: "1.0.0", analyzedFiles: 0 })).toThrow(UnsafeDataDirError);
      expect(() => saveFingerprints(root, fingerprints)).toThrow(UnsafeDataDirError);
      expect(() => saveConfig(root, { autoUpdate: false })).toThrow(UnsafeDataDirError);
      expect(() => saveDomainGraph(root, graph)).toThrow(UnsafeDataDirError);
      expect(readdirSync(target)).toEqual([]);
    });

    it("refuses reads when .ua is a symlink", () => {
      const target = join(outside, "ua-target");
      mkdirSync(target);
      writeFileSync(join(target, "knowledge-graph.json"), JSON.stringify(graph));
      symlinkSync(target, join(root, ".ua"));

      expect(() => loadGraph(root)).toThrow(UnsafeDataDirError);
      expect(() => loadMeta(root)).toThrow(UnsafeDataDirError);
      expect(() => assertSafeUaDir(root)).toThrow(UnsafeDataDirError);
    });

    it("still rejects a symlink that points to another directory inside the project", () => {
      mkdirSync(join(root, "real-dir"));
      symlinkSync(join(root, "real-dir"), join(root, ".ua"));

      expect(() => saveGraph(root, graph)).toThrow(/symbolic link/);
      expect(readdirSync(join(root, "real-dir"))).toEqual([]);
    });

    it("treats a symlinked legacy .understand-anything as the data dir and rejects it", () => {
      const target = join(outside, "legacy");
      mkdirSync(target);
      symlinkSync(target, join(root, ".understand-anything"));

      expect(resolveUaDirName(root)).toBe(".understand-anything");
      expect(() => saveGraph(root, graph)).toThrow(UnsafeDataDirError);
      expect(readdirSync(target)).toEqual([]);
      expect(existsSync(join(root, ".ua"))).toBe(false);
    });

    it("a dangling symlinked legacy dir is still picked up and rejected", () => {
      symlinkSync(join(outside, "nowhere"), join(root, ".understand-anything"));

      expect(resolveUaDirName(root)).toBe(".understand-anything");
      expect(() => saveMeta(root, { lastAnalyzedAt: "t", gitCommitHash: "", version: "1.0.0", analyzedFiles: 0 })).toThrow(UnsafeDataDirError);
      expect(existsSync(join(outside, "nowhere"))).toBe(false);
    });
  });

  describe("normal operation", () => {
    it("creates the data dir and round-trips through the safe writer", () => {
      saveGraph(root, graph);
      saveMeta(root, { lastAnalyzedAt: "t", gitCommitHash: "abc1234", version: "1.0.0", analyzedFiles: 1 });
      saveConfig(root, { autoUpdate: false });

      expect(loadGraph(root)).toEqual(graph);
      expect(loadMeta(root)?.analyzedFiles).toBe(1);
      expect(loadConfig(root)).toEqual({ autoUpdate: false });
    });

    it("overwrites an existing regular file", () => {
      saveConfig(root, { autoUpdate: false });
      saveConfig(root, { autoUpdate: false, outputLanguage: "de" });

      expect(loadConfig(root).outputLanguage).toBe("de");
    });

    it("leaves no temp files behind", () => {
      saveGraph(root, graph);
      saveGraph(root, graph);
      saveFingerprints(root, fingerprints);

      expect(readdirSync(join(root, ".ua")).sort()).toEqual([
        "fingerprints.json",
        "knowledge-graph.json",
      ]);
    });

    it("cleans up the temp file when the final rename fails", () => {
      mkdirSync(join(root, ".ua", "meta.json"), { recursive: true }); // a directory where a file should go

      expect(() =>
        saveMeta(root, { lastAnalyzedAt: "t", gitCommitHash: "", version: "1.0.0", analyzedFiles: 0 }),
      ).toThrow();
      expect(readdirSync(join(root, ".ua"))).toEqual(["meta.json"]);
    });

    it("works when the project root itself is reached through a symlink", () => {
      const alias = join(outside, "alias-to-repo");
      symlinkSync(root, alias);

      saveGraph(alias, graph);

      expect(existsSync(join(root, ".ua", "knowledge-graph.json"))).toBe(true);
      expect(loadGraph(alias)).toEqual(graph);
    });

    it("assertSafeUaDir accepts a missing and a normal data dir", () => {
      expect(() => assertSafeUaDir(root)).not.toThrow();
      mkdirSync(join(root, ".ua"));
      expect(() => assertSafeUaDir(root)).not.toThrow();
    });
  });

  describe("safe-io helpers", () => {
    it("rejects file names that are not a plain basename", () => {
      const dir = join(root, ".ua");
      for (const bad of ["", ".", "..", "../evil", "a/b", "a\\b"]) {
        expect(() => safeWriteFile(root, dir, bad, "x")).toThrow(/Invalid data file name/);
        expect(() => safeReadFile(root, dir, bad)).toThrow(/Invalid data file name/);
      }
    });

    it("safeReadFile returns null for a missing dir or file", () => {
      expect(safeReadFile(root, join(root, ".ua"), "meta.json")).toBeNull();
      mkdirSync(join(root, ".ua"));
      expect(safeReadFile(root, join(root, ".ua"), "meta.json")).toBeNull();
    });

    it("safeReadFile rejects a directory where a file is expected", () => {
      mkdirSync(join(root, ".ua", "meta.json"), { recursive: true });
      expect(() => safeReadFile(root, join(root, ".ua"), "meta.json")).toThrow(/not a regular file/);
    });

    it("a missing project root is not an error while the data dir is absent", () => {
      const ghostRoot = join(outside, "does-not-exist");
      expect(safeReadFile(ghostRoot, join(ghostRoot, ".ua"), "x.json")).toBeNull();
      expect(() => assertSafeUaDir(ghostRoot)).not.toThrow();
    });
  });
});
