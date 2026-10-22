import fs from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDashboardDataMiddleware,
  createGraphDataMiddleware,
  createSecurityMiddleware,
} from "../../vite.config";

// Same chain the dev server registers in configureServer().
const TOKEN = "test-token-0123456789";
const SECRET = "TOP-SECRET-OUTSIDE-THE-PROJECT";

interface Result {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json: () => unknown;
}

let originalGraphDir: string | undefined;
let base: string;
let project: string;
let outside: string;
let restoreCwd: (() => void) | undefined;
const servers: Server[] = [];

function writeGraph(paths: string[], dataDir = ".ua"): void {
  const dir = path.join(project, dataDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "knowledge-graph.json"),
    JSON.stringify({
      project: { gitCommitHash: "abc", analyzedAt: "2026-07-10T00:00:00.000Z" },
      nodes: paths.map((p, i) => ({
        id: `file:${i}`,
        type: "file",
        name: `f${i}`,
        filePath: p,
        summary: "",
        tags: [],
        complexity: "simple",
      })),
      edges: [],
    }),
  );
}

async function start(): Promise<number> {
  const chain = [
    createSecurityMiddleware(),
    createDashboardDataMiddleware(TOKEN),
    createGraphDataMiddleware(TOKEN),
  ];
  const server = createServer((req, res) => {
    const run = (i: number): void => {
      if (i === chain.length) {
        res.statusCode = 404;
        res.end("not handled");
        return;
      }
      chain[i](req, res, () => run(i + 1));
    };
    run(0);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

function get(port: number, requestPath: string, host?: string): Promise<Result> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: requestPath,
        agent: false,
        headers: host ? { Host: host } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text,
            json: () => JSON.parse(text),
          });
        });
      },
    );
    req.once("error", reject);
    req.end();
  });
}

const fileContent = (port: number, p: string) =>
  get(port, `/file-content.json?token=${TOKEN}&path=${encodeURIComponent(p)}`);

beforeEach(() => {
  originalGraphDir = process.env.GRAPH_DIR;
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ua-guards-")));
  project = path.join(base, "project");
  outside = path.join(base, "outside");
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.mkdirSync(path.join(outside, "dir"), { recursive: true });
  fs.writeFileSync(path.join(project, "src", "a.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(project, "secret-not-listed.txt"), "not listed\n");
  fs.writeFileSync(path.join(outside, "secret.txt"), SECRET);
  fs.writeFileSync(path.join(outside, "dir", "inner.txt"), SECRET);

  process.env.GRAPH_DIR = project;
  // Keep the cwd fallback roots inside the fixture too.
  const cwd = path.join(project, "runtime", "a", "b");
  fs.mkdirSync(cwd, { recursive: true });
  const spy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
  restoreCwd = () => spy.mockRestore();
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  restoreCwd?.();
  if (originalGraphDir === undefined) delete process.env.GRAPH_DIR;
  else process.env.GRAPH_DIR = originalGraphDir;
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("dev server security middleware", () => {
  it("sets hardening headers and a dev CSP with no remote hosts", async () => {
    writeGraph(["src/a.ts"]);
    const port = await start();
    const res = await get(port, "/");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["cross-origin-resource-policy"]).toBe("same-origin");
    const csp = String(res.headers["content-security-policy"]);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("img-src 'self' data: blob:");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).not.toMatch(/https?:/);
  });

  it("rejects a foreign Host header and accepts both loopback names", async () => {
    writeGraph(["src/a.ts"]);
    const port = await start();
    for (const host of ["evil.example", `evil.example:${port}`, `127.0.0.1.evil.example:${port}`]) {
      const res = await get(port, `/knowledge-graph.json?token=${TOKEN}`, host);
      expect(res.status, host).toBe(403);
    }
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
      const res = await get(port, `/knowledge-graph.json?token=${TOKEN}`, host);
      expect(res.status, host).toBe(200);
    }
  });
});

describe("dev server data endpoints", () => {
  it("requires the exact token", async () => {
    writeGraph(["src/a.ts"]);
    const port = await start();
    for (const token of ["", "x", TOKEN.slice(1), `${TOKEN}0`]) {
      const res = await get(port, `/knowledge-graph.json?token=${token}`);
      expect(res.status, token).toBe(403);
    }
    expect((await get(port, "/knowledge-graph.json")).status).toBe(403);
    expect((await get(port, `/knowledge-graph.json?token=${TOKEN}`)).status).toBe(200);
  });

  it("serves only listed files and relativises absolute node paths", async () => {
    writeGraph([path.join(project, "src", "a.ts")]);
    const port = await start();
    const graph = (await get(port, `/knowledge-graph.json?token=${TOKEN}`)).json() as {
      nodes: Array<{ filePath: string }>;
    };
    expect(graph.nodes[0].filePath).toBe(path.join("src", "a.ts"));

    const ok = await fileContent(port, "src/a.ts");
    expect(ok.status).toBe(200);
    expect((ok.json() as { content: string }).content).toContain("export const a");
    expect((await fileContent(port, "secret-not-listed.txt")).status).toBe(404);
    expect((await fileContent(port, "../outside/secret.txt")).status).toBe(400);
  });

  it("refuses source symlinks that leave the project", async () => {
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(project, "src", "leak.ts"));
    fs.symlinkSync(path.join(outside, "dir"), path.join(project, "src", "linked"));
    fs.symlinkSync("a.ts", path.join(project, "src", "alias.ts"));
    writeGraph(["src/a.ts", "src/leak.ts", "src/linked/inner.txt", "src/alias.ts"]);
    const port = await start();

    for (const p of ["src/leak.ts", "src/linked/inner.txt"]) {
      const res = await fileContent(port, p);
      expect(res.status, p).toBe(403);
      expect(res.text).not.toContain(SECRET);
    }
    // A symlink that stays inside the project is fine.
    expect((await fileContent(port, "src/alias.ts")).status).toBe(200);
  });

  it("refuses a symlinked graph or meta file", async () => {
    writeGraph(["src/a.ts"]);
    const dir = path.join(project, ".ua");
    fs.writeFileSync(path.join(outside, "meta.json"), JSON.stringify({ leaked: SECRET }));
    fs.symlinkSync(path.join(outside, "meta.json"), path.join(dir, "meta.json"));
    const port = await start();

    const meta = await get(port, `/meta.json?token=${TOKEN}`);
    expect(meta.status).toBe(409);
    expect(meta.text).not.toContain(SECRET);

    // Replace the graph with a symlink to an outside file.
    fs.rmSync(path.join(dir, "knowledge-graph.json"));
    fs.writeFileSync(path.join(outside, "graph.json"), JSON.stringify({ nodes: [], leaked: SECRET }));
    fs.symlinkSync(path.join(outside, "graph.json"), path.join(dir, "knowledge-graph.json"));
    const graph = await get(port, `/knowledge-graph.json?token=${TOKEN}`);
    expect(graph.status).toBe(409);
    expect(graph.text).not.toContain(SECRET);
    // The freshness endpoint refuses it too, and a refused file lists nothing.
    expect((await get(port, `/staleness.json?token=${TOKEN}`)).status).toBe(409);
    expect((await fileContent(port, "src/a.ts")).status).toBe(404);
  });

  it("refuses a data directory that is a symlink", async () => {
    fs.mkdirSync(path.join(outside, "data"));
    fs.writeFileSync(
      path.join(outside, "data", "knowledge-graph.json"),
      JSON.stringify({ nodes: [{ id: "x", filePath: "src/a.ts" }], leaked: SECRET }),
    );
    fs.symlinkSync(path.join(outside, "data"), path.join(project, ".ua"));
    const port = await start();

    const graph = await get(port, `/knowledge-graph.json?token=${TOKEN}`);
    expect(graph.status).toBe(409);
    expect(graph.text).not.toContain(SECRET);
    expect((await fileContent(port, "src/a.ts")).status).toBe(404);
  });

  it("serves config.json and refuses it when symlinked", async () => {
    writeGraph(["src/a.ts"]);
    const port = await start();
    expect((await get(port, `/config.json?token=${TOKEN}`)).json()).toMatchObject({ outputLanguage: "en" });

    fs.writeFileSync(path.join(outside, "config.json"), JSON.stringify({ outputLanguage: "xx" }));
    fs.symlinkSync(path.join(outside, "config.json"), path.join(project, ".ua", "config.json"));
    expect((await get(port, `/config.json?token=${TOKEN}`)).status).toBe(409);
  });

  it("picks up a changed graph (cached allowlist is refreshed)", async () => {
    writeGraph(["src/a.ts"]);
    const port = await start();
    expect((await fileContent(port, "secret-not-listed.txt")).status).toBe(404);
    writeGraph(["src/a.ts", "secret-not-listed.txt"]);
    expect((await fileContent(port, "secret-not-listed.txt")).status).toBe(200);
  });
});
