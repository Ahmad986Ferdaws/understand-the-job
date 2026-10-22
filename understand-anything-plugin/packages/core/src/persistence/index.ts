import { join, isAbsolute, relative, basename } from "node:path";
import type { KnowledgeGraph, AnalysisMeta, ProjectConfig } from "../types.js";
import type { FingerprintStore } from "../fingerprint.js";
import { validateGraph } from "../schema.js";
import {
  UnsafeDataDirError,
  assertSafeDir,
  existsNoFollow,
  safeReadFile,
  safeWriteFile,
} from "./safe-io.js";

export { UnsafeDataDirError } from "./safe-io.js";

const UA_DIR = ".ua";
const LEGACY_UA_DIR = ".understand-anything";
const GRAPH_FILE = "knowledge-graph.json";
const META_FILE = "meta.json";
const FINGERPRINT_FILE = "fingerprints.json";
const CONFIG_FILE = "config.json";

/**
 * Resolve the data directory NAME for a project. Projects analyzed before
 * the `.ua` rename keep their existing `.understand-anything/` for both
 * reads and writes (no migration needed); fresh projects get `.ua/`.
 */
export function resolveUaDirName(projectRoot: string): string {
  // lstat-based: a symlinked (even dangling) `.understand-anything` still
  // counts as "present", so the safety check below sees it and refuses it
  // instead of silently falling through to `.ua/`.
  return existsNoFollow(join(projectRoot, LEGACY_UA_DIR)) ? LEGACY_UA_DIR : UA_DIR;
}

/** Absolute path of the project's data directory (see resolveUaDirName). */
export function resolveUaDir(projectRoot: string): string {
  return join(projectRoot, resolveUaDirName(projectRoot));
}

/**
 * Throws UnsafeDataDirError if the project's data directory is a symlink or
 * resolves outside the project root. A missing directory is fine.
 */
export function assertSafeUaDir(projectRoot: string): void {
  assertSafeDir(projectRoot, resolveUaDir(projectRoot));
}

/**
 * Every write to the data directory goes through here: the directory is
 * checked for symlinks / escapes, and the file is written to an exclusive temp
 * file and renamed into place, so a symlinked target is replaced rather than
 * followed.
 */
function writeUaFile(projectRoot: string, fileName: string, content: string): void {
  safeWriteFile(projectRoot, resolveUaDir(projectRoot), fileName, content);
}

/** Read a data-directory file (null if absent); refuses symlinks. */
function readUaFile(projectRoot: string, fileName: string): string | null {
  return safeReadFile(projectRoot, resolveUaDir(projectRoot), fileName);
}

/**
 * Like readUaFile, but ordinary I/O errors (unreadable file) map to null so
 * lenient loaders keep their fall-back behaviour. Symlink / escape refusals
 * are never swallowed.
 */
function readUaFileLenient(projectRoot: string, fileName: string): string | null {
  try {
    return readUaFile(projectRoot, fileName);
  } catch (err) {
    if (err instanceof UnsafeDataDirError) throw err;
    return null;
  }
}

/**
 * Sanitise every node's filePath before writing to disk.
 *
 * The analysis agent produces absolute paths like:
 *   /Users/alice/company/src/auth.ts
 *
 * We convert them to paths relative to projectRoot:
 *   src/auth.ts
 *
 * Three cases are handled:
 *   1. Path is inside projectRoot      → make it relative
 *   2. Path is absolute but outside    → keep only the filename (last segment)
 *   3. Path is already relative        → leave it untouched
 *
 * This means the developer's home directory, username, and company
 * directory layout are never written to knowledge-graph.json.
 */
function sanitiseFilePaths(
  graph: KnowledgeGraph,
  projectRoot: string,
): KnowledgeGraph {
  const normalRoot = projectRoot.endsWith("/")
    ? projectRoot
    : projectRoot + "/";

  const sanitisedNodes = graph.nodes.map((node) => {
    if (typeof node.filePath !== "string") return node;

    const fp = node.filePath;

    if (!isAbsolute(fp)) {
      // Already relative — nothing to do.
      return node;
    }

    if (fp.startsWith(normalRoot) || fp.startsWith(projectRoot)) {
      // Inside the project root — make it relative.
      return { ...node, filePath: relative(projectRoot, fp) };
    }

    // Absolute but outside the project root — use only the filename
    // so we leak as little as possible.
    return { ...node, filePath: basename(fp) };
  });

  return { ...graph, nodes: sanitisedNodes };
}

export function saveGraph(projectRoot: string, graph: KnowledgeGraph): void {
  // FIX — sanitise absolute file paths before persisting.
  // Without this, absolute paths like /Users/alice/company/src/auth.ts
  // are written verbatim into knowledge-graph.json and later served
  // by the dashboard server, leaking the developer's directory layout.
  const sanitised = sanitiseFilePaths(graph, projectRoot);

  writeUaFile(projectRoot, GRAPH_FILE, JSON.stringify(sanitised, null, 2));
}

export function loadGraph(
  projectRoot: string,
  options?: { validate?: boolean },
): KnowledgeGraph | null {
  const text = readUaFile(projectRoot, GRAPH_FILE);
  if (text === null) return null;

  const data = JSON.parse(text);

  if (options?.validate !== false) {
    const result = validateGraph(data);
    if (!result.success) {
      throw new Error(
        `Invalid knowledge graph: ${result.fatal ?? "unknown error"}`,
      );
    }
    return result.data as KnowledgeGraph;
  }

  return data as KnowledgeGraph;
}

export function saveMeta(projectRoot: string, meta: AnalysisMeta): void {
  writeUaFile(projectRoot, META_FILE, JSON.stringify(meta, null, 2));
}

export function loadMeta(projectRoot: string): AnalysisMeta | null {
  const text = readUaFile(projectRoot, META_FILE);
  if (text === null) return null;
  return JSON.parse(text) as AnalysisMeta;
}

export function saveFingerprints(projectRoot: string, store: FingerprintStore): void {
  writeUaFile(projectRoot, FINGERPRINT_FILE, JSON.stringify(store, null, 2));
}

export function loadFingerprints(projectRoot: string): FingerprintStore | null {
  const text = readUaFileLenient(projectRoot, FINGERPRINT_FILE);
  if (text === null) return null;
  try {
    return JSON.parse(text) as FingerprintStore;
  } catch {
    return null;
  }
}

const DEFAULT_CONFIG: ProjectConfig = { autoUpdate: false, outputLanguage: "en" };

export function saveConfig(projectRoot: string, config: ProjectConfig): void {
  writeUaFile(projectRoot, CONFIG_FILE, JSON.stringify(config, null, 2));
}

export function loadConfig(projectRoot: string): ProjectConfig {
  const text = readUaFileLenient(projectRoot, CONFIG_FILE);
  if (text === null) return { ...DEFAULT_CONFIG };
  try {
    return JSON.parse(text) as ProjectConfig;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

const DOMAIN_GRAPH_FILE = "domain-graph.json";

export function saveDomainGraph(projectRoot: string, graph: KnowledgeGraph): void {
  const sanitised = sanitiseFilePaths(graph, projectRoot);
  writeUaFile(projectRoot, DOMAIN_GRAPH_FILE, JSON.stringify(sanitised, null, 2));
}

export function loadDomainGraph(
  projectRoot: string,
  options?: { validate?: boolean },
): KnowledgeGraph | null {
  const text = readUaFile(projectRoot, DOMAIN_GRAPH_FILE);
  if (text === null) return null;

  const data = JSON.parse(text);

  if (options?.validate !== false) {
    const result = validateGraph(data);
    if (!result.success) {
      throw new Error(
        `Invalid domain graph: ${result.fatal ?? "unknown error"}`,
      );
    }
    return result.data as KnowledgeGraph;
  }

  return data as KnowledgeGraph;
}
