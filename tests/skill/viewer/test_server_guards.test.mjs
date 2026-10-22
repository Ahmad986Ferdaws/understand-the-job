// Unit tests for the guards shared by viewer.mjs and the dashboard dev server
// (packages/viewer/bin/server-guards.mjs): CSP + headers, Host check, token
// compare, symlink-safe reads, allowlist cache, and the browser opener.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, realpathSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const guards = await import(
  join(REPO_ROOT, "understand-anything-plugin", "packages", "viewer", "bin", "server-guards.mjs")
);

const EXPECTED_CSP =
  "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; " +
  "script-src 'self'; connect-src 'self'; font-src 'self' data:; worker-src 'self' blob:; " +
  "frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

describe("buildCsp / applySecurityHeaders", () => {
  it("is the strict no-outside-hosts policy by default", () => {
    expect(guards.buildCsp()).toBe(EXPECTED_CSP);
  });

  it("only relaxes script/connect for the dev server", () => {
    const dev = guards.buildCsp({ dev: true });
    expect(dev).toContain("script-src 'self' 'unsafe-inline'");
    expect(dev).toContain("connect-src 'self' ws://127.0.0.1:* ws://localhost:*");
    // Nothing else changes: no remote host sneaks in.
    expect(dev).not.toMatch(/https?:/);
    expect(dev).toContain("img-src 'self' data: blob:");
    expect(dev).toContain("default-src 'self'");
  });

  it("omits frame-ancestors for the <meta> variant (ignored there)", () => {
    const meta = guards.buildCsp({ meta: true });
    expect(meta).not.toContain("frame-ancestors");
    expect(meta).toContain("form-action 'none'");
  });

  it("sets nosniff/no-referrer/CORP always and CSP only on HTML", () => {
    const set = (html) => {
      const headers = {};
      guards.applySecurityHeaders({ setHeader: (k, v) => (headers[k] = v) }, { html });
      return headers;
    };
    const plain = set(false);
    expect(plain["X-Content-Type-Options"]).toBe("nosniff");
    expect(plain["Referrer-Policy"]).toBe("no-referrer");
    expect(plain["Cross-Origin-Resource-Policy"]).toBe("same-origin");
    expect(plain["Content-Security-Policy"]).toBeUndefined();
    expect(set(true)["Content-Security-Policy"]).toBe(EXPECTED_CSP);
  });
});

describe("isAllowedHost", () => {
  it("accepts only loopback names on the bound port", () => {
    expect(guards.isAllowedHost("127.0.0.1:5173", 5173)).toBe(true);
    expect(guards.isAllowedHost("localhost:5173", 5173)).toBe(true);
    expect(guards.isAllowedHost("LOCALHOST:5173", 5173)).toBe(true);
    expect(guards.isAllowedHost("127.0.0.1:5174", 5173)).toBe(false);
    expect(guards.isAllowedHost("127.0.0.1", 5173)).toBe(false);
    expect(guards.isAllowedHost("evil.example:5173", 5173)).toBe(false);
    expect(guards.isAllowedHost("127.0.0.1.evil.example:5173", 5173)).toBe(false);
    expect(guards.isAllowedHost("localhost.evil.example:5173", 5173)).toBe(false);
    expect(guards.isAllowedHost("evil.example/127.0.0.1:5173", 5173)).toBe(false);
    expect(guards.isAllowedHost("[::1]:5173", 5173)).toBe(false);
    expect(guards.isAllowedHost("", 5173)).toBe(false);
    expect(guards.isAllowedHost(undefined, 5173)).toBe(false);
  });

  it("checks the name only when no port is given", () => {
    expect(guards.isAllowedHost("localhost:9999")).toBe(true);
    expect(guards.isAllowedHost("127.0.0.1")).toBe(true);
    expect(guards.isAllowedHost("evil.example:5173")).toBe(false);
  });
});

describe("tokensMatch / resolveAccessToken", () => {
  it("compares tokens exactly and tolerates bad input", () => {
    expect(guards.tokensMatch("abc123", "abc123")).toBe(true);
    expect(guards.tokensMatch("abc123", "abc124")).toBe(false);
    expect(guards.tokensMatch("abc", "abc123")).toBe(false);
    expect(guards.tokensMatch("", "abc123")).toBe(false);
    expect(guards.tokensMatch(null, "abc123")).toBe(false);
    expect(guards.tokensMatch(undefined, undefined)).toBe(false);
  });

  it("uses a sane env token, else a random 32-hex one", () => {
    const good = "a".repeat(16) + "-_" + "Z9";
    expect(guards.resolveAccessToken({ UNDERSTAND_ACCESS_TOKEN: good })).toBe(good);
    const random = guards.resolveAccessToken({});
    expect(random).toMatch(/^[a-f0-9]{32}$/);
    for (const bad of ["short", "has space and is long enough", 'x"y&z' + "a".repeat(20), "a".repeat(200)]) {
      expect(guards.resolveAccessToken({ UNDERSTAND_ACCESS_TOKEN: bad })).toMatch(/^[a-f0-9]{32}$/);
    }
  });
});

describe("path helpers", () => {
  it("normalizeGraphPath keeps in-project paths and drops everything else", () => {
    const root = "/home/a/proj";
    expect(guards.normalizeGraphPath("src/a.ts", root)).toBe("src/a.ts");
    expect(guards.normalizeGraphPath("./src//a.ts", root)).toBe("src/a.ts");
    expect(guards.normalizeGraphPath("/home/a/proj/src/a.ts", root)).toBe("src/a.ts");
    expect(guards.normalizeGraphPath("../etc/passwd", root)).toBeNull();
    expect(guards.normalizeGraphPath("src/../../etc/passwd", root)).toBeNull();
    expect(guards.normalizeGraphPath("/etc/passwd", root)).toBeNull();
    // Sibling directory that merely shares the root as a string prefix.
    expect(guards.normalizeGraphPath("/home/a/proj-evil/secret", root)).toBeNull();
    expect(guards.normalizeGraphPath("", root)).toBeNull();
    expect(guards.normalizeGraphPath(".", root)).toBeNull();
    expect(guards.normalizeGraphPath("a\0b", root)).toBeNull();
  });

  it("relativizeNodePaths never leaks the directory layout", () => {
    const root = "/home/a/proj";
    const graph = guards.relativizeNodePaths(
      {
        nodes: [
          { id: "1", filePath: "/home/a/proj/src/a.ts" },
          { id: "2", filePath: "/home/a/proj-evil/secret.txt" },
          { id: "3", filePath: "/etc/passwd" },
          { id: "4", filePath: "src/b.ts" },
          { id: "5" },
        ],
      },
      root,
    );
    expect(graph.nodes.map((n) => n.filePath)).toEqual([
      "src/a.ts", "secret.txt", "passwd", "src/b.ts", undefined,
    ]);
  });
});

describe("symlink-safe file access", () => {
  let base;
  let root;
  let outside;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "ua-guards-")));
    root = join(base, "project");
    outside = join(base, "outside");
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, ".ua"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(outside, "secret.txt"), "TOP SECRET\n");
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const read = (requestedPath, allowed) =>
    guards.readSourceFile({
      projectRoot: root,
      requestedPath,
      allowedPaths: new Set(allowed ?? [requestedPath]),
    });

  it("reads a normal listed file", () => {
    const res = read("src/a.ts");
    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatchObject({ path: "src/a.ts", language: "typescript" });
  });

  it("refuses files that are not listed in the graph", () => {
    expect(read("src/a.ts", []).statusCode).toBe(404);
  });

  it("refuses a file symlink that points outside the project", () => {
    symlinkSync(join(outside, "secret.txt"), join(root, "src", "leak.ts"));
    const res = read("src/leak.ts");
    expect(res.statusCode).toBe(403);
    expect(JSON.stringify(res.payload)).not.toContain("SECRET");
  });

  it("refuses a path that goes through a symlinked directory leaving the project", () => {
    symlinkSync(outside, join(root, "src", "linked"));
    const res = read("src/linked/secret.txt");
    expect(res.statusCode).toBe(403);
    expect(JSON.stringify(res.payload)).not.toContain("SECRET");
  });

  it("refuses a relative symlink that climbs out with ..", () => {
    symlinkSync("../../outside/secret.txt", join(root, "src", "climb.ts"));
    expect(read("src/climb.ts").statusCode).toBe(403);
  });

  it("allows a symlink that stays inside the project", () => {
    symlinkSync("a.ts", join(root, "src", "alias.ts"));
    const res = read("src/alias.ts");
    expect(res.statusCode).toBe(200);
    expect(res.payload.content).toContain("export const a");
  });

  it("returns 404 for a dangling symlink", () => {
    symlinkSync(join(outside, "nope"), join(root, "src", "dangling.ts"));
    expect(read("src/dangling.ts").statusCode).toBe(404);
  });

  it("still rejects traversal, absolute and NUL paths before touching disk", () => {
    expect(read("../outside/secret.txt", ["../outside/secret.txt"]).statusCode).toBe(400);
    expect(read(join(outside, "secret.txt")).statusCode).toBe(400);
    expect(read("src/a\0.ts").statusCode).toBe(400);
    expect(read("").statusCode).toBe(400);
  });

  it("refuses a symlinked data file and a symlinked data dir", () => {
    writeFileSync(join(outside, "graph.json"), JSON.stringify({ nodes: [] }));
    symlinkSync(join(outside, "graph.json"), join(root, ".ua", "knowledge-graph.json"));
    expect(() => guards.readDataFile(join(root, ".ua"), "knowledge-graph.json"))
      .toThrow(guards.UnsafeDataFileError);

    // A real file in a real dir is fine.
    writeFileSync(join(root, ".ua", "meta.json"), JSON.stringify({ ok: true }));
    expect(JSON.parse(guards.readDataFile(join(root, ".ua"), "meta.json"))).toEqual({ ok: true });

    // The data dir itself being a symlink is refused, even with a real file in it.
    const linkedRoot = join(base, "linked-project");
    mkdirSync(linkedRoot);
    mkdirSync(join(outside, "dataset"));
    writeFileSync(join(outside, "dataset", "meta.json"), "{}");
    symlinkSync(join(outside, "dataset"), join(linkedRoot, ".ua"));
    expect(() => guards.readDataFile(join(linkedRoot, ".ua"), "meta.json", linkedRoot))
      .toThrow(guards.UnsafeDataFileError);
    expect(() => guards.assertSafeDataDir(linkedRoot, join(linkedRoot, ".ua")))
      .toThrow(/symlink/);
  });

  it("readSanitizedJson relativises absolute node paths", () => {
    writeFileSync(
      join(root, ".ua", "knowledge-graph.json"),
      JSON.stringify({ nodes: [{ id: "x", filePath: join(root, "src", "a.ts") }] }),
    );
    const out = guards.readSanitizedJson(join(root, ".ua"), "knowledge-graph.json", root);
    expect(out.nodes[0].filePath).toBe("src/a.ts");
  });

  it("caches the graph allowlist until the graph file changes", () => {
    const dataDir = join(root, ".ua");
    const graphFile = join(dataDir, "knowledge-graph.json");
    const writeGraph = (paths) =>
      writeFileSync(graphFile, JSON.stringify({ nodes: paths.map((p, i) => ({ id: `n${i}`, filePath: p })) }));

    const cache = guards.createAllowlistCache();
    writeGraph(["src/a.ts"]);
    const first = cache.get(dataDir, root);
    expect([...first]).toEqual(["src/a.ts"]);
    // Unchanged file: the very same parsed Set comes back (no re-parse).
    expect(cache.get(dataDir, root)).toBe(first);

    writeGraph(["src/a.ts", "src/b.ts"]);
    // Force a distinct mtime even on coarse-grained filesystems.
    utimesSync(graphFile, new Date(), new Date(Date.now() + 5000));
    const second = cache.get(dataDir, root);
    expect(second).not.toBe(first);
    expect([...second].sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("gives an empty allowlist for a symlinked or missing graph", () => {
    const dataDir = join(root, ".ua");
    const cache = guards.createAllowlistCache();
    expect(cache.get(dataDir, root).size).toBe(0);
    writeFileSync(join(outside, "g.json"), JSON.stringify({ nodes: [{ filePath: "src/a.ts" }] }));
    symlinkSync(join(outside, "g.json"), join(dataDir, "knowledge-graph.json"));
    expect(cache.get(dataDir, root).size).toBe(0);
  });
});

describe("openInBrowser", () => {
  const URL_OK = "http://127.0.0.1:5173/?token=abc";

  function fakeSpawn() {
    const calls = [];
    const child = new EventEmitter();
    child.unref = () => {};
    const spawnFn = (command, args, options) => {
      calls.push({ command, args, options });
      return child;
    };
    return { spawnFn, calls, child };
  }

  it("does not crash when the opener binary is missing; it logs a hint", () => {
    const { spawnFn, child } = fakeSpawn();
    const logs = [];
    expect(guards.openInBrowser(URL_OK, { platform: "linux", spawnFn, log: (m) => logs.push(m) })).toBe(true);
    // Node emits 'error' (ENOENT) when xdg-open does not exist.
    expect(() => child.emit("error", Object.assign(new Error("spawn xdg-open ENOENT"), { code: "ENOENT" })))
      .not.toThrow();
    expect(logs.join("\n")).toContain("open the URL manually");
  });

  it("survives spawn throwing synchronously", () => {
    const logs = [];
    const spawnFn = () => { throw new Error("boom"); };
    expect(guards.openInBrowser(URL_OK, { platform: "linux", spawnFn, log: (m) => logs.push(m) })).toBe(false);
    expect(logs.join("\n")).toContain("open the URL manually");
  });

  it("never uses a shell and picks the right opener per platform", () => {
    for (const [platform, command] of [["darwin", "open"], ["linux", "xdg-open"], ["win32", "explorer.exe"]]) {
      const { spawnFn, calls } = fakeSpawn();
      guards.openInBrowser(URL_OK, { platform, spawnFn, log: () => {} });
      expect(calls).toHaveLength(1);
      expect(calls[0].command).toBe(command);
      expect(calls[0].args).toEqual([URL_OK]);
      expect(calls[0].options.shell).toBeUndefined();
    }
  });

  it("only ever opens the local dashboard URL", () => {
    for (const bad of [
      "https://evil.example/", "http://evil.example:5173/", "javascript:alert(1)",
      "file:///etc/passwd", "http://127.0.0.1.evil.example/", "not a url",
      "--help",
    ]) {
      const { spawnFn, calls } = fakeSpawn();
      expect(guards.openInBrowser(bad, { platform: "linux", spawnFn, log: () => {} })).toBe(false);
      expect(calls).toHaveLength(0);
    }
  });

  it("does not pass shell metacharacters through as separate arguments", () => {
    const { spawnFn, calls } = fakeSpawn();
    // Even a hostile query string stays one argument (and percent-encoded `"`).
    guards.openInBrowser('http://127.0.0.1:5173/?token=a"&calc&"b', { platform: "win32", spawnFn, log: () => {} });
    expect(calls[0].args).toHaveLength(1);
    expect(calls[0].args[0]).not.toContain('"');
    expect(calls[0].options.shell).toBeUndefined();
  });
});
