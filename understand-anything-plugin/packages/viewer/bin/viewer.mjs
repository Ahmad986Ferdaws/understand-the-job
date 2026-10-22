#!/usr/bin/env node
/**
 * understand-anything-viewer — serve a generated knowledge graph in the
 * dashboard UI with nothing but Node.js. Read-only, no Claude Code, no LLM.
 *
 * Usage:
 *     understand-anything-viewer [project-dir] [--port <n>] [--no-open]
 *
 * The project directory (default: cwd) must contain a data directory —
 * `.ua/` or legacy `.understand-anything/` — with a knowledge-graph.json
 * produced by /understand.
 *
 * Security model (the guards live in ./server-guards.mjs, shared with the
 * dashboard dev server in vite.config.ts):
 *   - binds to 127.0.0.1 only; requests whose Host header is not
 *     127.0.0.1:<port> / localhost:<port> are refused (DNS rebinding)
 *   - every data endpoint requires the one-time ?token= printed at startup,
 *     compared in constant time
 *   - graph JSON is served with node filePaths relativised to the project;
 *     data files are never read through a symlink
 *   - /file-content.json only serves files listed in the graph whose real
 *     path stays inside the project, capped at 1 MB, never binary
 *   - HTML carries a strict Content-Security-Policy (no remote hosts)
 */
import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getGraphFreshnessBatch } from "./dist/staleness.js";
import {
  UA_DIR_CANDIDATES,
  UnsafeDataFileError,
  applySecurityHeaders,
  assertSafeDataDir,
  createAllowlistCache,
  isAllowedHost,
  lexists,
  openInBrowser,
  readDataFile,
  readSanitizedJson,
  readSourceFile,
  resolveAccessToken,
  tokensMatch,
} from "./server-guards.mjs";

const DIST_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");

// ── CLI args ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let projectRoot = process.cwd();
let port = 5173;
let portExplicit = false;
let openBrowser = true;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--port") {
    port = Number(args[++i]);
    portExplicit = true;
    // 0 asks the OS for any free port.
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      console.error("Error: --port must be an integer between 0 and 65535");
      process.exit(1);
    }
  } else if (a === "--no-open") {
    openBrowser = false;
  } else if (a === "--help" || a === "-h") {
    console.log("Usage: understand-anything-viewer [project-dir] [--port <n>] [--no-open]");
    process.exit(0);
  } else if (!a.startsWith("-")) {
    projectRoot = path.resolve(a);
  } else {
    console.error(`Error: unknown option ${a}`);
    process.exit(1);
  }
}

if (!fs.existsSync(DIST_DIR)) {
  console.error(
    "Error: embedded dashboard build not found. This tarball was packed " +
    "without running the build — run `pnpm --filter understand-anything-viewer build` first.",
  );
  process.exit(1);
}

const graphDir = UA_DIR_CANDIDATES
  .map((d) => path.join(projectRoot, d))
  .find((d) => lexists(path.join(d, "knowledge-graph.json")));

if (!graphDir) {
  console.error(
    `Error: no knowledge graph found under ${projectRoot}\n` +
    "Expected .ua/knowledge-graph.json (or legacy .understand-anything/). " +
    "Generate one with /understand first, or pass the project directory as an argument.",
  );
  process.exit(1);
}

// The analyzed project may be hostile: refuse a data dir or graph file that
// is a symlink, or that resolves outside the project.
try {
  assertSafeDataDir(projectRoot, graphDir);
  if (fs.lstatSync(path.join(graphDir, "knowledge-graph.json")).isSymbolicLink()) {
    throw new UnsafeDataFileError("knowledge-graph.json is a symlink");
  }
} catch (err) {
  console.error(
    `Error: refusing to serve ${graphDir} — ${err instanceof Error ? err.message : String(err)}.`,
  );
  process.exit(1);
}

const ACCESS_TOKEN = resolveAccessToken();
const allowlist = createAllowlistCache();

// ── Helpers ───────────────────────────────────────────────────────────────

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

/** Map a data-file read failure to an HTTP response. */
function sendReadFailure(res, err, fallbackMessage) {
  if (err instanceof UnsafeDataFileError) {
    sendJson(res, 409, { error: `Refusing to read data file: ${err.message}` });
  } else {
    sendJson(res, 500, { error: fallbackMessage });
  }
}

function serveGraphJson(res, fileName) {
  if (!lexists(path.join(graphDir, fileName))) {
    if (fileName === "knowledge-graph.json") {
      sendJson(res, 404, { error: "No knowledge graph found. Run /understand first." });
    } else {
      res.statusCode = 404;
      res.end();
    }
    return;
  }
  try {
    // Sanitises absolute node filePaths so the developer's directory
    // layout is never sent to the browser.
    sendJson(res, 200, readSanitizedJson(graphDir, fileName, projectRoot));
  } catch (err) {
    sendReadFailure(res, err, "Failed to read graph file");
  }
}

function readGraphMetadata(fileName) {
  const graph = JSON.parse(readDataFile(graphDir, fileName, projectRoot));
  return {
    graphCommitHash:
      typeof graph.project?.gitCommitHash === "string"
        ? graph.project.gitCommitHash
        : undefined,
    lastAnalyzedAt:
      typeof graph.project?.analyzedAt === "string"
        ? graph.project.analyzedAt
        : undefined,
  };
}

async function readGraphFreshness() {
  if (!lexists(path.join(graphDir, "knowledge-graph.json"))) {
    return {
      statusCode: 404,
      payload: { error: "No knowledge graph found. Run /understand first." },
    };
  }

  let inputs;
  try {
    inputs = {
      knowledge: readGraphMetadata("knowledge-graph.json"),
      ...(lexists(path.join(graphDir, "domain-graph.json"))
        ? { domain: readGraphMetadata("domain-graph.json") }
        : {}),
    };
  } catch (err) {
    return err instanceof UnsafeDataFileError
      ? { statusCode: 409, payload: { error: `Refusing to read data file: ${err.message}` } }
      : { statusCode: 500, payload: { error: "Failed to read graph file" } };
  }

  return {
    statusCode: 200,
    payload: {
      graphs: await getGraphFreshnessBatch(projectRoot, inputs),
    },
  };
}

const CONTENT_TYPES = {
  ".css": "text/css", ".html": "text/html; charset=utf-8", ".ico": "image/x-icon",
  ".js": "text/javascript", ".json": "application/json", ".map": "application/json",
  ".png": "image/png", ".svg": "image/svg+xml", ".txt": "text/plain",
  ".wasm": "application/wasm", ".woff": "font/woff", ".woff2": "font/woff2",
};

function serveStatic(res, pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const absolute = path.resolve(DIST_DIR, relative);
  if (absolute !== DIST_DIR && !absolute.startsWith(DIST_DIR + path.sep)) {
    res.statusCode = 403;
    res.end("Forbidden");
    return;
  }
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    res.statusCode = 404;
    res.end("Not found");
    return;
  }
  const contentType = CONTENT_TYPES[path.extname(absolute).toLowerCase()] ?? "application/octet-stream";
  res.setHeader("Content-Type", contentType);
  if (contentType.startsWith("text/html")) applySecurityHeaders(res, { html: true });
  res.end(fs.readFileSync(absolute));
}

// ── Server ────────────────────────────────────────────────────────────────

const PROTECTED = new Set([
  "/knowledge-graph.json",
  "/domain-graph.json",
  "/diff-overlay.json",
  "/meta.json",
  "/config.json",
  "/file-content.json",
  "/staleness.json",
]);

// Set once the socket is bound; requests only arrive after that.
let boundPort = port;

const server = createServer((req, res) => {
  applySecurityHeaders(res);

  // DNS-rebinding guard: only answer to our own loopback names.
  if (!isAllowedHost(req.headers.host, boundPort)) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "text/plain");
    res.end("Forbidden: unexpected Host header");
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, HEAD");
    res.end("Method not allowed");
    return;
  }

  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const pathname = url.pathname;

  if (pathname === "/staleness.json") {
    res.setHeader("Cache-Control", "no-store");
  }

  if (!PROTECTED.has(pathname)) {
    serveStatic(res, pathname);
    return;
  }

  if (!tokensMatch(url.searchParams.get("token"), ACCESS_TOKEN)) {
    sendJson(res, 403, { error: "Forbidden: missing or invalid token" });
    return;
  }

  if (pathname === "/file-content.json") {
    const result = readSourceFile({
      projectRoot,
      requestedPath: url.searchParams.get("path") ?? "",
      // Parsed once per graph-file version, not once per request.
      allowedPaths: () => allowlist.get(graphDir, projectRoot),
    });
    sendJson(res, result.statusCode, result.payload);
    return;
  }

  if (pathname === "/staleness.json") {
    void readGraphFreshness()
      .then((result) => sendJson(res, result.statusCode, result.payload))
      .catch(() => {
        sendJson(res, 500, { error: "Failed to read graph freshness" });
      });
    return;
  }

  if (pathname === "/config.json") {
    if (lexists(path.join(graphDir, "config.json"))) {
      try {
        sendJson(res, 200, JSON.parse(readDataFile(graphDir, "config.json", projectRoot)));
      } catch (err) {
        sendReadFailure(res, err, "Failed to read config file");
      }
      return;
    }
    sendJson(res, 200, { autoUpdate: false, outputLanguage: "en" });
    return;
  }

  serveGraphJson(res, pathname.slice(1));
});

function listen(attemptPort, attemptsLeft) {
  server.once("error", (err) => {
    if (err.code === "EADDRINUSE" && !portExplicit && attemptsLeft > 0) {
      listen(attemptPort + 1, attemptsLeft - 1);
    } else {
      console.error(`Error: could not bind 127.0.0.1:${attemptPort} — ${err.message}`);
      process.exit(1);
    }
  });
  server.listen(attemptPort, "127.0.0.1", () => {
    const address = server.address();
    boundPort = typeof address === "object" && address ? address.port : attemptPort;
    const dashboardUrl = `http://127.0.0.1:${boundPort}/?token=${encodeURIComponent(ACCESS_TOKEN)}`;
    console.log(`\n  Serving graph from ${graphDir}`);
    console.log(`  🔑  Dashboard URL: ${dashboardUrl}\n`);
    if (openBrowser) openInBrowser(dashboardUrl);
  });
}

listen(port, 10);
