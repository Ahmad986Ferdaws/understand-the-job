/// <reference types="vitest" />
import { defineConfig, type UserConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import type { IncomingMessage, ServerResponse } from "http";
import {
  getGraphFreshnessBatch,
  type GraphFreshnessInput,
  type GraphFreshnessResult,
} from "../core/src/staleness";
// Server-side guards shared with the standalone viewer (packages/viewer):
// token compare, Host check, CSP/security headers, symlink-safe file reads.
import {
  UA_DIR_CANDIDATES,
  UnsafeDataFileError,
  applySecurityHeaders,
  buildCsp,
  createAllowlistCache,
  isAllowedHost,
  lexists,
  readDataFile,
  readSanitizedJson,
  readSourceFile,
  resolveAccessToken,
  tokensMatch,
} from "../viewer/bin/server-guards.mjs";

// Generate a one-time token when the server process starts.
// This token is printed to the terminal and must be in the URL
// to fetch knowledge-graph.json or diff-overlay.json.
const ACCESS_TOKEN = resolveAccessToken();

// Parsed graph allowlist for /file-content.json, cached per graph file version.
const allowlist = createAllowlistCache();

function graphFileCandidates(fileName: string): string[] {
  const graphDir = process.env.GRAPH_DIR;
  const roots = [
    ...(graphDir ? [graphDir] : []),
    process.cwd(),
    path.resolve(process.cwd(), "../../.."),
  ];
  return roots.flatMap((root) =>
    UA_DIR_CANDIDATES.map((dir) => path.resolve(root, dir, fileName)),
  );
}

// lexists, not existsSync: a symlinked data file must be found so it can be
// refused, not silently skipped in favour of a candidate further down.
function findGraphFile(fileName: string): string | null {
  return graphFileCandidates(fileName).find((candidate) => lexists(candidate)) ?? null;
}

function projectRootFromGraphFile(candidate: string): string {
  return path.dirname(path.dirname(candidate));
}

function sendJson(res: import("http").ServerResponse, statusCode: number, payload: unknown) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function rejectFileRequest(message: string, statusCode = 400) {
  return { statusCode, payload: { error: message } };
}

/** Map a data-file read failure to a JSON error response. */
function sendReadFailure(
  res: import("http").ServerResponse,
  err: unknown,
  fallbackMessage: string,
) {
  if (err instanceof UnsafeDataFileError) {
    sendJson(res, 409, { error: `Refusing to read data file: ${err.message}` });
  } else {
    sendJson(res, 500, { error: fallbackMessage });
  }
}

function readSourceFileRequest(url: URL) {
  const graphFile = findGraphFile("knowledge-graph.json");
  if (!graphFile) {
    return rejectFileRequest("No knowledge graph found. Run /understand first.", 404);
  }
  const projectRoot = projectRootFromGraphFile(graphFile);
  const dataDir = path.dirname(graphFile);
  return readSourceFile({
    projectRoot,
    requestedPath: url.searchParams.get("path") ?? "",
    allowedPaths: () => allowlist.get(dataDir, projectRoot),
  });
}

export interface DashboardFreshnessReport {
  graphs: {
    knowledge: GraphFreshnessResult;
    domain?: GraphFreshnessResult;
  };
}

function readGraphMetadata(graphFile: string): GraphFreshnessInput {
  const graph = JSON.parse(
    readDataFile(path.dirname(graphFile), path.basename(graphFile), projectRootFromGraphFile(graphFile)),
  ) as {
    project?: {
      gitCommitHash?: unknown;
      analyzedAt?: unknown;
    };
  };
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

export async function readGraphFreshness() {
  const graphFile = findGraphFile("knowledge-graph.json");
  if (!graphFile) {
    return rejectFileRequest("No knowledge graph found. Run /understand first.", 404);
  }

  const domainGraphFile = path.join(path.dirname(graphFile), "domain-graph.json");
  let knowledgeInput: GraphFreshnessInput;
  let domainInput: GraphFreshnessInput | undefined;
  try {
    knowledgeInput = readGraphMetadata(graphFile);
    domainInput = lexists(domainGraphFile)
      ? readGraphMetadata(domainGraphFile)
      : undefined;
  } catch (err) {
    return err instanceof UnsafeDataFileError
      ? rejectFileRequest(`Refusing to read data file: ${err.message}`, 409)
      : rejectFileRequest("Failed to read graph file", 500);
  }

  const projectRoot = projectRootFromGraphFile(graphFile);
  let graphs: DashboardFreshnessReport["graphs"];
  if (domainInput) {
    graphs = await getGraphFreshnessBatch(projectRoot, {
      knowledge: knowledgeInput,
      domain: domainInput,
    });
  } else {
    const result = await getGraphFreshnessBatch(projectRoot, {
      knowledge: knowledgeInput,
    });
    graphs = { knowledge: result.knowledge };
  }

  return {
    statusCode: 200,
    payload: { graphs } satisfies DashboardFreshnessReport,
  };
}

type DashboardDataMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
) => void;

/**
 * First middleware in the chain: security headers on every response (CSP
 * with the dev-only relaxations the Vite client needs) and a Host-header
 * check against DNS rebinding. Host is checked by name only because Vite may
 * move to another port at runtime.
 */
export function createSecurityMiddleware(): DashboardDataMiddleware {
  return (req, res, next) => {
    applySecurityHeaders(res, { html: true, dev: true });
    if (!isAllowedHost(req.headers.host)) {
      res.statusCode = 403;
      res.setHeader("Content-Type", "text/plain");
      res.end("Forbidden: unexpected Host header");
      return;
    }
    next();
  };
}

export function createDashboardDataMiddleware(
  accessToken: string,
): DashboardDataMiddleware {
  return (req, res, next) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1:5173");
    if (url.pathname !== "/staleness.json") {
      next();
      return;
    }

    res.setHeader("Cache-Control", "no-store");

    if (!tokensMatch(url.searchParams.get("token"), accessToken)) {
      sendJson(res, 403, { error: "Forbidden: missing or invalid token" });
      return;
    }

    void readGraphFreshness()
      .then((result) => sendJson(res, result.statusCode, result.payload))
      .catch(() => {
        sendJson(res, 500, { error: "Failed to read graph freshness" });
      });
  };
}

const PROTECTED_FILES = new Map([
  ["/knowledge-graph.json", "knowledge-graph.json"],
  ["/domain-graph.json", "domain-graph.json"],
  ["/diff-overlay.json", "diff-overlay.json"],
  ["/meta.json", "meta.json"],
]);

/**
 * Token-gated data endpoints: graph/meta JSON (paths relativised, never read
 * through a symlink), config.json and /file-content.json.
 */
export function createGraphDataMiddleware(
  accessToken: string,
): DashboardDataMiddleware {
  return (req, res, next) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1:5173");
    const pathname = url.pathname;
    const isProtectedEndpoint =
      PROTECTED_FILES.has(pathname) ||
      pathname === "/config.json" ||
      pathname === "/file-content.json";

    if (!isProtectedEndpoint) {
      next();
      return;
    }

    // FIX 3 — require the one-time token on all data endpoints.
    // Requests without a matching ?token= get a 403.
    if (!tokensMatch(url.searchParams.get("token"), accessToken)) {
      sendJson(res, 403, { error: "Forbidden: missing or invalid token" });
      return;
    }

    if (pathname === "/file-content.json") {
      const result = readSourceFileRequest(url);
      sendJson(res, result.statusCode, result.payload);
      return;
    }

    if (pathname === "/config.json") {
      const configCandidate = graphFileCandidates("config.json").find((candidate) =>
        lexists(candidate),
      );
      if (configCandidate) {
        try {
          sendJson(
            res,
            200,
            JSON.parse(
              readDataFile(
                path.dirname(configCandidate),
                "config.json",
                projectRootFromGraphFile(configCandidate),
              ),
            ),
          );
        } catch (err) {
          sendReadFailure(res, err, "Failed to read config file");
        }
        return;
      }
      sendJson(res, 200, { autoUpdate: false, outputLanguage: "en" });
      return;
    }

    const fileName = PROTECTED_FILES.get(pathname) ?? "knowledge-graph.json";
    const candidate = graphFileCandidates(fileName).find((c) => lexists(c));
    if (candidate) {
      // FIX 2 — sanitise absolute file paths before sending the JSON.
      // Nodes can contain filePath values like /Users/alice/company/src/auth.ts.
      // We convert those to relative paths (src/auth.ts) so the developer's
      // home directory and company directory layout are not leaked.
      try {
        sendJson(
          res,
          200,
          readSanitizedJson(
            path.dirname(candidate),
            fileName,
            projectRootFromGraphFile(candidate),
          ),
        );
      } catch (err) {
        // If we cannot parse or sanitise the file, refuse to serve it
        // rather than accidentally leaking raw content.
        console.error(
          "[understand-anything] Failed to sanitise graph file:",
          err instanceof UnsafeDataFileError ? err.message : err,
        );
        sendReadFailure(res, err, "Failed to read graph file");
      }
      return;
    }

    // No matching file found on disk.
    if (pathname === "/knowledge-graph.json") {
      sendJson(res, 404, { error: "No knowledge graph found. Run /understand first." });
    } else {
      res.statusCode = 404;
      res.end();
    }
  };
}

type DashboardViteConfig = UserConfig & {
  test: {
    environment: "node";
    include: string[];
  };
};

const config: DashboardViteConfig = {
  test: {
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts"],
  },

  // FIX 1 — bind only to localhost, not 0.0.0.0
  // This blocks access from any other device on the same LAN / WiFi.
  server: {
    host: "127.0.0.1",
    port: 5173,
    open: `/?token=${ACCESS_TOKEN}`,
  },

  resolve: {
    alias: {
      "@understand-anything/core/schema": path.resolve(__dirname, "../core/dist/schema.js"),
      "@understand-anything/core/search": path.resolve(__dirname, "../core/dist/search.js"),
      "@understand-anything/core/types": path.resolve(__dirname, "../core/dist/types.js"),
    },
  },

  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) {
            return "react-vendor";
          }
          if (id.includes("node_modules/@xyflow/")) return "xyflow";
          // ELK is ~1.6MB raw — split into its own chunk so it doesn't
          // bloat the main bundle. graphology is similarly large.
          if (id.includes("node_modules/elkjs/")) return "elk";
          if (id.includes("node_modules/graphology")) return "graphology";
          if (
            id.includes("node_modules/@dagrejs/") ||
            id.includes("node_modules/d3-force/")
          ) {
            return "graph-layout";
          }
          if (
            id.includes("node_modules/react-markdown/") ||
            id.includes("node_modules/hast-util-to-jsx-runtime/") ||
            /[\\/]node_modules[\\/](remark|rehype|mdast|hast|unist|micromark|decode-named-character-reference|property-information|space-separated-tokens|comma-separated-tokens|html-url-attributes|devlop|bail|ccount|character-entities|is-plain-obj|trim-lines|trough|unified|vfile|zwitch)/.test(id)
          ) {
            return "markdown";
          }
        },
      },
    },
  },

  plugins: [
    react(),
    tailwindcss(),
    {
      // The built page ships a CSP <meta> too, so it stays locked down when
      // served by something other than the viewer. Build only: the dev server
      // sets its own (relaxed) header, and the React-refresh inline script
      // would be blocked by this stricter policy. Inserted right after the
      // charset <meta> so it precedes every script and stylesheet tag.
      name: "csp-meta",
      apply: "build",
      transformIndexHtml: {
        order: "post",
        handler(html) {
          const charsetMeta = '<meta charset="UTF-8" />';
          if (!html.includes(charsetMeta)) {
            throw new Error("csp-meta: index.html has no <meta charset> to anchor the CSP <meta> to");
          }
          const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${buildCsp({ meta: true })}" />`;
          return html.replace(charsetMeta, () => `${charsetMeta}\n    ${cspMeta}`);
        },
      },
    },
    {
      name: "serve-knowledge-graph",
      configureServer(server) {
        // Print the access URL once so the developer can open it.
        server.httpServer?.once("listening", () => {
          const address = server.httpServer?.address();
          const port = typeof address === "object" && address ? address.port : 5173;
          console.log(
            `\n  🔑  Dashboard URL: http://127.0.0.1:${port}/?token=${ACCESS_TOKEN}\n`
          );
        });

        server.middlewares.use(createSecurityMiddleware());
        server.middlewares.use(createDashboardDataMiddleware(ACCESS_TOKEN));
        server.middlewares.use(createGraphDataMiddleware(ACCESS_TOKEN));
      },
    },
  ],
};

export default defineConfig(config);
