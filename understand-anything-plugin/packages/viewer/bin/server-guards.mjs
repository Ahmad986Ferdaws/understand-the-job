/**
 * Shared server-side guards for the two servers that serve the dashboard:
 * the zero-dependency viewer (viewer.mjs) and the Vite dev-server middleware
 * (packages/dashboard/vite.config.ts). Keeping this logic in one dependency-free
 * module stops the two servers drifting apart.
 *
 * Threat model: the analyzed project may be hostile, and graph text is written
 * by an LLM from that project's content. So
 *   - source files are only read when the graph lists them AND their real
 *     (symlink-resolved) path stays inside the project,
 *   - data files in the data dir (.ua / .understand-anything) are never read
 *     through a symlink,
 *   - the page may not talk to any other host (Content-Security-Policy),
 *   - requests with a foreign Host header (DNS rebinding) are refused.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export const MAX_SOURCE_FILE_BYTES = 1024 * 1024;
// A generous cap so a planted multi-GB "graph" cannot exhaust memory.
export const MAX_DATA_FILE_BYTES = 256 * 1024 * 1024;
// Legacy directory first — projects analyzed before the `.ua` rename keep
// their existing `.understand-anything/` data.
export const UA_DIR_CANDIDATES = [".understand-anything", ".ua"];

// ── Response headers ───────────────────────────────────────────────────────

const CSP_BASE = {
  "default-src": ["'self'"],
  "img-src": ["'self'", "data:", "blob:"],
  "style-src": ["'self'", "'unsafe-inline'"],
  "script-src": ["'self'"],
  "connect-src": ["'self'"],
  "font-src": ["'self'", "data:"],
  "worker-src": ["'self'", "blob:"],
  "frame-ancestors": ["'none'"],
  "base-uri": ["'none'"],
  "form-action": ["'none'"],
};

/**
 * Build the Content-Security-Policy string.
 *  - `dev`: relaxations the Vite dev server needs (inline React-refresh
 *    preamble, HMR websocket). Never used for the built/served dashboard.
 *  - `meta`: variant for a <meta http-equiv> tag, which browsers ignore
 *    `frame-ancestors` in (and warn about), so it is left out.
 */
export function buildCsp({ dev = false, meta = false } = {}) {
  const directives = Object.fromEntries(
    Object.entries(CSP_BASE).map(([name, sources]) => [name, [...sources]]),
  );
  if (dev) {
    directives["script-src"].push("'unsafe-inline'");
    directives["connect-src"].push("ws://127.0.0.1:*", "ws://localhost:*");
  }
  if (meta) delete directives["frame-ancestors"];
  return Object.entries(directives)
    .map(([name, sources]) => `${name} ${sources.join(" ")}`)
    .join("; ");
}

/** Headers sent on every response. */
export const BASE_SECURITY_HEADERS = Object.freeze({
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
});

/**
 * Set the security headers on a response. Pass `html: true` for HTML
 * documents, which additionally get the Content-Security-Policy.
 */
export function applySecurityHeaders(res, { html = false, dev = false } = {}) {
  for (const [name, value] of Object.entries(BASE_SECURITY_HEADERS)) {
    res.setHeader(name, value);
  }
  if (html) res.setHeader("Content-Security-Policy", buildCsp({ dev }));
}

// ── Host header (DNS rebinding) ────────────────────────────────────────────

/**
 * True only for `127.0.0.1[:port]` / `localhost[:port]`. When `port` is given
 * the Host header must name exactly that port; without it any port is
 * accepted (the Vite dev server can move to another port at runtime, and a
 * rebinding attack is about the hostname anyway).
 */
export function isAllowedHost(hostHeader, port) {
  if (typeof hostHeader !== "string" || hostHeader.length === 0 || hostHeader.length > 255) {
    return false;
  }
  const match = /^(?:127\.0\.0\.1|localhost)(?::(\d{1,5}))?$/i.exec(hostHeader);
  if (!match) return false;
  if (port === undefined) return true;
  return Number(match[1] ?? 80) === port;
}

// ── Access token ───────────────────────────────────────────────────────────

/** Constant-time token comparison; tolerant of missing/non-string input. */
export function tokensMatch(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  // Hash both sides so the buffers have equal length whatever the input.
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

const ENV_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * The access token for this server process: UNDERSTAND_ACCESS_TOKEN when it
 * is a sane URL-safe string of 16-128 chars, otherwise a fresh random token.
 */
export function resolveAccessToken(env = process.env) {
  const fromEnv = env.UNDERSTAND_ACCESS_TOKEN;
  if (typeof fromEnv === "string" && ENV_TOKEN_PATTERN.test(fromEnv)) return fromEnv;
  if (fromEnv) {
    console.warn(
      "Warning: ignoring UNDERSTAND_ACCESS_TOKEN (must be 16-128 chars of A-Z a-z 0-9 _ -); using a random token.",
    );
  }
  return crypto.randomBytes(16).toString("hex");
}

// ── Path helpers ───────────────────────────────────────────────────────────

/** True when `candidate` is `root` itself or lies below it (lexical check). */
export function isInside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Turn a graph node's filePath into a project-relative POSIX path, or null
 * when it is empty, escapes the project, or contains a NUL.
 */
export function normalizeGraphPath(filePath, projectRoot) {
  let rawPath = filePath;
  if (path.isAbsolute(filePath)) {
    const rel = path.relative(projectRoot, filePath);
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
    rawPath = rel;
  }
  const normalized = path.normalize(rawPath);
  if (
    !normalized ||
    normalized === "." ||
    normalized.includes("\0") ||
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`) ||
    path.isAbsolute(normalized)
  ) {
    return null;
  }
  return normalized.split(path.sep).join("/");
}

/**
 * Rewrite absolute node filePaths so the developer's directory layout is
 * never sent to the browser. Paths inside the project become relative; other
 * absolute paths are reduced to their file name. Mutates and returns `raw`.
 */
export function relativizeNodePaths(raw, projectRoot) {
  if (!Array.isArray(raw?.nodes)) return raw;
  raw.nodes = raw.nodes.map((node) => {
    if (typeof node?.filePath !== "string" || !path.isAbsolute(node.filePath)) return node;
    const rel = path.relative(projectRoot, node.filePath);
    const inside = rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
    return { ...node, filePath: inside ? rel : path.basename(node.filePath) };
  });
  return raw;
}

const LANGUAGE_BY_EXT = {
  bash: "bash", c: "c", cc: "cpp", cpp: "cpp", cs: "csharp", css: "css",
  go: "go", h: "c", hpp: "cpp", html: "markup", java: "java",
  js: "javascript", jsx: "jsx", json: "json", md: "markdown",
  mjs: "javascript", py: "python", rb: "ruby", rs: "rust", sh: "bash",
  ts: "typescript", tsx: "tsx", txt: "text", yaml: "yaml", yml: "yaml",
};

export function detectLanguage(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return LANGUAGE_BY_EXT[ext] ?? "text";
}

// ── Data directory (.ua / .understand-anything) ────────────────────────────

export class UnsafeDataFileError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnsafeDataFileError";
  }
}

// O_NOFOLLOW is undefined on Windows; 0 is then a no-op in the flags.
const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

/** True when something (even a dangling symlink) exists at `target`. */
export function lexists(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Throw UnsafeDataFileError unless `dataDir` is a real directory (not a
 * symlink) whose real path is inside the real path of `projectRoot`.
 */
export function assertSafeDataDir(projectRoot, dataDir) {
  let stat;
  try {
    stat = fs.lstatSync(dataDir);
  } catch (err) {
    if (err?.code === "ENOENT") throw err;
    throw new UnsafeDataFileError("data directory cannot be inspected");
  }
  if (stat.isSymbolicLink()) throw new UnsafeDataFileError("data directory is a symlink");
  if (!stat.isDirectory()) throw new UnsafeDataFileError("data directory is not a directory");
  let rootReal;
  let dirReal;
  try {
    rootReal = fs.realpathSync(projectRoot);
    dirReal = fs.realpathSync(dataDir);
  } catch {
    throw new UnsafeDataFileError("data directory cannot be resolved");
  }
  if (!isInside(rootReal, dirReal)) {
    throw new UnsafeDataFileError("data directory is outside the project");
  }
}

/**
 * Read a file from the data dir as UTF-8 text, refusing symlinks (the data
 * dir itself, and the file inside it). Throws ENOENT if missing and
 * UnsafeDataFileError for anything unsafe.
 */
export function readDataFile(dataDir, fileName, projectRoot = path.dirname(dataDir)) {
  assertSafeDataDir(projectRoot, dataDir);
  const file = path.join(dataDir, fileName);
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) throw new UnsafeDataFileError(`${fileName} is a symlink`);
  if (!stat.isFile()) throw new UnsafeDataFileError(`${fileName} is not a regular file`);
  if (stat.size > MAX_DATA_FILE_BYTES) throw new UnsafeDataFileError(`${fileName} is too large`);
  // O_NOFOLLOW closes the window between the lstat above and the open.
  const fd = fs.openSync(file, fs.constants.O_RDONLY | O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) throw new UnsafeDataFileError(`${fileName} is not a regular file`);
    return fs.readFileSync(fd, "utf-8");
  } finally {
    fs.closeSync(fd);
  }
}

/** Read + parse + path-sanitise one graph/meta/config JSON file. */
export function readSanitizedJson(dataDir, fileName, projectRoot = path.dirname(dataDir)) {
  const parsed = JSON.parse(readDataFile(dataDir, fileName, projectRoot));
  return relativizeNodePaths(parsed, projectRoot);
}

// ── File allowlist (cached by graph file identity) ─────────────────────────

/**
 * Build the set of project-relative paths the graph lists. The parsed result
 * is cached per graph file and reused until the file's mtime/size/inode
 * change, so a burst of /file-content.json requests parses the graph once.
 */
export function createAllowlistCache() {
  let cachedKey = null;
  let cachedSet = new Set();

  return {
    get(dataDir, projectRoot = path.dirname(dataDir)) {
      const graphFile = path.join(dataDir, "knowledge-graph.json");
      let stat;
      try {
        stat = fs.lstatSync(graphFile);
      } catch {
        return new Set();
      }
      if (stat.isSymbolicLink() || !stat.isFile()) return new Set();
      const key = [graphFile, projectRoot, stat.mtimeMs, stat.ctimeMs, stat.size, stat.ino].join("\0");
      if (key === cachedKey) return cachedSet;

      const allowed = new Set();
      try {
        const raw = JSON.parse(readDataFile(dataDir, "knowledge-graph.json", projectRoot));
        for (const node of raw.nodes ?? []) {
          if (typeof node?.filePath !== "string") continue;
          const normalized = normalizeGraphPath(node.filePath, projectRoot);
          if (normalized) allowed.add(normalized);
        }
      } catch {
        return new Set();
      }
      cachedKey = key;
      cachedSet = allowed;
      return allowed;
    },
  };
}

// ── Source file preview ────────────────────────────────────────────────────

function reject(message, statusCode = 400) {
  return { statusCode, payload: { error: message } };
}

/**
 * Serve a source file for the code viewer.
 *
 * `allowedPaths` is the set of project-relative POSIX paths the graph lists
 * (or a function returning it, so it is only built for requests that pass the
 * cheap lexical checks).
 * Beyond the lexical checks, the file's real path (every symlink resolved)
 * must stay inside the real path of the project root.
 */
export function readSourceFile({ projectRoot, requestedPath, allowedPaths }) {
  if (!requestedPath) return reject("Missing path");
  if (requestedPath.includes("\0")) return reject("Invalid path");
  if (path.isAbsolute(requestedPath)) return reject("Absolute paths are not allowed");

  const normalizedPath = path.normalize(requestedPath);
  if (
    normalizedPath === "." ||
    normalizedPath === ".." ||
    normalizedPath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(normalizedPath)
  ) {
    return reject("Path must stay inside the project");
  }

  const absoluteFile = path.resolve(projectRoot, normalizedPath);
  const relativeToRoot = path.relative(projectRoot, absoluteFile);
  if (
    !relativeToRoot ||
    relativeToRoot === ".." ||
    relativeToRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToRoot)
  ) {
    return reject("Path must stay inside the project");
  }
  const safeRelativePath = relativeToRoot.split(path.sep).join("/");
  const allowed = typeof allowedPaths === "function" ? allowedPaths() : allowedPaths;
  if (!allowed.has(safeRelativePath)) {
    return reject("File is not in the knowledge graph", 404);
  }

  // Resolve every symlink on the way and require the result to stay inside
  // the (resolved) project root.
  let rootReal;
  let fileReal;
  try {
    rootReal = fs.realpathSync(projectRoot);
    fileReal = fs.realpathSync(absoluteFile);
  } catch {
    return reject("File not found", 404);
  }
  if (!isInside(rootReal, fileReal) || fileReal === rootReal) {
    return reject("Path resolves outside the project (symlink)", 403);
  }

  let stat;
  try {
    stat = fs.statSync(fileReal);
  } catch {
    return reject("File not found", 404);
  }
  if (!stat.isFile()) return reject("Path is not a file");
  if (stat.size > MAX_SOURCE_FILE_BYTES) return reject("File is too large to preview", 413);

  let buffer;
  try {
    const fd = fs.openSync(fileReal, fs.constants.O_RDONLY | O_NOFOLLOW);
    try {
      if (!fs.fstatSync(fd).isFile()) return reject("Path is not a file");
      buffer = fs.readFileSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return reject("File not found", 404);
  }
  if (buffer.length > MAX_SOURCE_FILE_BYTES) return reject("File is too large to preview", 413);
  if (buffer.includes(0)) return reject("Binary files cannot be previewed", 415);

  const content = buffer.toString("utf8");
  return {
    statusCode: 200,
    payload: {
      path: safeRelativePath,
      language: detectLanguage(relativeToRoot),
      content,
      sizeBytes: buffer.byteLength,
      lineCount: content.length === 0 ? 0 : content.split(/\r\n|\n|\r/).length,
    },
  };
}

// ── Opening the browser ────────────────────────────────────────────────────

/**
 * Best-effort "open this URL in the default browser". Never throws and never
 * crashes the server: a missing opener (headless Linux, WSL, Docker without
 * xdg-open) just logs a hint. No shell is involved on any platform, so the
 * URL cannot be interpreted as shell syntax. Only the local dashboard URL is
 * ever opened.
 */
export function openInBrowser(
  url,
  { platform = process.platform, spawnFn = spawn, log = console.log } = {},
) {
  const hint = () => log("  Could not open a browser automatically; open the URL manually.");
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    hint();
    return false;
  }
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") {
    hint();
    return false;
  }

  const [command, commandArgs] =
    platform === "darwin"
      ? ["open", [parsed.href]]
      : platform === "win32"
        ? ["explorer.exe", [parsed.href]]
        : ["xdg-open", [parsed.href]];
  try {
    const child = spawnFn(command, commandArgs, { stdio: "ignore", detached: true });
    // Without this listener a missing binary emits an unhandled 'error'.
    child.on("error", hint);
    child.unref();
    return true;
  } catch {
    hint();
    return false;
  }
}
