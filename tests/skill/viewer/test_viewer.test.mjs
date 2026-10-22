// End-to-end tests for the standalone viewer (packages/viewer/bin/viewer.mjs).
// Spawns the real server against a fixture project and exercises the token
// gate, graph sanitisation, file-content allowlist, and .ua/legacy resolution.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, symlinkSync, readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const VIEWER_BIN = join(
  REPO_ROOT,
  "understand-anything-plugin",
  "packages",
  "viewer",
  "bin",
  "viewer.mjs",
);
const VIEWER_DIST = join(REPO_ROOT, "understand-anything-plugin", "packages", "viewer", "dist");

const EXPECTED_CSP =
  "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; " +
  "script-src 'self'; connect-src 'self'; font-src 'self' data:; worker-src 'self' blob:; " +
  "frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

function fixtureGraph(gitCommitHash) {
  return {
    version: "1.0.0",
    project: {
      name: "fixture", languages: ["ts"], frameworks: [], description: "d",
      analyzedAt: "2026-07-17T00:00:00.000Z", gitCommitHash,
    },
    nodes: [
      {
        id: "file:src/a.ts", type: "file", name: "a.ts", filePath: "src/a.ts",
        summary: "s", tags: [], complexity: "simple",
      },
    ],
    edges: [],
    layers: [],
    tour: [],
  };
}

function git(projectRoot, ...args) {
  return execFileSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
  }).trim();
}

function setupProject(dataDirName) {
  const root = mkdtempSync(join(tmpdir(), "ua-viewer-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "secret.txt"), "not in graph\n");
  git(root, "init");
  git(root, "config", "user.email", "viewer-tests@example.com");
  git(root, "config", "user.name", "Viewer Tests");
  git(root, "add", "--all");
  git(root, "commit", "-m", "baseline");

  const dataDir = join(root, dataDirName);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, "knowledge-graph.json"),
    JSON.stringify(fixtureGraph(git(root, "rev-parse", "HEAD"))),
  );
  return root;
}

/**
 * Start the viewer and wait for the printed URL. Returns
 * { proc, url, token, port, output() }.
 * Options: `open` lets the viewer try to open a browser (default: --no-open),
 * `env` replaces the child's environment.
 */
function startViewer(projectRoot, { open = false, env = { ...process.env } } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn(
      process.execPath,
      [VIEWER_BIN, projectRoot, ...(open ? [] : ["--no-open"]), "--port", "0"],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    const timer = setTimeout(() => {
      proc.kill();
      rejectPromise(new Error(`viewer did not start.\n${out}`));
    }, 10_000);
    const onData = (chunk) => {
      out += String(chunk);
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=([a-f0-9]+)/);
      if (m && !proc.__resolved) {
        proc.__resolved = true;
        clearTimeout(timer);
        resolvePromise({ proc, url: m[0], port: Number(m[1]), token: m[2], output: () => out });
      }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("exit", (code) => {
      clearTimeout(timer);
      rejectPromise(new Error(`viewer exited with ${code}.\n${out}`));
    });
  });
}

/** Run the viewer expecting it to refuse to start. Resolves { code, out }. */
function runViewerExpectExit(projectRoot) {
  return new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn(process.execPath, [VIEWER_BIN, projectRoot, "--no-open", "--port", "0"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const timer = setTimeout(() => {
      proc.kill();
      rejectPromise(new Error(`viewer kept running.\n${out}`));
    }, 10_000);
    proc.stdout.on("data", (c) => (out += String(c)));
    proc.stderr.on("data", (c) => (out += String(c)));
    proc.on("exit", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, out });
    });
  });
}

/** GET with an explicit Host header (fetch cannot spoof Host). */
function getWithHost(port, requestPath, hostHeader, method = "GET") {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path: requestPath, method, headers: { Host: hostHeader }, agent: false },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolvePromise({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.once("error", rejectPromise);
    req.end();
  });
}

describe.skipIf(!existsSync(VIEWER_DIST))("understand-anything-viewer", () => {
  let root;
  let viewer;

  beforeAll(async () => {
    root = setupProject(".ua");
    viewer = await startViewer(root);
  }, 15_000);

  afterAll(() => {
    viewer?.proc.kill();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const base = () => `http://127.0.0.1:${viewer.port}`;

  it("serves the embedded dashboard index", async () => {
    const res = await fetch(`${base()}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<!doctype html>");
  });

  it("rejects data requests without the token", async () => {
    const res = await fetch(`${base()}/knowledge-graph.json`);
    expect(res.status).toBe(403);
  });

  it("serves the graph from .ua/ with a valid token", async () => {
    const res = await fetch(`${base()}/knowledge-graph.json?token=${viewer.token}`);
    expect(res.status).toBe(200);
    const graph = await res.json();
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0].filePath).toBe("src/a.ts");
  });

  it("serves a protected no-store freshness report", async () => {
    const denied = await fetch(`${base()}/staleness.json`);
    expect(denied.status).toBe(403);
    expect(denied.headers.get("cache-control")).toBe("no-store");

    const res = await fetch(
      `${base()}/staleness.json?token=${viewer.token}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({
      graphs: {
        knowledge: {
          status: "fresh",
          graphCommitHash: git(root, "rev-parse", "HEAD"),
          headCommitHash: git(root, "rev-parse", "HEAD"),
        },
      },
    });
  });

  it("serves file content only for files listed in the graph", async () => {
    const ok = await fetch(
      `${base()}/file-content.json?token=${viewer.token}&path=${encodeURIComponent("src/a.ts")}`,
    );
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.content).toContain("export const a");
    expect(body.language).toBe("typescript");

    const denied = await fetch(
      `${base()}/file-content.json?token=${viewer.token}&path=secret.txt`,
    );
    expect(denied.status).toBe(404);
  });

  it("rejects path traversal in file-content", async () => {
    const res = await fetch(
      `${base()}/file-content.json?token=${viewer.token}&path=${encodeURIComponent("../outside.txt")}`,
    );
    expect(res.status).toBe(400);
  });

  it("blocks static requests escaping dist/", async () => {
    const res = await fetch(`${base()}/%2e%2e/package.json`);
    expect([403, 404]).toContain(res.status);
  });

  it("sends a strict CSP and hardening headers on the HTML page", async () => {
    const res = await fetch(`${base()}/`);
    expect(res.headers.get("content-security-policy")).toBe(EXPECTED_CSP);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  });

  it("sends the hardening headers (and no-store) on data responses too", async () => {
    for (const requestPath of ["/knowledge-graph.json?token=wrong", `/knowledge-graph.json?token=${viewer.token}`]) {
      const res = await fetch(`${base()}${requestPath}`);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("serves a dashboard build that makes no outside requests", () => {
    const html = readFileSync(join(VIEWER_DIST, "index.html"), "utf8");
    expect(html).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    expect(html).not.toMatch(/(src|href)="https?:\/\//);
    // The built page also carries the policy as a <meta>, for non-viewer hosts.
    expect(html).toMatch(/<meta http-equiv="Content-Security-Policy" content="default-src 'self'/);
  });

  it("rejects a foreign Host header (DNS rebinding) with 403", async () => {
    for (const host of [
      "evil.example", `evil.example:${viewer.port}`, `127.0.0.1.evil.example:${viewer.port}`,
      `127.0.0.1:${viewer.port + 1}`, "127.0.0.1",
    ]) {
      const res = await getWithHost(viewer.port, `/knowledge-graph.json?token=${viewer.token}`, host);
      expect(res.status, host).toBe(403);
      expect(res.body).not.toContain("fixture");
      const page = await getWithHost(viewer.port, "/", host);
      expect(page.status, host).toBe(403);
    }
  });

  it("accepts both loopback names on the bound port", async () => {
    for (const host of [`127.0.0.1:${viewer.port}`, `localhost:${viewer.port}`]) {
      const res = await getWithHost(viewer.port, `/knowledge-graph.json?token=${viewer.token}`, host);
      expect(res.status, host).toBe(200);
    }
  });

  it("rejects wrong tokens of any length", async () => {
    for (const token of ["", "x", viewer.token.slice(1), `${viewer.token}0`, viewer.token.toUpperCase()]) {
      const res = await fetch(`${base()}/knowledge-graph.json?token=${token}`);
      expect(res.status, token).toBe(403);
    }
  });

  it("only answers GET and HEAD", async () => {
    const res = await getWithHost(viewer.port, `/knowledge-graph.json?token=${viewer.token}`, `127.0.0.1:${viewer.port}`, "POST");
    expect(res.status).toBe(405);
  });

  it("falls back to legacy .understand-anything/ projects", async () => {
    const legacyRoot = setupProject(".understand-anything");
    const legacyViewer = await startViewer(legacyRoot);
    try {
      const res = await fetch(
        `http://127.0.0.1:${legacyViewer.port}/knowledge-graph.json?token=${legacyViewer.token}`,
      );
      expect(res.status).toBe(200);
      expect((await res.json()).nodes).toHaveLength(1);
    } finally {
      legacyViewer.proc.kill();
      rmSync(legacyRoot, { recursive: true, force: true });
    }
  }, 15_000);
});

describe.skipIf(!existsSync(VIEWER_DIST))("viewer vs. a hostile project (symlinks)", () => {
  let root;
  let outside;
  let viewer;
  const SECRET = "TOP-SECRET-OUTSIDE-THE-PROJECT";

  /** Graph that lists the given project-relative file paths. */
  function writeGraph(dataDir, paths) {
    const graph = fixtureGraph(git(root, "rev-parse", "HEAD"));
    graph.nodes = paths.map((p, i) => ({
      id: `file:${p}`, type: "file", name: `f${i}`, filePath: p,
      summary: "s", tags: [], complexity: "simple",
    }));
    writeFileSync(join(dataDir, "knowledge-graph.json"), JSON.stringify(graph));
  }

  beforeAll(async () => {
    root = setupProject(".ua");
    outside = mkdtempSync(join(tmpdir(), "ua-viewer-outside-"));
    writeFileSync(join(outside, "secret.txt"), SECRET);
    mkdirSync(join(outside, "dir"));
    writeFileSync(join(outside, "dir", "inner.txt"), SECRET);
    writeFileSync(join(outside, "meta.json"), JSON.stringify({ leaked: SECRET }));

    symlinkSync(join(outside, "secret.txt"), join(root, "src", "leak.ts"));
    symlinkSync(join(outside, "dir"), join(root, "src", "linked"));
    symlinkSync("../../outside-relative-does-not-exist", join(root, "src", "dangling.ts"));
    symlinkSync("a.ts", join(root, "src", "alias.ts"));
    symlinkSync(join(outside, "meta.json"), join(root, ".ua", "meta.json"));
    writeGraph(join(root, ".ua"), [
      "src/a.ts", "src/leak.ts", "src/linked/inner.txt", "src/dangling.ts", "src/alias.ts",
    ]);
    viewer = await startViewer(root);
  }, 15_000);

  afterAll(() => {
    viewer?.proc.kill();
    if (root) rmSync(root, { recursive: true, force: true });
    if (outside) rmSync(outside, { recursive: true, force: true });
  });

  const fileContent = (p) =>
    fetch(`http://127.0.0.1:${viewer.port}/file-content.json?token=${viewer.token}&path=${encodeURIComponent(p)}`);

  it("refuses a file symlink that points outside the project", async () => {
    const res = await fileContent("src/leak.ts");
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain(SECRET);
  });

  it("refuses a path through a symlinked directory that leaves the project", async () => {
    const res = await fileContent("src/linked/inner.txt");
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain(SECRET);
  });

  it("returns 404 for a dangling symlink", async () => {
    expect((await fileContent("src/dangling.ts")).status).toBe(404);
  });

  it("still serves a symlink that stays inside the project", async () => {
    const res = await fileContent("src/alias.ts");
    expect(res.status).toBe(200);
    expect((await res.json()).content).toContain("export const a");
  });

  it("refuses a symlinked data file instead of serving it", async () => {
    const res = await fetch(`http://127.0.0.1:${viewer.port}/meta.json?token=${viewer.token}`);
    expect(res.status).toBe(409);
    const body = await res.text();
    expect(body).toContain("symlink");
    expect(body).not.toContain(SECRET);
  });

  it("picks up graph changes (cached allowlist is refreshed)", async () => {
    expect((await fileContent("secret.txt")).status).toBe(404);
    writeGraph(join(root, ".ua"), ["src/a.ts", "secret.txt"]);
    const res = await fileContent("secret.txt");
    expect(res.status).toBe(200);
    expect((await res.json()).content).toContain("not in graph");
  });
});

describe.skipIf(!existsSync(VIEWER_DIST))("viewer startup safety", () => {
  const cleanup = [];
  afterAll(() => cleanup.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it("refuses to start when knowledge-graph.json is a symlink", async () => {
    const root = setupProject(".ua");
    const outside = mkdtempSync(join(tmpdir(), "ua-viewer-outside-"));
    cleanup.push(root, outside);
    writeFileSync(join(outside, "g.json"), JSON.stringify(fixtureGraph("x")));
    rmSync(join(root, ".ua", "knowledge-graph.json"));
    symlinkSync(join(outside, "g.json"), join(root, ".ua", "knowledge-graph.json"));

    const { code, out } = await runViewerExpectExit(root);
    expect(code).not.toBe(0);
    expect(out).toMatch(/refusing to serve/i);
    expect(out).toMatch(/symlink/i);
  });

  it("refuses to start when the data directory is a symlink", async () => {
    const root = mkdtempSync(join(tmpdir(), "ua-viewer-"));
    const outside = mkdtempSync(join(tmpdir(), "ua-viewer-outside-"));
    cleanup.push(root, outside);
    writeFileSync(join(outside, "knowledge-graph.json"), JSON.stringify(fixtureGraph("x")));
    symlinkSync(outside, join(root, ".ua"));

    const { code, out } = await runViewerExpectExit(root);
    expect(code).not.toBe(0);
    expect(out).toMatch(/refusing to serve/i);
    expect(out).toMatch(/symlink/i);
  });

  // No browser opener on PATH (headless Linux / WSL / Docker): the server used
  // to crash on the unhandled spawn 'error'. It must keep serving instead.
  it.skipIf(process.platform === "win32")(
    "keeps running and says to open the URL manually when no browser opener exists",
    async () => {
      const root = setupProject(".ua");
      const emptyBin = mkdtempSync(join(tmpdir(), "ua-viewer-emptybin-"));
      cleanup.push(root, emptyBin);
      const v = await startViewer(root, { open: true, env: { ...process.env, PATH: emptyBin } });
      try {
        await new Promise((r) => setTimeout(r, 800));
        expect(v.proc.exitCode).toBeNull();
        expect(v.output()).toContain("open the URL manually");
        const res = await fetch(`http://127.0.0.1:${v.port}/knowledge-graph.json?token=${v.token}`);
        expect(res.status).toBe(200);
      } finally {
        v.proc.kill();
      }
    },
    15_000,
  );

  it("ignores a weak UNDERSTAND_ACCESS_TOKEN and uses a random one", async () => {
    const root = setupProject(".ua");
    cleanup.push(root);
    const v = await startViewer(root, { env: { ...process.env, UNDERSTAND_ACCESS_TOKEN: "weak" } });
    try {
      expect(v.token).toMatch(/^[a-f0-9]{32}$/);
      const res = await fetch(`http://127.0.0.1:${v.port}/knowledge-graph.json?token=weak`);
      expect(res.status).toBe(403);
    } finally {
      v.proc.kill();
    }
  });
});
