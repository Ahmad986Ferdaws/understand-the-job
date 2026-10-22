#!/usr/bin/env node
/**
 * extract-import-map.mjs
 *
 * Deterministic import resolution script for the project-scanner agent.
 * Uses PluginRegistry (TreeSitterPlugin + non-code parsers) from
 * @understand-anything/core to extract raw import paths via tree-sitter,
 * then applies language-specific resolution rules to map them to
 * project-internal file paths.
 *
 * Replaces the LLM-written prose import resolver in agents/project-scanner.md
 * (the prose previously described patterns by language; runtime LLMs produced
 * inconsistent, regex-only scripts with sparse coverage).
 *
 * Usage:
 *   node extract-import-map.mjs <input.json> <output.json>
 *
 * Input JSON:
 *   {
 *     projectRoot: <abs-path>,
 *     files: [{ path, language, fileCategory }, ...],
 *     analysisPaths?: [<project-relative-path>, ...]
 *   }
 *
 * `files` is always the complete current inventory because import resolution
 * needs it for path/module probes. When `analysisPaths` is present, only those
 * files are read and emitted in `importMap`; omitting it preserves the original
 * full-scan behaviour.
 *
 * Output JSON:
 *   {
 *     scriptCompleted: true,
 *     stats: { filesScanned, filesWithImports, totalEdges },
 *     importMap: { <path>: [<resolvedPath>, ...], ... }
 *   }
 *
 * Logging: stderr only (stdout reserved for piped tools).
 * Per-file resilience: failures emit `Warning: extract-import-map: ...` and
 * set importMap[path] = [], they do not abort the script.
 */

import { createRequire } from 'node:module';
import { dirname, resolve, join, posix, isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

/**
 * Read a list of files concurrently while preserving result order. Failures
 * are returned in-place as `{ raw: null, err }` so callers can emit the same
 * per-file warnings they did under the previous sequential `readFileSync`
 * loops.
 *
 * `paths` is a list of `{ key, absPath }` pairs; `key` is whatever the caller
 * wants to attach the result to (typically a project-relative POSIX path).
 */
async function readFilesParallel(paths) {
  return Promise.all(
    paths.map(async ({ key, absPath }) => {
      try {
        const raw = await readFile(absPath, 'utf-8');
        return { key, raw, err: null };
      } catch (err) {
        return { key, raw: null, err };
      }
    }),
  );
}

const __dirname = dirname(fileURLToPath(import.meta.url));
// skills/understand/ -> plugin root is two dirs up
const pluginRoot = resolve(__dirname, '../..');
const require = createRequire(resolve(pluginRoot, 'package.json'));

// ---------------------------------------------------------------------------
// Resolve @understand-anything/core
//
// Node ESM dynamic import() requires a file:// URL on Windows; passing a raw
// absolute path like "C:\..." throws ERR_UNSUPPORTED_ESM_URL_SCHEME because the
// loader parses "C:" as a URL scheme. Wrap both resolutions in pathToFileURL().
// ---------------------------------------------------------------------------
let core;
try {
  core = await import(pathToFileURL(require.resolve('@understand-anything/core')).href);
} catch {
  // Fallback: direct path for installed plugin cache layouts
  core = await import(pathToFileURL(resolve(pluginRoot, 'packages/core/dist/index.js')).href);
}

const { TreeSitterPlugin, PluginRegistry, builtinLanguageConfigs, registerAllParsers } = core;

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a project-relative path to forward slashes (POSIX). Project-scanner
 * always emits forward slashes; we re-normalize to keep this script
 * cross-platform.
 */
function toPosix(p) {
  const separators = process.platform === 'win32' ? /[\\/]/ : /\//;
  return p.split(separators).filter(Boolean).join('/');
}

/**
 * Validate and normalize the optional selective-analysis path list. Keeping
 * this strict prevents an incremental caller from accidentally asking the
 * extractor to read outside projectRoot or silently miss a typo.
 */
function selectAnalysisFiles(files, analysisPaths) {
  if (analysisPaths === undefined) return files;
  if (!Array.isArray(analysisPaths)) {
    throw new Error('Invalid input: analysisPaths must be an array when provided');
  }

  const filesByPath = new Map();
  for (const file of files) {
    if (!file || typeof file.path !== 'string' || file.path.length === 0) {
      throw new Error('Invalid input: every files entry must contain a non-empty path');
    }
    filesByPath.set(toPosix(file.path), file);
  }

  const selected = [];
  const seen = new Set();
  for (const rawPath of analysisPaths) {
    if (typeof rawPath !== 'string' || rawPath.length === 0) {
      throw new Error('Invalid input: every analysisPaths entry must be a non-empty string');
    }
    // Use the host's path semantics here. On POSIX, backslashes and drive-like
    // prefixes are ordinary project-relative filename characters; on Windows,
    // path.isAbsolute also rejects drive-rooted and root-relative paths.
    if (isAbsolute(rawPath)) {
      throw new Error(`Invalid input: analysisPaths entry must be project-relative: ${rawPath}`);
    }
    const path = toPosix(rawPath);
    if (!path || path.split('/').some(part => part === '..')) {
      throw new Error(`Invalid input: analysisPaths entry escapes projectRoot: ${rawPath}`);
    }
    const file = filesByPath.get(path);
    if (!file) {
      throw new Error(`Invalid input: analysisPaths entry is not present in files: ${rawPath}`);
    }
    if (!seen.has(path)) {
      seen.add(path);
      selected.push(file);
    }
  }
  return selected;
}

// ECMAScript relational string comparison is lexicographic over UTF-16 code
// units, so path ordering is stable across ICU versions, locales, and hosts.
function comparePaths(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Join a directory with a relative segment, normalizing `.`/`..` segments and
 * returning a forward-slash POSIX path. Anchored at project root (no leading
 * slash). Returns '' if the path walks above the project root.
 */
function resolveRelative(dir, rel) {
  const parts = (dir ? dir.split('/').filter(Boolean) : []).concat(
    rel.split('/').filter(Boolean),
  );
  const stack = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (stack.length === 0) return '';
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  return stack.join('/');
}

/**
 * Return the directory portion of a project-relative path (no trailing slash,
 * '' for top-level files).
 */
function dirOf(p) {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

// ---------------------------------------------------------------------------
// Config loading
//
// Cached once at startup. Per-file resolvers consume these values; they MUST
// NOT re-read these files (a 1000-file project would otherwise re-parse the
// same config 1000 times).
// ---------------------------------------------------------------------------

/**
 * Parse a single tsconfig.json file content and return
 * `{ baseUrl: string, paths: Map<string, string[]> }` or `null` if both the
 * comment-stripped and raw parses fail. Centralizes the "JSONC-then-raw"
 * fallback so callers can iterate many tsconfigs without duplicating the
 * try/catch ladder.
 *
 * Returning `null` (rather than throwing) lets the caller emit a Warning:
 * with the exact tsconfig path that failed; bubbling the error would
 * conceal which file was at fault when many tsconfigs are loaded.
 */
function normalizeJsonc(raw) {
  let withoutComments = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    const next = raw[i + 1];
    if (inString) {
      withoutComments += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      withoutComments += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < raw.length && raw[i] !== '\n') i++;
      if (i < raw.length) withoutComments += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) {
        if (raw[i] === '\n') withoutComments += '\n';
        i++;
      }
      i++;
      continue;
    }
    withoutComments += ch;
  }

  let normalized = '';
  inString = false;
  escaped = false;
  for (let i = 0; i < withoutComments.length; i++) {
    const ch = withoutComments[i];
    if (inString) {
      normalized += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      normalized += ch;
      continue;
    }
    if (ch === ',') {
      let nextIndex = i + 1;
      while (/\s/.test(withoutComments[nextIndex] ?? '')) nextIndex++;
      if (withoutComments[nextIndex] === '}' || withoutComments[nextIndex] === ']') continue;
    }
    normalized += ch;
  }
  return normalized.replace(/^\uFEFF/, '');
}

// Marker prefix for a path-alias target that was written as `${configDir}/...`.
// Such a target is already project-relative, so the resolver must not anchor
// it at baseUrl / the declaring config again.
const CONFIG_DIR_TOKEN = '${configDir}';
const ROOT_RELATIVE_MARK = '\0root:';
const CONFIG_FILE_NAMES = new Set(['tsconfig.json', 'jsconfig.json']);
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const MAX_EXTENDS_DEPTH = 32;

/**
 * Parse one tsconfig.json / jsconfig.json and return only the declared
 * (unresolved) fields that matter for import resolution:
 *   { extends: string[], baseUrl?: string|null, paths?: Map|null }
 * `undefined` means "not declared here" (inherit); `null` means the config
 * explicitly reset the option. Returns `null` when both the comment-stripped
 * and raw parses fail, so the caller can warn with the exact path at fault.
 */
function parseTsConfigText(raw) {
  const normalized = normalizeJsonc(raw);
  let parsed;
  try {
    parsed = JSON.parse(normalized);
  } catch {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const compilerOptions =
    parsed?.compilerOptions && typeof parsed.compilerOptions === 'object'
      ? parsed.compilerOptions
      : {};
  const config = {
    extends: (Array.isArray(parsed?.extends) ? parsed.extends : [parsed?.extends])
      .filter(spec => typeof spec === 'string' && spec.length > 0),
    baseUrl: undefined,
    paths: undefined,
  };
  if ('baseUrl' in compilerOptions) {
    config.baseUrl = typeof compilerOptions.baseUrl === 'string' ? compilerOptions.baseUrl : null;
  }
  if ('paths' in compilerOptions) {
    const rawPaths = compilerOptions.paths;
    if (rawPaths && typeof rawPaths === 'object' && !Array.isArray(rawPaths)) {
      config.paths = new Map();
      for (const [alias, targets] of Object.entries(rawPaths)) {
        if (Array.isArray(targets)) {
          config.paths.set(alias, targets.filter(target => typeof target === 'string'));
        }
      }
    } else if (rawPaths === null) {
      config.paths = null;
    }
  }
  return config;
}

/**
 * Safe, memoized reader for files under the project root. Every read is
 * realpath-checked so a symlink (or a `..` extends) can never make the script
 * read a config outside the project. Returns `{ text, reason }` where `reason`
 * is null on success, else 'missing' | 'outside' | 'unreadable'.
 */
function createSafeReader(projectRoot) {
  let rootReal;
  try {
    rootReal = realpathSync(projectRoot);
  } catch {
    rootReal = resolve(projectRoot);
  }
  const cache = new Map();
  const isInside = real => {
    const rel = relative(rootReal, real);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  };
  const read = relPath => {
    if (cache.has(relPath)) return cache.get(relPath);
    let result;
    if (!relPath || relPath.split('/').includes('..')) {
      result = { text: null, reason: 'outside' };
    } else {
      try {
        const real = realpathSync(join(rootReal, relPath));
        if (!isInside(real)) {
          result = { text: null, reason: 'outside' };
        } else {
          const stats = statSync(real);
          result = stats.isFile() && stats.size <= MAX_CONFIG_BYTES
            ? { text: readFileSync(real, 'utf-8'), reason: null }
            : { text: null, reason: 'unreadable' };
        }
      } catch (err) {
        result = { text: null, reason: err?.code === 'ENOENT' || err?.code === 'ENOTDIR' ? 'missing' : 'unreadable', error: err };
      }
    }
    cache.set(relPath, result);
    return result;
  };
  return { rootReal, read };
}

/**
 * Locate the file a tsconfig `extends` entry points at, strictly inside the
 * project root. Relative and absolute entries get TypeScript's implicit
 * `.json`; package specifiers (`@tsconfig/node20/tsconfig.json`) are looked up
 * in `node_modules` directories from the config's directory up to the project
 * root only. Returns `{ path }` (project-relative POSIX), `{ outside: true }`
 * when the target escapes the project root, or `null` when nothing is found.
 */
function resolveExtendsTarget(spec, fromDir, reader) {
  const withJson = base =>
    base.endsWith('.json') ? [base] : [`${base}.json`, `${base}/tsconfig.json`];
  const candidates = [];
  if (isAbsolute(spec)) {
    const rel = relative(reader.rootReal, resolve(spec)).split(sep).join('/');
    if (rel === '' || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
      return { outside: true };
    }
    candidates.push(...withJson(rel));
  } else if (spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../')) {
    const target = posix.normalize(posix.join(fromDir || '.', spec));
    if (target === '..' || target.startsWith('../')) return { outside: true };
    candidates.push(...withJson(target));
  } else {
    for (let dir = fromDir; ; dir = dirOf(dir)) {
      candidates.push(...withJson(dir ? `${dir}/node_modules/${spec}` : `node_modules/${spec}`));
      if (!dir) break;
    }
  }
  let outside = false;
  for (const candidate of candidates) {
    const read = reader.read(candidate);
    if (read.text !== null) return { path: candidate };
    if (read.reason === 'outside') outside = true;
  }
  return outside ? { outside: true } : null;
}

/** `${configDir}` expands to the directory of the config that is being resolved. */
function expandConfigDir(value, finalDir) {
  return value.startsWith(CONFIG_DIR_TOKEN)
    ? posix.join(finalDir || '.', value.slice(CONFIG_DIR_TOKEN.length))
    : null;
}

/** The options a single config declares itself, anchored in project-relative form. */
function ownTsConfigOptions(config, configDir, finalDir) {
  const own = {};
  if (config.baseUrl !== undefined) {
    if (config.baseUrl === null) {
      own.baseUrl = null;
    } else {
      const expanded = expandConfigDir(config.baseUrl, finalDir);
      // An absolute baseUrl can't be mapped into the project; ignore it.
      const joined = expanded ?? (isAbsolute(config.baseUrl) ? null : posix.join(configDir || '.', config.baseUrl));
      own.baseUrl = joined === null ? null : (posix.normalize(joined) === '.' ? '' : posix.normalize(joined));
    }
  }
  if (config.paths !== undefined) {
    own.paths = config.paths === null
      ? null
      : new Map([...config.paths].map(([alias, targets]) => [
        alias,
        targets.map(target => {
          const expanded = expandConfigDir(target, finalDir);
          return expanded === null ? target : `${ROOT_RELATIVE_MARK}${posix.normalize(expanded)}`;
        }),
      ]));
    // Without a baseUrl, targets are relative to the config that declares paths.
    own.pathsBase = configDir;
  }
  return own;
}

/** Child-over-parent merge: baseUrl and paths each replace the inherited value wholesale. */
function overlayTsConfig(parent, child) {
  const merged = { ...parent };
  if ('baseUrl' in child) {
    if (child.baseUrl === null) delete merged.baseUrl;
    else merged.baseUrl = child.baseUrl;
  }
  if ('paths' in child) {
    if (child.paths === null) {
      delete merged.paths;
      delete merged.pathsBase;
    } else {
      merged.paths = child.paths;
      merged.pathsBase = child.pathsBase;
    }
  }
  return merged;
}

/**
 * Load every `tsconfig.json` / `jsconfig.json` discovered in the input file
 * list and compute its EFFECTIVE alias settings, following `extends` (a string
 * or, since TS 5.0, an array — later entries win; the config itself wins over
 * everything it extends). Returns `Map<dirPath, { baseUrl?, paths, pathsBase }>`
 * keyed by the project-relative POSIX directory containing the config (empty
 * string for the root).
 *
 *   - `baseUrl` is the project-relative directory it resolves to, taken from
 *     whichever config in the chain declares it.
 *   - `paths` keeps its trailing `*` wildcards intact (e.g. `"@/*"`) and
 *     replaces an inherited `paths` entirely, as TypeScript does.
 *   - `pathsBase` is the directory of the config that declared `paths`; targets
 *     are anchored there when no baseUrl is in effect.
 *
 * Safety: extended configs are only read from inside the project root
 * (realpath-checked, so symlinks cannot escape either); an `extends` that
 * resolves outside it is skipped with a Warning. Cycles and over-deep chains
 * are cut. Extended configs that are missing or malformed are skipped; only a
 * config listed in the inventory reports a failure.
 *
 * WHY plural: pnpm/yarn workspace monorepos carry per-package configs with
 * package-scoped `paths`; resolution walks up from each importer.
 *
 * Parse strategy (per-file, in parseTsConfigText): comment-stripped text
 * first, then the raw text, else warn and skip.
 */
async function loadTsConfigs(projectRoot, files) {
  const out = new Map();
  const warnings = [];
  const failures = [];
  const warned = new Set();
  const warn = message => {
    if (warned.has(message)) return;
    warned.add(message);
    warnings.push(message);
  };
  const reader = createSafeReader(projectRoot);

  // One config per directory; tsconfig.json wins over jsconfig.json.
  const inventory = new Map();
  for (const f of files) {
    const p = toPosix(f.path);
    const base = p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p;
    if (!CONFIG_FILE_NAMES.has(base)) continue;
    const dir = dirOf(p);
    if (!inventory.has(dir) || base === 'tsconfig.json') inventory.set(dir, p);
  }

  const parsedCache = new Map();
  const loadParsed = rel => {
    if (!parsedCache.has(rel)) {
      const read = reader.read(rel);
      parsedCache.set(rel, read.text === null
        ? { read }
        : { read, config: parseTsConfigText(read.text) });
    }
    return parsedCache.get(rel);
  };

  const effectiveConfig = (rel, finalDir, visiting) => {
    const loaded = loadParsed(rel);
    if (!loaded.config) {
      if (loaded.read.text !== null) {
        warn(
          `Warning: extract-import-map: extended config ${join(reader.rootReal, rel)} ` +
          `failed to parse — its path aliases will not be applied\n`,
        );
      }
      return {};
    }
    if (visiting.has(rel) || visiting.size >= MAX_EXTENDS_DEPTH) return {};
    visiting.add(rel);
    const configDir = dirOf(rel);
    let effective = {};
    for (const spec of loaded.config.extends) {
      const target = resolveExtendsTarget(spec, configDir, reader);
      if (target?.outside) {
        warn(
          `Warning: extract-import-map: ${join(reader.rootReal, rel)} extends "${spec}", ` +
          `which resolves outside the project root — skipped\n`,
        );
      } else if (target) {
        effective = overlayTsConfig(effective, effectiveConfig(target.path, finalDir, visiting));
      }
    }
    effective = overlayTsConfig(effective, ownTsConfigOptions(loaded.config, configDir, finalDir));
    visiting.delete(rel);
    return effective;
  };

  for (const [dir, p] of inventory) {
    const loaded = loadParsed(p);
    const base = p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p;
    if (loaded.read.reason === 'missing') continue;
    if (loaded.read.reason === 'outside') {
      warn(
        `Warning: extract-import-map: ${base} at ${join(projectRoot, p)} resolves outside ` +
        `the project root — path aliases from this config will not be applied\n`,
      );
      continue;
    }
    if (loaded.read.text === null) {
      const message = loaded.read.error?.message ?? 'unreadable';
      failures.push({ path: p, stage: 'resolver-config-read', message });
      warnings.push(
        `Warning: extract-import-map: ${base} at ${join(projectRoot, p)} failed ` +
        `to read (${message}) — path aliases from this config will ` +
        `not be applied — relative imports unaffected\n`,
      );
      continue;
    }
    if (!loaded.config) {
      failures.push({
        path: p,
        stage: 'resolver-config-parse',
        message: `invalid ${base}`,
      });
      warnings.push(
        `Warning: extract-import-map: ${base} at ${join(projectRoot, p)} failed ` +
        `to parse — path aliases from this config will not be applied ` +
        `— relative imports unaffected\n`,
      );
      continue;
    }
    const effective = effectiveConfig(p, dir, new Set());
    if (effective.baseUrl !== undefined || (effective.paths && effective.paths.size > 0)) {
      out.set(dir, {
        baseUrl: effective.baseUrl,
        paths: effective.paths ?? new Map(),
        pathsBase: effective.pathsBase ?? dir,
      });
    }
  }
  return { configs: out, warnings, failures };
}

// ---------------------------------------------------------------------------
// Workspace packages (pnpm / npm / yarn workspaces)
// ---------------------------------------------------------------------------

function unquoteYamlScalar(value) {
  const trimmed = value.trim();
  const match = trimmed.match(/^(['"])(.*)\1$/);
  return match ? match[2] : trimmed;
}

/** The `packages:` globs of a pnpm-workspace.yaml (block or inline list). */
function parsePnpmWorkspacePatterns(raw) {
  const patterns = [];
  let inPackages = false;
  for (const line of raw.split(/\r?\n/)) {
    const text = line.replace(/\s+#.*$/, '');
    if (/^\s*(#.*)?$/.test(text)) continue;
    const inline = text.match(/^packages\s*:\s*\[(.*)\]\s*$/);
    if (inline) {
      for (const item of inline[1].split(',')) {
        const value = unquoteYamlScalar(item);
        if (value) patterns.push(value);
      }
      inPackages = false;
    } else if (/^packages\s*:\s*$/.test(text)) {
      inPackages = true;
    } else if (inPackages) {
      const item = text.match(/^\s*-\s*(.+?)\s*$/);
      if (item) patterns.push(unquoteYamlScalar(item[1]));
      else if (/^\S/.test(text)) inPackages = false;
    }
  }
  return patterns;
}

/** Directory glob (`packages/*`, `apps/**`) -> RegExp over a relative POSIX dir. */
function workspaceGlobToRegExp(pattern) {
  const glob = pattern.replace(/^\.\//, '').replace(/\/+$/, '');
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        source += '(?:.*/)?';
        i += 2;
      } else {
        source += '.*';
        i += 1;
      }
    } else if (ch === '*') {
      source += '[^/]*';
    } else if (ch === '?') {
      source += '[^/]';
    } else {
      source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

/**
 * Map workspace package names (`@acme/ui`) to the package's directory and
 * manifest. Only packages matched by a declared workspace glob count (root
 * package.json `workspaces`, or a sibling pnpm-workspace.yaml), so an unrelated
 * example/fixture package.json can't shadow a real npm package name.
 */
async function loadWorkspacePackages(projectRoot, files) {
  const packages = new Map();
  const fileSet = new Set(files.map(f => toPosix(f.path)));
  const reader = createSafeReader(projectRoot);
  const manifestPaths = [...fileSet]
    .filter(p => p === 'package.json' || p.endsWith('/package.json'))
    .sort(comparePaths);

  const manifests = new Map();
  for (const p of manifestPaths) {
    const read = reader.read(p);
    if (read.text === null) continue;
    try {
      const parsed = JSON.parse(read.text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) manifests.set(dirOf(p), parsed);
    } catch {
      // A malformed package.json just contributes no workspace information.
    }
  }

  const workspaceRoots = [];
  for (const [dir, manifest] of manifests) {
    let patterns = [];
    if (Array.isArray(manifest.workspaces)) patterns = manifest.workspaces;
    else if (Array.isArray(manifest.workspaces?.packages)) patterns = manifest.workspaces.packages;
    const yamlPath = dir ? `${dir}/pnpm-workspace.yaml` : 'pnpm-workspace.yaml';
    if (fileSet.has(yamlPath)) {
      const yaml = reader.read(yamlPath);
      if (yaml.text !== null) patterns = [...patterns, ...parsePnpmWorkspacePatterns(yaml.text)];
    }
    patterns = patterns.filter(pattern => typeof pattern === 'string' && pattern.length > 0);
    if (patterns.length === 0) continue;
    workspaceRoots.push({
      dir,
      include: patterns.filter(p => !p.startsWith('!')).map(workspaceGlobToRegExp),
      exclude: patterns.filter(p => p.startsWith('!')).map(p => workspaceGlobToRegExp(p.slice(1))),
    });
  }

  for (const { dir: rootDir, include, exclude } of workspaceRoots) {
    for (const [dir, manifest] of manifests) {
      if (dir === rootDir || typeof manifest.name !== 'string' || !manifest.name) continue;
      if (rootDir && !dir.startsWith(`${rootDir}/`)) continue;
      const rel = rootDir ? dir.slice(rootDir.length + 1) : dir;
      if (!include.some(re => re.test(rel)) || exclude.some(re => re.test(rel))) continue;
      if (!packages.has(manifest.name)) packages.set(manifest.name, { dir, manifest });
    }
  }
  return { packages, warnings: [], failures: [] };
}

/**
 * Load every `go.mod` discovered in the input file list and extract its
 * `module <name>` line. Returns `Map<dirPath, moduleName>` where `dirPath`
 * is the project-relative POSIX directory containing the go.mod (empty
 * string for a root-level go.mod).
 *
 * WHY plural: multi-service / multi-module repositories (e.g. Google's
 * microservices-demo) have one go.mod per service. The resolver dispatches
 * per importer by walking up to the nearest go.mod, so a single root-only
 * lookup misses every file that lives inside a sub-module.
 *
 * Files outside the discovered `files[]` are ignored — the project-scanner
 * is the single source of truth for what the user considers part of the
 * project. On read failure for a discovered go.mod we silently skip that
 * entry; the per-file resolver will surface the "no ancestor go.mod" warning
 * if it matters for any importer.
 *
 * Example go.mod:
 *   module github.com/foo/bar
 *   go 1.21
 *
 * The resolver uses each module's prefix to translate
 * `import "github.com/foo/bar/x"` into the project-internal `x/<file>.go`.
 */
async function loadGoModules(projectRoot, files) {
  const out = new Map();
  // loadGoModules currently emits no warnings (read failures are silently
  // skipped — per-file resolvers surface "no ancestor go.mod" later), but
  // the `{ data, warnings }` shape matches loadTsConfigs / loadPhpAutoloads
  // so the concurrent caller in buildResolutionContext can drain them
  // uniformly in canonical order.
  const warnings = [];
  const failures = [];
  const candidates = [];
  for (const f of files) {
    const p = toPosix(f.path);
    const base = p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p;
    if (base !== 'go.mod') continue;
    const absPath = join(projectRoot, p);
    if (!existsSync(absPath)) continue;
    candidates.push({ key: p, absPath });
  }
  const reads = await readFilesParallel(candidates);
  for (const { key: p, raw, err } of reads) {
    if (err) {
      failures.push({ path: p, stage: 'resolver-config-read', message: err.message });
      warnings.push(
        `Warning: extract-import-map: go.mod at ${join(projectRoot, p)} failed ` +
        `to read (${err.message}) — Go module imports may not resolve\n`,
      );
      continue;
    }
    let moduleName = '';
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.replace(/\/\/.*$/, '').trim();
      if (!trimmed.startsWith('module ')) continue;
      moduleName = trimmed.slice('module '.length).trim();
      break;
    }
    if (!moduleName) {
      failures.push({
        path: p,
        stage: 'resolver-config-parse',
        message: 'module directive missing',
      });
      warnings.push(
        `Warning: extract-import-map: go.mod at ${join(projectRoot, p)} has no ` +
        `module directive — Go module imports may not resolve\n`,
      );
      continue;
    }
    out.set(dirOf(p), moduleName);
  }
  return { modules: out, warnings, failures };
}

/**
 * Parse Swift Package.swift target declarations just enough for import-map
 * resolution. Swift imports modules, and SwiftPM target names are module names.
 * The common convention is `Sources/<Target>`, but packages can override the
 * source directory with `path: "..."`; without this light manifest pass those
 * custom targets would stay disconnected.
 *
 * This is intentionally a focused parser, not a Swift evaluator. It handles
 * `.target(...)`, `.executableTarget(...)`, and `.testTarget(...)` calls with
 * literal `name:` and optional literal `path:` arguments.
 */
function parseSwiftPackageTargets(raw) {
  const targets = [];
  const callRe = /\.(target|executableTarget|testTarget)\s*\(/g;
  let match;

  while ((match = callRe.exec(raw)) !== null) {
    const kind = match[1];
    const bodyStart = callRe.lastIndex;
    let depth = 1;
    let i = bodyStart;
    let inString = false;
    let quote = '';
    let escaped = false;

    for (; i < raw.length; i++) {
      const ch = raw[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === quote) {
          inString = false;
        }
        continue;
      }

      if (ch === '"' || ch === "'") {
        inString = true;
        quote = ch;
        continue;
      }
      if (ch === '(') depth += 1;
      if (ch === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }

    const body = raw.slice(bodyStart, i);
    callRe.lastIndex = i + 1;

    const name = body.match(/\bname\s*:\s*"([^"]+)"/)?.[1];
    if (!name) continue;
    const explicitPath = body.match(/\bpath\s*:\s*"([^"]+)"/)?.[1];
    const defaultRoot = kind === 'testTarget' ? 'Tests' : 'Sources';
    targets.push({
      name,
      path: explicitPath || `${defaultRoot}/${name}`,
    });
  }

  return targets;
}

async function loadSwiftPackageTargets(projectRoot, files) {
  const targets = new Map();
  const warnings = [];
  const failures = [];
  const candidates = [];

  for (const f of files) {
    const p = toPosix(f.path);
    const base = p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p;
    if (base !== 'Package.swift') continue;
    const absPath = join(projectRoot, p);
    if (!existsSync(absPath)) continue;
    candidates.push({ key: p, absPath });
  }

  const reads = await readFilesParallel(candidates);
  for (const { key: p, raw, err } of reads) {
    if (err) {
      failures.push({ path: p, stage: 'resolver-config-read', message: err.message });
      warnings.push(
        `Warning: extract-import-map: Package.swift at ${join(projectRoot, p)} failed ` +
        `to read (${err.message}) — Swift module imports may not resolve\n`,
      );
      continue;
    }
    const packageDir = dirOf(p);
    for (const target of parseSwiftPackageTargets(raw)) {
      const targetPath = resolveRelative(packageDir, target.path.replace(/\\/g, '/'));
      if (!targetPath) continue;
      if (!targets.has(target.name)) targets.set(target.name, new Set());
      targets.get(target.name).add(targetPath);
    }
  }

  return { targets, warnings, failures };
}

/**
 * Walk up from `startDir` (project-relative POSIX, '' for project root)
 * and return the DEEPEST ancestor directory that exists as a key in
 * `configMap`, or undefined if no ancestor matches.
 *
 * Determinism: ancestors are inspected from deepest to shallowest, so the
 * deepest match is always picked. This matches the way TS/JS / PHP / Go
 * tools resolve nearest config in the wild ("nearest enclosing").
 *
 * Defensive note: if multiple distinct keys somehow share a depth (cannot
 * happen with proper directory paths, but a malformed input could), the
 * caller is expected to have normalized the keys. We do not re-sort here
 * because the iteration order is determined by depth alone.
 */
function findNearestConfigDir(startDir, configMap) {
  if (configMap.size === 0) return undefined;
  // Walk ancestors from the importer's directory up to the project root.
  // Slicing the parts array gives every prefix; we test each from longest
  // to shortest so the deepest match wins.
  const parts = startDir ? startDir.split('/').filter(Boolean) : [];
  for (let i = parts.length; i >= 0; i--) {
    const ancestor = parts.slice(0, i).join('/');
    if (configMap.has(ancestor)) return ancestor;
  }
  return undefined;
}

/**
 * Resolution context shared across all per-file resolver calls. Holds:
 *  - fileSet: Set<string> of every input file's posix path
 *  - tsConfigs: Map<dir, { baseUrl, paths, pathsBase }> of the effective
 *    (`extends`-merged) settings of every tsconfig.json / jsconfig.json in
 *    `files[]`. Per-import resolution walks up from the importer through the
 *    enclosing configs.
 *  - workspacePackages: Map<packageName, { dir, manifest }> for pnpm/npm/yarn
 *    workspace members.
 *  - goModules: Map<dir, moduleName> from every go.mod in `files[]`.
 *  - phpAutoloads: Map<dir, autoloadMap> from every composer.json in
 *    `files[]`. Resolved paths are anchored at the composer's directory.
 *  - goFilesByDir: Map<dir, string[]> of .go files per directory (built
 *    once so Go's package-level import dispatch doesn't re-scan the file
 *    set per import).
 *
 * Build once; pass everywhere.
 */
async function buildResolutionContext(projectRoot, files) {
  const fileSet = new Set(files.map(f => toPosix(f.path)));

  // These config-loader passes are independent and each does its own
  // batched parallel I/O; run them concurrently so the wait for a slow
  // tsconfig.json read doesn't block go.mod / composer.json / SwiftPM scanning.
  //
  // Each loader BUFFERS warnings into a private array rather than writing
  // them to stderr inline. If a loader streamed warnings directly during
  // the concurrent passes, lines from independent loader families could
  // interleave based on I/O timing — that would break the pre-PR
  // deterministic order (ts → go → php → swift) and make stderr-diff verification
  // flaky. Drain the buffers in canonical order *after* Promise.all, so
  // a fixture with `(malformed tsconfig.json, malformed composer.json)`
  // always emits `tsconfig…\ncomposer…\n`, never the reverse.
  const [tsResult, goResult, phpResult, swiftResult, workspaceResult] = await Promise.all([
    loadTsConfigs(projectRoot, files),
    loadGoModules(projectRoot, files),
    loadPhpAutoloads(projectRoot, files),
    loadSwiftPackageTargets(projectRoot, files),
    loadWorkspacePackages(projectRoot, files),
  ]);
  for (const w of tsResult.warnings) process.stderr.write(w);
  for (const w of workspaceResult.warnings) process.stderr.write(w);
  for (const w of goResult.warnings) process.stderr.write(w);
  for (const w of phpResult.warnings) process.stderr.write(w);
  for (const w of swiftResult.warnings) process.stderr.write(w);
  const tsConfigs = tsResult.configs;
  const goModules = goResult.modules;
  const phpAutoloads = phpResult.autoloads;

  // Index .go files by their parent directory so the Go resolver can
  // expand a package-level import to all member .go files in O(1).
  const goFilesByDir = new Map();
  for (const f of files) {
    if (!f.path.endsWith('.go')) continue;
    const p = toPosix(f.path);
    const d = dirOf(p);
    if (!goFilesByDir.has(d)) goFilesByDir.set(d, []);
    goFilesByDir.get(d).push(p);
  }
  for (const arr of goFilesByDir.values()) {
    arr.sort(comparePaths);
  }

  // Build per-extension suffix indices for dotted-FQN resolvers (Java,
  // Kotlin, Scala, C#). Indexed once; reused for every import dispatch.
  const javaIndex = buildSuffixIndex(files, p => p.endsWith('.java'));
  const kotlinIndex = buildSuffixIndex(files, p => p.endsWith('.kt'));
  const scalaFilePredicate = p => p.endsWith('.scala') || p.endsWith('.sc');
  const scalaIndex = buildSuffixIndex(files, scalaFilePredicate);
  const scalaPackageIndex = buildPackageIndex(files, scalaFilePredicate);
  const csIndex = buildSuffixIndex(files, p => p.endsWith('.cs'));
  const swiftModuleIndex = buildSwiftModuleIndex(files, swiftResult.targets);

  return {
    projectRoot,
    fileSet,
    tsConfigs,
    workspacePackages: workspaceResult.packages,
    goModules,
    goFilesByDir,
    javaIndex,
    kotlinIndex,
    scalaIndex,
    scalaPackageIndex,
    csIndex,
    swiftModuleIndex,
    failures: [
      ...tsResult.failures,
      ...workspaceResult.failures,
      ...goResult.failures,
      ...phpResult.failures,
      ...swiftResult.failures,
    ],
    phpAutoloads,
    // Dedupe Sets for one-time-per-file warnings. Keyed by importer file
    // path. Mutated by resolvers.
    _warnedNoRustCrateRoot: new Set(),
    _warnedNoGoModule: new Set(),
  };
}

// ---------------------------------------------------------------------------
// TypeScript / JavaScript resolver
//
// Handles:
//   - Relative imports: `import x from './foo'` -> `<dir>/foo` + ext probes
//   - tsconfig path aliases: `import x from '@/foo'` -> `<baseUrl>/<target>/foo`
//
// `imp.source` from tree-sitter is the literal string content of the import
// path (no quotes). We don't need to redo the regex work — we just classify
// the source string and dispatch.
// ---------------------------------------------------------------------------

// Extensions probed when the import has no extension. The order mirrors the
// historical project-scanner prose so behavior matches existing fixtures.
const TS_EXT_PROBES = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '/index.ts', '/index.tsx', '/index.js', '/index.jsx',
];

/**
 * NodeNext / Node16 / Bundler-with-explicit-extensions ESM TypeScript convention:
 * TypeScript does NOT rewrite import specifiers during compilation, so source
 * files import their COMPILED specifier (`./config.js`) even when only
 * `./config.ts` exists on disk. We map each compiled-output extension to the
 * TS source extensions that could have produced it, in priority order.
 *
 * Without this rewrite, ESM-TS projects (which is now the default for any new
 * TS project) end up with a near-edgeless knowledge graph because every
 * project-internal import fails to resolve. (#294)
 */
const NODENEXT_REWRITES = {
  '.js': ['.ts', '.tsx', '.js', '.jsx'],
  '.jsx': ['.tsx', '.jsx'],
  '.mjs': ['.mts', '.mjs', '.ts'],
  '.cjs': ['.cts', '.cjs', '.ts'],
};

/**
 * Try ext probes against the file set for the given base path. Returns the
 * first matching project-relative path, or null. If the base path already has
 * a code extension AND exists in the file set, returns it directly.
 *
 * For NodeNext-style imports (`./foo.js` where only `./foo.ts` exists), apply
 * the source-extension rewrite — see NODENEXT_REWRITES above.
 */
function probeWithExtensions(basePath, fileSet) {
  if (!basePath) return null;
  // Exact match (import already had an extension that resolves on disk)
  if (fileSet.has(basePath)) return basePath;

  // NodeNext rewrite: if the basePath ends with a compiled-output extension
  // but no such file exists, try the corresponding source extensions. We do
  // this BEFORE the legacy "append extensions" loop because for an import
  // like `./foo.js`, appending `.ts` would produce `foo.js.ts` (always wrong)
  // while the correct candidate is `foo.ts`.
  for (const [outExt, srcExts] of Object.entries(NODENEXT_REWRITES)) {
    if (!basePath.endsWith(outExt)) continue;
    const stem = basePath.slice(0, -outExt.length);
    for (const srcExt of srcExts) {
      const candidate = stem + srcExt;
      if (fileSet.has(candidate)) return candidate;
    }
    // The basePath had an explicit compiled extension — don't fall through
    // to the "append extensions" loop, which would produce nonsense like
    // `foo.js.ts`. If NodeNext rewrite didn't find anything, return null.
    return null;
  }

  for (const ext of TS_EXT_PROBES) {
    const candidate = basePath + ext;
    if (fileSet.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve a bare specifier through ONE effective tsconfig/jsconfig: `paths`
 * aliases first, then (when a baseUrl is in effect) a baseUrl-relative lookup.
 * Alias targets are anchored at baseUrl when set, otherwise at the directory of
 * the config that declared `paths`.
 */
function resolveViaTsConfig(src, config, ctx) {
  const { baseUrl, paths, pathsBase } = config;
  const anchor = baseUrl !== undefined ? baseUrl : (pathsBase ?? '');
  if (paths && paths.size > 0) {
    for (const [alias, targets] of paths) {
      const aliasMatch = matchTsAlias(alias, src);
      if (aliasMatch === null) continue;
      for (const target of targets) {
        const mapped = applyTsAlias(target, aliasMatch);
        // posix.normalize strips a leading "./" left over when both the anchor
        // and the target start at the project root (root tsconfig with
        // `"@/*": ["./*"]`, the create-next-app default). Without this the
        // candidate stays as "./foo" while ctx.fileSet stores "foo", and
        // probeWithExtensions silently drops every cross-module edge.
        const candidate = mapped.startsWith(ROOT_RELATIVE_MARK)
          ? posix.normalize(mapped.slice(ROOT_RELATIVE_MARK.length))
          : posix.normalize(anchor ? posix.join(anchor, mapped) : mapped);
        // Defensive: alias targets shouldn't escape the project root.
        if (candidate.startsWith('..')) continue;
        const probed = probeWithExtensions(candidate, ctx.fileSet);
        if (probed) return probed;
      }
    }
  }
  if (baseUrl !== undefined) {
    // Non-relative imports are also looked up relative to baseUrl
    // (`baseUrl: "src"` makes `import 'utils/math'` mean `src/utils/math`).
    const candidate = posix.normalize(baseUrl ? posix.join(baseUrl, src) : src);
    if (!candidate.startsWith('..')) {
      const probed = probeWithExtensions(candidate, ctx.fileSet);
      if (probed) return probed;
    }
  }
  return null;
}

// Output directories whose contents are built from `src/` (package.json
// `main: ./dist/index.js` -> source `src/index.ts`).
const BUILD_OUTPUT_DIR_RE = /^(?:dist|lib|build|out|esm|cjs|types)\/(.*)$/;

/** Collect every string leaf of a package.json `exports` value, in key order. */
function collectExportTargets(value, out, wildcard = '', depth = 0) {
  if (depth > 8 || value === null || value === undefined) return;
  if (typeof value === 'string') {
    out.push(applyTsAlias(value, wildcard));
  } else if (Array.isArray(value)) {
    for (const item of value) collectExportTargets(item, out, wildcard, depth + 1);
  } else if (typeof value === 'object') {
    for (const key of Object.keys(value)) collectExportTargets(value[key], out, wildcard, depth + 1);
  }
}

/** Package-relative entry candidates for `<name>` (sub === '') or `<name>/<sub>`. */
function workspaceEntryCandidates(manifest, sub) {
  const out = [];
  const exportsField = manifest.exports;
  if (exportsField !== undefined && exportsField !== null) {
    const isSubpathMap = typeof exportsField === 'object'
      && !Array.isArray(exportsField)
      && Object.keys(exportsField).some(key => key.startsWith('.'));
    const subpath = sub ? `./${sub}` : '.';
    if (isSubpathMap) {
      if (Object.hasOwn(exportsField, subpath)) {
        collectExportTargets(exportsField[subpath], out);
      } else {
        for (const key of Object.keys(exportsField)) {
          if (!key.includes('*')) continue;
          const wildcard = matchTsAlias(key, subpath);
          if (wildcard !== null) collectExportTargets(exportsField[key], out, wildcard);
        }
      }
    } else if (!sub) {
      collectExportTargets(exportsField, out);
    }
  }
  if (sub) {
    out.push(sub, `src/${sub}`);
  } else {
    for (const field of ['module', 'main', 'types', 'typings']) {
      if (typeof manifest[field] === 'string') out.push(manifest[field]);
    }
    out.push('src/index', 'index');
  }
  return out;
}

/**
 * Resolve an import of a workspace package name (`@acme/ui`, `@acme/ui/button`)
 * to a source file in the inventory. Entry points usually name build output
 * (`./dist/index.js`, `./dist/index.d.ts`) that is not in the inventory, so
 * each candidate is also tried against `src/`.
 */
function resolveWorkspaceImport(src, ctx) {
  const workspace = ctx.workspacePackages;
  if (!workspace || workspace.size === 0) return null;
  const parts = src.split('/');
  const nameLength = src.startsWith('@') ? 2 : 1;
  if (parts.length < nameLength || parts.slice(0, nameLength).some(part => !part)) return null;
  const pkg = workspace.get(parts.slice(0, nameLength).join('/'));
  if (!pkg) return null;

  for (const entry of workspaceEntryCandidates(pkg.manifest, parts.slice(nameLength).join('/'))) {
    const entryPath = entry.replace(/^\.\//, '');
    const variants = [entryPath];
    const built = entryPath.match(BUILD_OUTPUT_DIR_RE);
    if (built) variants.push(`src/${built[1]}`);
    for (const variant of variants) {
      // `index.d.ts` declares `index.ts`; probe the extensionless stem.
      const stems = [variant];
      if (/\.d\.[mc]?ts$/.test(variant)) stems.push(variant.replace(/\.d\.[mc]?ts$/, ''));
      for (const stem of stems) {
        const candidate = posix.normalize(pkg.dir ? posix.join(pkg.dir, stem) : stem);
        if (candidate.startsWith('..')) continue;
        const probed = probeWithExtensions(candidate, ctx.fileSet);
        if (probed) return probed;
      }
    }
  }
  return null;
}

/**
 * Resolve a TypeScript / JavaScript import. Returns project-relative resolved
 * path or null. External packages return null.
 *
 * Bare specifiers are tried against the importer's tsconfig.json/jsconfig.json
 * (with `extends` already merged by loadTsConfigs), walking from the nearest
 * enclosing config up to the project root: a nearer config that declares no
 * alias must not hide an ancestor's. Then workspace package names (pnpm/npm/
 * yarn workspaces) resolve to the package's entry.
 */
export function resolveTsJsImport(rawImport, file, ctx) {
  if (!rawImport || typeof rawImport !== 'string') return null;
  const src = rawImport.trim();
  if (!src) return null;

  const importerDir = dirOf(toPosix(file.path));

  // Relative imports: ./foo, ../foo — tsconfig has no bearing here.
  if (src.startsWith('./') || src.startsWith('../')) {
    const base = resolveRelative(importerDir, src);
    return probeWithExtensions(base, ctx.fileSet);
  }

  const parts = importerDir ? importerDir.split('/').filter(Boolean) : [];
  for (let i = parts.length; i >= 0; i--) {
    const config = ctx.tsConfigs.get(parts.slice(0, i).join('/'));
    if (!config) continue;
    const resolved = resolveViaTsConfig(src, config, ctx);
    if (resolved) return resolved;
  }

  return resolveWorkspaceImport(src, ctx);
}

/**
 * Match an import against a tsconfig paths alias. Aliases use `*` as a single
 * wildcard, e.g. `"@/*"` matches `"@/foo/bar"` with the wildcard = "foo/bar".
 * Aliases without `*` must match exactly. Returns the wildcard content
 * (possibly '') on match, null on no match.
 */
function matchTsAlias(alias, src) {
  const starIdx = alias.indexOf('*');
  if (starIdx === -1) {
    return src === alias ? '' : null;
  }
  const prefix = alias.slice(0, starIdx);
  const suffix = alias.slice(starIdx + 1);
  if (!src.startsWith(prefix)) return null;
  if (!src.endsWith(suffix)) return null;
  // Avoid double-counting when prefix+suffix length exceeds src length
  if (src.length < prefix.length + suffix.length) return null;
  return src.slice(prefix.length, src.length - suffix.length);
}

/**
 * Substitute the wildcard content into a tsconfig target. Mirror of
 * matchTsAlias — if the target has no `*`, return it as-is (rare, but valid).
 */
function applyTsAlias(target, wildcard) {
  const starIdx = target.indexOf('*');
  if (starIdx === -1) return target;
  return target.slice(0, starIdx) + wildcard + target.slice(starIdx + 1);
}

/**
 * Tree-sitter's TS/JS extractor only records ES module `import` declarations.
 * CommonJS `require('./foo')` is treated as a generic call expression and
 * never enters `analysis.imports`, which would silently drop edges in
 * Node-style codebases. Patch coverage with a focused regex pass on the file
 * content — we only want literal string arguments, so the regex is narrow.
 *
 * Limitations (intentional):
 *   - Computed requires (`require(name)`) are external/dynamic — skipped.
 *   - Template-literal requires are unresolved.
 *   - String concatenation in the argument is unresolved.
 */
const REQUIRE_LITERAL_RE = /\brequire\(\s*(['"])([^'"`\n]+?)\1\s*\)/g;

/**
 * Strip JS/TS line and block comments before running text-pattern matchers.
 * Replaces with spaces (preserving offsets isn't critical here, but keeping
 * roughly the same length avoids surprising the matcher with collapsed
 * whitespace). Does not attempt to honor string contents — that's fine for
 * the narrow patterns we run (`require('...')`, etc.) because the same
 * comment-or-not heuristic applies uniformly to all matched literals.
 */
function stripJsLikeComments(content) {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

function extractRequireSources(content) {
  const sources = [];
  let m;
  const stripped = stripJsLikeComments(content);
  REQUIRE_LITERAL_RE.lastIndex = 0;
  while ((m = REQUIRE_LITERAL_RE.exec(stripped)) !== null) {
    sources.push(m[2]);
  }
  return sources;
}

/**
 * Kotlin has no tree-sitter extractor in this project, so we collect its
 * import sources via a focused regex pass. Kotlin imports are syntactically
 * simple: one per line, `import x.y.Z` or `import x.y.Z as Alias` (or
 * `import x.y.*` for star imports). We capture the dotted FQN and let the
 * dotted resolver classify wildcards.
 *
 * The capture is a strict qualifiedName grammar — a leading identifier
 * followed by zero or more `.identifier` segments and an optional trailing
 * `.*` for star-imports. The looser `[\w.*]+` form previously here would
 * match pathological inputs like `import ...` or `import .foo`.
 */
const KOTLIN_IMPORT_RE =
  /^\s*import\s+(\w+(?:\.\w+)*(?:\.\*)?)(?:\s+as\s+\w+)?\s*$/gm;

function extractKotlinSources(content) {
  const sources = [];
  let m;
  KOTLIN_IMPORT_RE.lastIndex = 0;
  while ((m = KOTLIN_IMPORT_RE.exec(content)) !== null) {
    sources.push(m[1]);
  }
  return sources;
}

// ---------------------------------------------------------------------------
// Python resolver
//
// Tree-sitter's Python extractor emits one entry per import statement:
//   - `import a.b.c`          -> { source: 'a.b.c', specifiers: ['a.b.c'] }
//   - `from a.b.c import x,y` -> { source: 'a.b.c', specifiers: ['x','y'] }
//   - `from . import x`       -> { source: '', specifiers: ['x'] }
//   - `from .x import y`      -> { source: '.x', specifiers: ['y'] }
//   - `from ..pkg import y`   -> { source: '..pkg', specifiers: ['y'] }
//
// We can't tell relative from absolute by the source string alone — the dots
// could be a leading-dot relative source OR a literal `.` package separator.
// Python's lexical convention disambiguates: leading dots ALWAYS mean
// relative. Tree-sitter preserves leading dots verbatim in the source field,
// so we can dispatch on the prefix.
//
// Resolution rules:
//   1. Relative (starts with `.`): walk up parent dirs by leading-dot count,
//      then descend by the remaining dotted segments.
//   2. Absolute (no leading dot): walk up from the importer's directory,
//      trying EACH ancestor as a candidate Python root. The first ancestor
//      under which probing succeeds wins. This matches how multi-service
//      Python repos work in practice — each service directory acts as its
//      own root for unqualified `import sibling` style imports
//      (e.g. microservices-demo's per-service grpc stubs).
//
//      We don't gate this on setup.py / pyproject.toml detection. The
//      probe itself IS the test of whether the ancestor is a candidate
//      root: an absent module just continues the walk. The closest
//      ancestor where the import resolves wins, which gives importer
//      scope precedence (sibling files override remote candidates).
// ---------------------------------------------------------------------------

/**
 * Resolve a Python import. Unlike most resolvers this can produce multiple
 * matches (one for the package `__init__.py` plus one per submodule
 * specifier), so the signature differs: returns string[].
 *
 * Returns empty array for external/unresolved packages.
 */
export function resolvePythonImport(rawImport, specifiers, file, ctx) {
  if (typeof rawImport !== 'string') return [];
  const src = rawImport;
  const importerDir = dirOf(toPosix(file.path));

  // Count leading dots; the rest is a dotted module path
  let dots = 0;
  while (dots < src.length && src.charCodeAt(dots) === 0x2e /* '.' */) dots++;
  const tail = src.slice(dots);
  const tailSegments = tail ? tail.split('.').filter(Boolean) : [];

  if (dots > 0) {
    // Relative import. `from . import x` (dots=1, tail='') walks up zero
    // directories (sibling level); `from .. import x` walks up one.
    // Relative imports are anchored at the importer's package, so we do
    // NOT do the per-root walk-up here — leading dots already encode the
    // exact anchor.
    const importerParts = importerDir ? importerDir.split('/').filter(Boolean) : [];
    const dropLevels = dots - 1;
    if (dropLevels > importerParts.length) {
      // Walked above the project root — unresolvable
      return [];
    }
    const baseParts = importerParts.slice(0, importerParts.length - dropLevels);

    // `from .[..] import x, y` with no dotted tail — specifiers are siblings
    // at `baseParts`. Probe directly without requiring `<baseParts>/__init__.py`
    // to exist: PEP 328 implicit namespace packages are common in modern
    // Python (no `__init__.py`), and `resolvePythonProbe` would otherwise
    // gate specifier resolution on the package marker and drop these imports.
    if (tailSegments.length === 0) {
      if (!Array.isArray(specifiers) || specifiers.length === 0) return [];
      const base = baseParts.join('/');
      const matches = [];
      for (const spec of specifiers) {
        // Wildcard `*` and qualified specifiers (`Foo.bar`) skip; the
        // surface name is what tree-sitter records for `from . import x`.
        if (!spec || spec === '*' || spec.includes('.')) continue;
        const subFile = base ? `${base}/${spec}.py` : `${spec}.py`;
        const subInit = base ? `${base}/${spec}/__init__.py` : `${spec}/__init__.py`;
        if (ctx.fileSet.has(subFile)) matches.push(subFile);
        else if (ctx.fileSet.has(subInit)) matches.push(subInit);
      }
      return matches;
    }

    const moduleParts = baseParts.concat(tailSegments);
    return resolvePythonProbe(moduleParts, specifiers, ctx);
  }

  // Absolute import. Walk up from the importer's directory and try every
  // ancestor as a candidate Python root — the first one where probing
  // resolves anything wins. This handles the multi-service / multi-package
  // case where each service's directory acts as its own implicit
  // sys.path entry (e.g. `import demo_pb2_grpc` from
  // `src/emailservice/email_server.py` should resolve to
  // `src/emailservice/demo_pb2_grpc.py`, NOT fail because the file isn't
  // at `<projectRoot>/demo_pb2_grpc.py`).
  //
  // Importer-scope precedence (deepest ancestor first) means that when
  // the same module name exists in multiple services, each service's
  // file shadows the others — no cross-service edges.
  if (tailSegments.length === 0) {
    // `from . import x` is dots>0 only; reaching here means the source
    // was the empty string. Nothing to probe.
    return [];
  }

  const importerParts = importerDir ? importerDir.split('/').filter(Boolean) : [];
  for (let i = importerParts.length; i >= 0; i--) {
    const rootParts = importerParts.slice(0, i);
    const candidateModule = rootParts.concat(tailSegments);
    const matches = resolvePythonProbe(candidateModule, specifiers, ctx);
    if (matches.length > 0) return matches;
  }
  return [];
}

/**
 * Given a fully-qualified module-path segment list (e.g. ['src','utils']),
 * probe the file set for `a/b/c.py` then `a/b/c/__init__.py`. On package
 * match, also probe each specifier as a submodule. Returns an array of
 * resolved project-relative paths (deduped by Set in caller).
 */
function resolvePythonProbe(moduleParts, specifiers, ctx) {
  if (moduleParts.length === 0) {
    // `from . import x` case: importer's package is the implicit module;
    // each x is a sibling module to probe directly.
    return [];
  }
  const base = moduleParts.join('/');
  const matches = [];

  const moduleFile = `${base}.py`;
  const packageInit = `${base}/__init__.py`;

  if (ctx.fileSet.has(moduleFile)) {
    matches.push(moduleFile);
    return matches; // No further probing on a leaf module file.
  }
  if (ctx.fileSet.has(packageInit)) {
    matches.push(packageInit);
    // Package match: probe each specifier as a submodule
    if (Array.isArray(specifiers)) {
      for (const spec of specifiers) {
        // Wildcard `*` and qualified specifiers (`Foo.bar`) skip; the
        // surface name is what tree-sitter records for `from pkg import x`.
        if (!spec || spec === '*' || spec.includes('.')) continue;
        const subFile = `${base}/${spec}.py`;
        const subInit = `${base}/${spec}/__init__.py`;
        if (ctx.fileSet.has(subFile)) matches.push(subFile);
        else if (ctx.fileSet.has(subInit)) matches.push(subInit);
      }
    }
    return matches;
  }

  // No match — external package.
  return [];
}

// ---------------------------------------------------------------------------
// Go resolver
//
// Tree-sitter's Go extractor emits the literal import path (without quotes).
// Resolution: walk up from the importer's directory to find the nearest
// enclosing `go.mod` (multi-module monorepos are the norm). Strip that
// module's prefix; the remainder maps to a directory RELATIVE TO THAT
// MODULE'S DIRECTORY in the project. Go imports are package-level (not
// file-level), so a single `import "github.com/foo/bar/util"` produces edges
// to every .go file inside that module's `util/`.
//
// Cross-module imports (`github.com/foo/bar/X` from a file under a module
// that declares `github.com/foo/baz`) are correctly classified as external —
// they refer to a different Go module, which from this module's perspective
// is a third-party dependency.
//
// Inputs:
//   - rawImport: 'github.com/foo/bar/util' (no quotes)
//   - file.path: importer's project-relative path
//   - ctx.goModules: Map<dir, moduleName> of every go.mod discovered.
//
// Result: array of every `<moduleDir>/util/*.go` path in the project
// (deduped by caller).
// ---------------------------------------------------------------------------

export function resolveGoImport(rawImport, file, ctx) {
  if (!rawImport || typeof rawImport !== 'string') return [];
  const src = rawImport.trim();
  if (!src) return [];

  const importerPath = toPosix(file.path);
  const importerDir = dirOf(importerPath);

  const nearestModuleDir = findNearestConfigDir(importerDir, ctx.goModules);
  if (nearestModuleDir === undefined) {
    // Warn once per importer file — a single .go file can import several
    // module-prefixed paths, so suppress duplicates.
    if (!ctx._warnedNoGoModule.has(importerPath)) {
      ctx._warnedNoGoModule.add(importerPath);
      process.stderr.write(
        `Warning: extract-import-map: Go file ${importerPath} has no ` +
        `ancestor go.mod — import ${src} unresolvable — module-prefix ` +
        `imports skipped\n`,
      );
    }
    return [];
  }

  const moduleName = ctx.goModules.get(nearestModuleDir);

  // Strip module prefix; require a `/` boundary so 'githubXcom...' does not
  // accidentally match 'github.com...'.
  let remainder;
  if (src === moduleName) {
    remainder = '';
  } else if (src.startsWith(moduleName + '/')) {
    remainder = src.slice(moduleName.length + 1);
  } else {
    // External package (stdlib, 3rd-party module, OR a different in-tree
    // module — the latter is intentional: from this module's perspective,
    // a sibling module is an external dependency).
    return [];
  }

  // Map to a directory in the project (POSIX style). Anchor at the module's
  // own directory, so a sub-module's `<module>/sub` resolves under that
  // module's tree rather than under project root.
  const subDir = toPosix(remainder);
  const targetDir = nearestModuleDir
    ? (subDir ? `${nearestModuleDir}/${subDir}` : nearestModuleDir)
    : subDir;
  const files = ctx.goFilesByDir.get(targetDir);
  return files ? [...files] : [];
}

// ---------------------------------------------------------------------------
// Dotted-package resolver (Java / Kotlin / C#)
//
// Shared logic: an import like `com.example.foo.Bar` maps to a file
// `**/com/example/foo/Bar.<ext>` in the project. Many JVM/CLR projects nest
// sources under `src/main/java/`, `src/main/kotlin/`, etc., so the resolver
// must search for any file whose suffix matches the dotted-path-as-file form.
//
// We pre-build an index: trailing-slash-suffix -> matching project paths.
// Indexing once is O(files * average_segments); per-import lookup is then
// effectively O(1) hash lookup + scan of the bucket.
// ---------------------------------------------------------------------------

/**
 * Build an index of all files for a given extension, keyed by their
 * "package-path suffix" form. For each file `src/main/java/com/x/Y.java`,
 * the index gets entries for every suffix that ends at a `/`:
 *   - 'com/x/Y.java'
 *   - 'x/Y.java'
 *   - 'Y.java'
 * keyed off each successively-shorter suffix.
 *
 * Using a Map<suffix, string[]> avoids per-import full table scans; a 50K-file
 * monorepo with deep package nesting still resolves O(1) per import.
 */
function buildSuffixIndex(files, extPredicate) {
  const idx = new Map();
  for (const f of files) {
    const p = toPosix(f.path);
    if (!extPredicate(p)) continue;
    // Generate every "directory-bounded suffix" of the path
    const parts = p.split('/');
    for (let i = 0; i < parts.length; i++) {
      const suffix = parts.slice(i).join('/');
      if (!idx.has(suffix)) idx.set(suffix, []);
      idx.get(suffix).push(p);
    }
  }
  // Deterministic order within each bucket
  for (const arr of idx.values()) {
    arr.sort(comparePaths);
  }
  return idx;
}

function buildPackageIndex(files, extPredicate) {
  const idx = new Map();
  for (const f of files) {
    const p = toPosix(f.path);
    if (!extPredicate(p)) continue;
    const dir = dirOf(p);
    if (!dir) continue;

    const parts = dir.split('/');
    for (let i = 0; i < parts.length; i++) {
      const suffix = parts.slice(i).join('/');
      if (!idx.has(suffix)) idx.set(suffix, []);
      idx.get(suffix).push(p);
    }
  }
  for (const arr of idx.values()) {
    arr.sort(comparePaths);
  }
  return idx;
}

const SWIFT_SOURCE_ROOT_DIRS = new Set(['source', 'sources', 'test', 'tests']);
const SWIFT_MODULE_CONTAINER_DIRS = new Set([
  'framework',
  'frameworks',
  'library',
  'libraries',
  'module',
  'modules',
]);

function addSwiftModuleFile(index, moduleName, filePath) {
  if (!moduleName) return;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(moduleName)) return;
  if (!index.has(moduleName)) index.set(moduleName, new Set());
  index.get(moduleName).add(filePath);
}

function inferSwiftModulesFromPath(filePath) {
  const parts = filePath.split('/');
  const dirs = parts.slice(0, -1);
  const modules = new Set();

  for (let i = 0; i < dirs.length - 1; i++) {
    const lower = dirs[i].toLowerCase();
    if (
      SWIFT_SOURCE_ROOT_DIRS.has(lower) ||
      SWIFT_MODULE_CONTAINER_DIRS.has(lower)
    ) {
      modules.add(dirs[i + 1]);
    }
  }

  if (dirs.length > 0 && !SWIFT_SOURCE_ROOT_DIRS.has(dirs[0].toLowerCase())) {
    modules.add(dirs[0]);
  }

  return modules;
}

/**
 * Build a Swift module-name -> files index.
 *
 * Swift files in the same module do not import each other by relative path;
 * `import Foo` imports a module. We therefore resolve to every project Swift
 * file that belongs to module `Foo`, mirroring the Go resolver's package-level
 * expansion. The index combines SwiftPM manifest targets with common on-disk
 * conventions (`Sources/Foo`, `Tests/FooTests`, and top-level Xcode groups).
 */
function buildSwiftModuleIndex(files, packageTargets) {
  const idx = new Map();
  const targetEntries = [...packageTargets.entries()].map(([name, paths]) => [
    name,
    [...paths].sort(comparePaths),
  ]);

  for (const f of files) {
    const p = toPosix(f.path);
    if (!p.endsWith('.swift')) continue;
    if (p.endsWith('/Package.swift') || p === 'Package.swift') continue;

    for (const [moduleName, targetPaths] of targetEntries) {
      for (const targetPath of targetPaths) {
        if (p === targetPath || p.startsWith(`${targetPath}/`)) {
          addSwiftModuleFile(idx, moduleName, p);
        }
      }
    }

    for (const moduleName of inferSwiftModulesFromPath(p)) {
      addSwiftModuleFile(idx, moduleName, p);
    }
  }

  const out = new Map();
  for (const [moduleName, paths] of idx.entries()) {
    out.set(moduleName, [...paths].sort(comparePaths));
  }
  return out;
}

/**
 * Resolve a dotted-import to a file. `fqn` is the qualified name
 * (`com.example.Foo`); `ext` is the file extension to probe (`.java`,
 * `.kt`, `.cs`). Wildcards (e.g. `com.example.*`) and the trailing `*` in
 * Java's `com.example.*` are stripped before resolution — there is no good
 * single-file resolution for wildcards, so we drop them. (Tree-sitter
 * already exposes `*` as a specifier; the source field strips it.)
 *
 * Returns array (most cases: 0 or 1 match; multiple if the same suffix
 * appears in multiple source roots).
 */
function resolveDottedFqn(fqn, ext, suffixIndex) {
  if (!fqn || typeof fqn !== 'string') return [];
  // Strip trailing wildcard segments like `com.example.*`
  const trimmed = fqn.replace(/\.\*$/, '');
  if (!trimmed) return [];
  const filePart = trimmed.replace(/\./g, '/') + ext;
  const matches = suffixIndex.get(filePart);
  return matches ? [...matches] : [];
}

// ---------------------------------------------------------------------------
// Java resolver
// ---------------------------------------------------------------------------

export function resolveJavaImport(rawImport, _file, ctx) {
  return resolveDottedFqn(rawImport, '.java', ctx.javaIndex);
}

// ---------------------------------------------------------------------------
// Kotlin resolver
//
// Kotlin has no tree-sitter extractor in this project, so its import sources
// are collected via a focused regex pass in extractExtraImportSources(); the
// resolver itself is identical-shape to Java.
// ---------------------------------------------------------------------------

export function resolveKotlinImport(rawImport, _file, ctx) {
  return resolveDottedFqn(rawImport, '.kt', ctx.kotlinIndex);
}

// ---------------------------------------------------------------------------
// Scala resolver
//
// Scala imports come from the core ScalaExtractor in three shapes:
//   - plain:    `import com.example.Foo`      -> source='com.example.Foo',
//                                                specifiers=['Foo']
//   - selector: `import com.example.{A, B}`   -> source='com.example',
//                                                specifiers=['A', 'B']
//   - wildcard: `import com.example._` / `.*` -> source='com.example',
//                                                specifiers=['*']
//
// The plain source resolves like Java (`com/example/Foo.scala` suffix probe).
// Selector lists probe each specifier under the source package. Scala also
// allows package objects (`com/example/package.scala`) to hold members, so
// the package prefix is additionally probed against `<pkg>/package.scala`.
// Multi-type files (a `model.scala` holding many case classes) can't be
// resolved by name probing — same accepted limitation as Java/Kotlin/C#.
// ---------------------------------------------------------------------------

export function resolveScalaImport(rawImport, specifiers, _file, ctx) {
  const out = new Set();
  const specs = Array.isArray(specifiers) ? specifiers : [];
  const isPlain =
    specs.length === 1 &&
    specs[0] &&
    specs[0] !== '*' &&
    rawImport.endsWith(`.${specs[0]}`);

  if (specs.includes('*')) {
    for (const m of resolveScalaPackage(rawImport, ctx)) out.add(m);
    return [...out].sort(comparePaths);
  }

  if (isPlain) {
    for (const m of resolveScalaDottedFqn(rawImport, ctx)) out.add(m);
    if (out.size === 0) {
      const pkg = rawImport.slice(0, -(specs[0].length + 1));
      for (const m of resolveScalaDottedFqn(`${pkg}.package`, ctx)) out.add(m);
    }
    return [...out].sort(comparePaths);
  }

  let unresolvedSelector = false;
  for (const spec of specs) {
    if (!spec) continue;
    const matches = resolveScalaDottedFqn(`${rawImport}.${spec}`, ctx);
    if (matches.length === 0) unresolvedSelector = true;
    for (const m of matches) out.add(m);
  }

  if (unresolvedSelector) {
    for (const m of resolveScalaDottedFqn(`${rawImport}.package`, ctx)) out.add(m);
  }

  return [...out].sort(comparePaths);
}

function resolveScalaDottedFqn(fqn, ctx) {
  return [
    ...resolveDottedFqn(fqn, '.scala', ctx.scalaIndex),
    ...resolveDottedFqn(fqn, '.sc', ctx.scalaIndex),
  ];
}

function resolveScalaPackage(pkg, ctx) {
  if (!pkg || typeof pkg !== 'string') return [];
  const dirPart = pkg.replace(/\.\*$/, '').replace(/\./g, '/');
  const matches = ctx.scalaPackageIndex.get(dirPart);
  return matches ? [...matches].sort(compareScalaPackageMembers) : [];
}

function compareScalaPackageMembers(a, b) {
  const aPackage = /\/package\.s(?:cala|c)$/.test(a);
  const bPackage = /\/package\.s(?:cala|c)$/.test(b);
  if (dirOf(a) === dirOf(b) && aPackage !== bPackage) return aPackage ? 1 : -1;
  return comparePaths(a, b);
}

// ---------------------------------------------------------------------------
// C# resolver
//
// C# `using Foo.Bar;` declarations are typically NAMESPACES, not files, and
// the C# convention is namespace = directory (loose). Tree-sitter's C#
// extractor captures these as imports with the dotted source. We probe the
// dotted path against the .cs index the same way Java/Kotlin do.
// ---------------------------------------------------------------------------

export function resolveCSharpImport(rawImport, _file, ctx) {
  return resolveDottedFqn(rawImport, '.cs', ctx.csIndex);
}

// ---------------------------------------------------------------------------
// Swift resolver
//
// Swift imports modules, not files. `SwiftExtractor` reports the module part
// as `imp.source` for both `import Foo` and qualified forms such as
// `import struct Foo.Bar`. If a project module named Foo exists in the Swift
// module index, map the import to all Swift files in that module.
// ---------------------------------------------------------------------------

function normalizeSwiftModuleName(rawImport) {
  if (!rawImport || typeof rawImport !== 'string') return null;
  const moduleName = rawImport.trim().split('.')[0];
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(moduleName) ? moduleName : null;
}

export function resolveSwiftImport(rawImport, file, ctx) {
  const moduleName = normalizeSwiftModuleName(rawImport);
  if (!moduleName) return [];
  const matches = ctx.swiftModuleIndex.get(moduleName);
  if (!matches) return [];
  const importer = toPosix(file.path);
  return matches.filter(p => p !== importer);
}

// ---------------------------------------------------------------------------
// Ruby resolver
//
// Two distinct Ruby import forms, with different resolution semantics:
//   - `require_relative 'foo'`  -> resolve against the importer's directory,
//                                  append .rb
//   - `require 'foo/bar'`       -> load-path probe: lib/foo/bar.rb,
//                                  app/foo/bar.rb, or foo/bar.rb (whichever
//                                  exists)
//
// Tree-sitter's Ruby extractor uses a single `imports` field for both forms
// and drops the method name, so we cannot tell them apart from the
// extractor output alone. Instead we use a regex pass on the file content,
// which preserves the method name as the discriminator.
//
// The two forms are unambiguous in source — both start with the method name
// followed by a quoted argument — so a focused regex is reliable.
// ---------------------------------------------------------------------------

const RUBY_REQUIRE_RE =
  /\b(require_relative|require)\s*\(?\s*(['"])([^'"`\n]+?)\2/g;

/**
 * Strip Ruby line comments (`# ...` to end of line) before running the
 * require regex. Ruby has no block comments at this scope (=begin/=end
 * exists but is rare; tree-sitter would normally handle that). Like the JS
 * stripper, this doesn't try to honor string contents — it's a heuristic.
 */
function stripRubyComments(content) {
  return content.replace(/#[^\n]*/g, '');
}

/**
 * Return [{ kind: 'relative'|'absolute', source }] for every require /
 * require_relative call in a Ruby file.
 */
function parseRubyImports(content) {
  const out = [];
  let m;
  const stripped = stripRubyComments(content);
  RUBY_REQUIRE_RE.lastIndex = 0;
  while ((m = RUBY_REQUIRE_RE.exec(stripped)) !== null) {
    out.push({
      kind: m[1] === 'require_relative' ? 'relative' : 'absolute',
      source: m[3],
    });
  }
  return out;
}

/**
 * Resolve a single Ruby require. Returns array (0 or 1 match).
 *
 * For require_relative: append `.rb` if missing, resolve against importer dir.
 * For require: probe lib/<src>.rb, app/<src>.rb, <src>.rb.
 */
export function resolveRubyImport({ kind, source }, file, ctx) {
  if (!source) return [];
  const importerDir = dirOf(toPosix(file.path));
  const withExt = source.endsWith('.rb') ? source : source + '.rb';

  if (kind === 'relative') {
    const base = resolveRelative(importerDir, withExt);
    return ctx.fileSet.has(base) ? [base] : [];
  }

  // Load-path probe order
  const probes = [`lib/${withExt}`, `app/${withExt}`, withExt];
  for (const p of probes) {
    if (ctx.fileSet.has(p)) return [p];
  }
  return [];
}

// ---------------------------------------------------------------------------
// PHP resolver
//
// PHP's `use Vendor\Pkg\Class;` is namespace-based. Composer's PSR-4
// autoload map (`composer.json` -> autoload.psr-4) declares which directory
// holds the files for each namespace prefix, e.g.:
//   { "App\\": "src/" }  means App\Foo\Bar lives at src/Foo/Bar.php
//
// Resolution:
//   1. Find the longest matching autoload prefix.
//   2. Strip that prefix from the FQN.
//   3. Translate backslashes to forward slashes.
//   4. Append `.php` and probe the file set.
//
// Imports whose namespace is not declared in any autoload entry are
// external — dropped.
// ---------------------------------------------------------------------------

/**
 * Parse a single composer.json content and return Map<namespacePrefix,
 * dir[]> or null if the JSON failed to parse. The returned dirs are
 * relative to the composer.json's own directory — NOT projectRoot —
 * matching how PSR-4 itself is specified.
 *
 * Returning `null` (rather than throwing) lets the caller emit a Warning:
 * with the exact composer.json path that failed; bubbling the error would
 * conceal which file was at fault when many composer.json files are loaded.
 */
function parseComposerAutoloadText(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const out = new Map();
  const psr4 = parsed?.autoload?.['psr-4'];
  if (!psr4 || typeof psr4 !== 'object') return out;
  for (const [prefix, target] of Object.entries(psr4)) {
    const targets = Array.isArray(target) ? target : [target];
    // Normalize each dir to posix, strip leading `./`, strip trailing `/`
    const normalized = targets
      .filter(t => typeof t === 'string')
      .map(t => toPosix(t).replace(/\/$/, ''));
    // Ensure non-empty prefixes end with a backslash so the
    // longest-prefix-match does not accidentally split mid-segment
    // ("App" vs "Application"). Preserve the empty prefix as-is — it's
    // Composer's fallback mapping (`"psr-4": {"": "src/"}`) and means
    // "any namespace resolves under this dir". Appending `\` would
    // convert it into a prefix that matches nothing.
    const normalizedPrefix = prefix === '' || prefix.endsWith('\\') ? prefix : prefix + '\\';
    out.set(normalizedPrefix, normalized);
  }
  return out;
}

/**
 * Load every `composer.json` discovered in the input file list and parse
 * each's `autoload.psr-4` section. Returns Map<dirPath, autoloadMap>
 * keyed by the project-relative POSIX directory containing the
 * composer.json (empty string for a root-level composer.json).
 *
 * WHY plural: Composer monorepos commonly stack a root composer.json over
 * per-package composer.json files (one of the two formal "monorepo"
 * patterns Composer documents — `wikimedia/composer-merge-plugin` and
 * `symplify/monorepo-builder` both ship this layout). Loading only the
 * root would miss package-scoped PSR-4 entries entirely.
 *
 * On parse failure for a specific composer.json, emits a Warning: pointing
 * at the bad file and skips it. The rest of the project's PHP imports keep
 * resolving via whichever composer.json files parsed cleanly.
 */
async function loadPhpAutoloads(projectRoot, files) {
  const out = new Map();
  const warnings = [];
  const failures = [];
  const candidates = [];
  for (const f of files) {
    const p = toPosix(f.path);
    const base = p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p;
    if (base !== 'composer.json') continue;
    const absPath = join(projectRoot, p);
    if (!existsSync(absPath)) continue;
    candidates.push({ key: p, absPath });
  }
  const reads = await readFilesParallel(candidates);
  for (const { key: p, raw, err } of reads) {
    if (err) {
      failures.push({ path: p, stage: 'resolver-config-read', message: err.message });
      warnings.push(
        `Warning: extract-import-map: composer.json at ${join(projectRoot, p)} failed ` +
        `to read (${err.message}) — PSR-4 namespace mapping from this ` +
        `composer.json unavailable — PHP imports under this package ` +
        `will not resolve\n`,
      );
      continue;
    }
    const parsed = parseComposerAutoloadText(raw);
    if (parsed === null) {
      failures.push({
        path: p,
        stage: 'resolver-config-parse',
        message: 'invalid composer.json',
      });
      warnings.push(
        `Warning: extract-import-map: composer.json at ${join(projectRoot, p)} failed ` +
        `to parse — PSR-4 namespace mapping unavailable — PHP imports ` +
        `under this package will not resolve\n`,
      );
      continue;
    }
    out.set(dirOf(p), parsed);
  }
  return { autoloads: out, warnings, failures };
}

/**
 * Resolve a PHP `use` FQN against the autoload map of the importer's
 * nearest enclosing composer.json. Returns array (0 or 1 match — the first
 * dir in the PSR-4 target list that contains the file).
 *
 * Resolved paths are anchored at the composer.json's directory, NOT at
 * projectRoot, so a sub-package's `App\Foo\Bar` resolves to
 * `<package-dir>/src/Foo/Bar.php` rather than `<projectRoot>/src/...`.
 * This is what Composer's autoloader actually does on disk.
 */
export function resolvePhpImport(rawImport, file, ctx) {
  if (!rawImport || typeof rawImport !== 'string') return [];
  // Strip leading backslash if present (PHP allows `use \Foo\Bar;`)
  const fqn = rawImport.startsWith('\\') ? rawImport.slice(1) : rawImport;
  if (!fqn) return [];

  const importerDir = dirOf(toPosix(file.path));
  const composerDir = findNearestConfigDir(importerDir, ctx.phpAutoloads);
  if (composerDir === undefined) return [];
  const autoload = ctx.phpAutoloads.get(composerDir);
  if (!autoload || autoload.size === 0) return [];

  // Longest-prefix match across this composer.json's autoload entries.
  // Walk the map and pick the entry with the longest matching prefix, so
  // `Foo\Bar` does not match a prefix `F\` if `Foo\` is also present.
  // Use `null` as the sentinel rather than 0-length so the empty PSR-4
  // fallback prefix (`""` → `src/`) can win when nothing more specific
  // matches; otherwise `prefix.length > bestPrefix.length` would always
  // be `0 > 0 = false` for the empty prefix.
  let bestPrefix = null;
  let bestDirs = null;
  for (const [prefix, dirs] of autoload) {
    if (fqn.startsWith(prefix) && (bestPrefix === null || prefix.length > bestPrefix.length)) {
      bestPrefix = prefix;
      bestDirs = dirs;
    }
  }
  if (bestDirs === null) return [];

  // Drop the prefix (it covers the directory), translate `\` to `/`.
  const relative = fqn.slice(bestPrefix.length).replace(/\\/g, '/');
  if (!relative) return [];
  for (const dir of bestDirs) {
    // Anchor at the composer.json's own directory — PSR-4 paths are
    // composer-relative, not project-relative.
    const dirUnderComposer = dir
      ? (composerDir ? `${composerDir}/${dir}` : dir)
      : composerDir;
    const candidate = dirUnderComposer
      ? `${dirUnderComposer}/${relative}.php`
      : `${relative}.php`;
    if (ctx.fileSet.has(candidate)) return [candidate];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Rust resolver
//
// Rust's module system is path-based but the import syntax is `use` rather
// than path strings. Tree-sitter emits sources like `crate::a::b::Item`,
// `super::a::Item`, `self::a`, or bare `std::collections::HashMap`. We map
// only those rooted at `crate::` or `super::` — bare paths are external
// crates.
//
// Resolution heuristics:
//   - `crate::a::b::*` -> probe `<crate-root>/a/b.rs`, then
//     `<crate-root>/a/b/mod.rs`. The crate root is `<package-dir>/src/`
//     (Cargo convention).
//   - `super::a::b::*` -> walk up one directory from the importer, then
//     descend; same .rs / mod.rs probes.
//   - `self::a::*` -> like `super::a::*` but without the walk-up.
//
// Rust uses won't always land on a file (an import like `crate::Foo` could
// refer to a struct re-exported through `mod.rs`); we accept that limitation.
//
// We also extract `mod x;` declarations via regex — these declare submodules
// to load and translate directly to `<importer-dir>/x.rs` or
// `<importer-dir>/x/mod.rs`.
// ---------------------------------------------------------------------------

/**
 * Try `<base>.rs` then `<base>/mod.rs` against the file set. Returns the
 * first match or null.
 */
function probeRustModule(base, fileSet) {
  if (!base) return null;
  if (fileSet.has(`${base}.rs`)) return `${base}.rs`;
  if (fileSet.has(`${base}/mod.rs`)) return `${base}/mod.rs`;
  return null;
}

/**
 * Find the "crate root" directory for a Rust importer. By Cargo convention,
 * this is the directory containing `src/lib.rs` or `src/main.rs`. For nested
 * workspaces, walk up from the importer until a `src/` ancestor is found.
 * Returns the path relative to project root, or null if not found.
 *
 * The loop walks every ancestor directory (including the root) and probes
 * `<ancestor>/src/lib.rs` and `<ancestor>/src/main.rs`. We don't need a
 * separate "candidate ends with src" branch — when the importer is itself
 * inside `src/`, the next iteration up reaches the package dir and the
 * `<package>/src/lib.rs` probe catches it.
 */
function findRustCrateSrc(importerDir, fileSet) {
  const parts = importerDir.split('/').filter(Boolean);
  for (let i = parts.length; i >= 0; i--) {
    const ancestor = parts.slice(0, i).join('/');
    const childSrc = ancestor ? `${ancestor}/src` : 'src';
    if (fileSet.has(`${childSrc}/lib.rs`) || fileSet.has(`${childSrc}/main.rs`)) {
      return childSrc;
    }
  }
  return null;
}

export function resolveRustImport(rawImport, file, ctx) {
  if (!rawImport || typeof rawImport !== 'string') return [];
  const src = rawImport.trim();
  if (!src) return [];

  const importerDir = dirOf(toPosix(file.path));
  const segments = src.split('::').filter(Boolean);
  if (segments.length === 0) return [];
  const head = segments[0];

  // External crates: anything not rooted at crate/super/self.
  if (head !== 'crate' && head !== 'super' && head !== 'self') return [];

  // Walk segments after the head to a base file path. We probe each
  // successive prefix from longest to shortest so that `crate::a::b::Item`
  // matches `a/b.rs` (with `Item` being a re-export inside) rather than
  // failing because `a/b/Item.rs` doesn't exist.
  let baseDir;
  if (head === 'crate') {
    const crateSrc = findRustCrateSrc(importerDir, ctx.fileSet);
    if (!crateSrc) {
      // Warn once per importer file (a single .rs file can have many
      // `use crate::...` statements; suppress duplicate warnings).
      const importerPath = toPosix(file.path);
      if (!ctx._warnedNoRustCrateRoot.has(importerPath)) {
        ctx._warnedNoRustCrateRoot.add(importerPath);
        process.stderr.write(
          `Warning: extract-import-map: Rust file ${importerPath} has ` +
          `'use crate::' but no crate root (src/lib.rs or src/main.rs) ` +
          `found — crate-relative imports unresolved\n`,
        );
      }
      return [];
    }
    baseDir = crateSrc;
  } else if (head === 'super') {
    // Walk up one directory from the importer
    const parts = importerDir.split('/').filter(Boolean);
    if (parts.length === 0) return [];
    baseDir = parts.slice(0, -1).join('/');
  } else {
    // self::
    baseDir = importerDir;
  }

  const rest = segments.slice(1);
  // Try each prefix length from longest -> shortest. The empty rest case
  // (e.g. bare `use crate;`) is unresolvable.
  for (let i = rest.length; i > 0; i--) {
    const prefix = rest.slice(0, i);
    const base = baseDir
      ? `${baseDir}/${prefix.join('/')}`
      : prefix.join('/');
    const match = probeRustModule(base, ctx.fileSet);
    if (match) return [match];
  }
  return [];
}

/**
 * Regex pass for Rust `mod x;` declarations. These are NOT captured by
 * tree-sitter's import field, but they declare a child module on disk that
 * follows the same `<dir>/x.rs` or `<dir>/x/mod.rs` convention.
 */
const RUST_MOD_RE = /^\s*(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+(\w+)\s*;\s*$/gm;

function extractRustModSources(content) {
  const sources = [];
  let m;
  // Rust uses the same line + block comment syntax as JS/TS, so we can reuse
  // the same stripper. Without this, `// mod fake;` would phantom-register
  // a submodule that doesn't exist on disk.
  const stripped = stripJsLikeComments(content);
  RUST_MOD_RE.lastIndex = 0;
  while ((m = RUST_MOD_RE.exec(stripped)) !== null) {
    // Synthesize as a `self::<name>` source so the regular Rust resolver
    // handles it (probes the importer's directory).
    sources.push(`self::${m[1]}`);
  }
  return sources;
}

// ---------------------------------------------------------------------------
// C / C++ resolver
//
// Tree-sitter's cpp extractor exposes both quoted and angle-bracket includes
// as imports with `source` set to the bare filename (e.g. `foo.h`).
// Quoted includes resolve relative to the importer's directory; angle
// includes look in a system path. We can't tell quoted from angle from
// tree-sitter alone, but the resolution rules overlap enough that probing
// both yields the right answer most of the time:
//   1. <importer-dir>/<source>
//   2. include/<source>
//   3. src/<source>
//   4. <source> (project-root-relative)
//
// We probe in that order and take the first match. Multiple file extensions
// (.h, .hpp, .hxx, .cuh) are NOT auto-appended — #include carries the
// extension explicitly.
// ---------------------------------------------------------------------------

export function resolveCppImport(rawImport, file, ctx) {
  if (!rawImport || typeof rawImport !== 'string') return [];
  const src = toPosix(rawImport.trim());
  if (!src) return [];
  const importerDir = dirOf(toPosix(file.path));

  const candidates = [
    resolveRelative(importerDir, src),
    `include/${src}`,
    `src/${src}`,
    src,
  ];
  for (const c of candidates) {
    if (c && ctx.fileSet.has(c)) return [c];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Languages recognized as "code" for resolver dispatch. Tree-sitter parses
 * these via the corresponding extractor; the dispatcher routes the import
 * source through the matching resolver.
 */
const TS_JS_LANGS = new Set([
  'typescript', 'javascript', 'tsx', 'jsx', 'vue',
]);

/**
 * Dispatch a raw import to the language-specific resolver. Returns an array
 * of resolved project-relative paths (most resolvers produce 0 or 1; Python
 * can produce multiple when a `from pkg import a, b, c` resolves both the
 * package's `__init__.py` and each submodule).
 *
 * Per-resolver contract: never throw, never read disk (read once in main()).
 * Empty array means external/unresolved.
 */
function resolveImport(imp, file, ctx) {
  const lang = file.language;
  const src = imp.source;
  if (TS_JS_LANGS.has(lang)) {
    const out = resolveTsJsImport(src, file, ctx);
    return out ? [out] : [];
  }
  if (lang === 'python') {
    return resolvePythonImport(src, imp.specifiers, file, ctx);
  }
  if (lang === 'go') {
    return resolveGoImport(src, file, ctx);
  }
  if (lang === 'java') {
    return resolveJavaImport(src, file, ctx);
  }
  if (lang === 'kotlin') {
    return resolveKotlinImport(src, file, ctx);
  }
  if (lang === 'scala') {
    return resolveScalaImport(src, imp.specifiers, file, ctx);
  }
  if (lang === 'csharp') {
    return resolveCSharpImport(src, file, ctx);
  }
  if (lang === 'swift') {
    return resolveSwiftImport(src, file, ctx);
  }
  if (lang === 'php') {
    return resolvePhpImport(src, file, ctx);
  }
  if (lang === 'rust') {
    return resolveRustImport(src, file, ctx);
  }
  if (lang === 'c' || lang === 'cpp') {
    return resolveCppImport(src, file, ctx);
  }
  // Ruby is handled via a dedicated pathway because its tree-sitter
  // extractor flattens require vs require_relative into a single field,
  // losing the discriminator the resolver needs.
  return [];
}

/**
 * Collect extra raw import sources that tree-sitter doesn't capture. Today
 * this is CommonJS require() literals for JS/TS files. Returns an array of
 * import-source strings to be passed through resolveImport().
 */
function extractExtraImportSources(file, content) {
  if (TS_JS_LANGS.has(file.language)) {
    return extractRequireSources(content);
  }
  if (file.language === 'kotlin') {
    return extractKotlinSources(content);
  }
  if (file.language === 'rust') {
    // `mod x;` declarations aren't in tree-sitter's `imports` field, but they
    // declare submodules on disk that the rust resolver knows how to find.
    return extractRustModSources(content);
  }
  return [];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const [,, inputPath, outputPath] = process.argv;
  if (!inputPath || !outputPath) {
    process.stderr.write('Usage: node extract-import-map.mjs <input.json> <output.json>\n');
    process.exit(1);
  }

  const inputRaw = readFileSync(inputPath, 'utf-8');
  const input = JSON.parse(inputRaw);
  const { projectRoot, files, analysisPaths } = input;

  if (!projectRoot || !Array.isArray(files)) {
    throw new Error('Invalid input: must contain projectRoot and files array');
  }

  const analysisFiles = selectAnalysisFiles(files, analysisPaths);

  if (analysisFiles.length === 0) {
    const output = {
      scriptCompleted: true,
      stats: { filesScanned: 0, filesWithImports: 0, totalEdges: 0 },
      failures: [],
      importMap: {},
    };
    writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf-8');
    process.stderr.write(
      'extract-import-map: filesScanned=0 filesWithImports=0 totalEdges=0\n',
    );
    return;
  }

  // Create tree-sitter plugin with all configs that have WASM grammars.
  //
  // WHY graceful init: the most likely real-world failure mode is the WASM
  // loader failing to locate or fetch the grammar binaries (cache eviction,
  // restricted sandboxes, transient FS issues). When that happens, we still
  // want the script to complete — producing an empty importMap for every
  // code file — rather than crashing the whole project-scanner pipeline.
  // The structural graph will lose import edges, but all OTHER analysis
  // (file inventory, exports inferred from filenames, etc.) keeps working.
  let registry = null;
  let treeSitterReady = false;
  const failures = [];
  try {
    const tsConfigs = builtinLanguageConfigs.filter(c => c.treeSitter);
    const tsPlugin = new TreeSitterPlugin(tsConfigs);
    await tsPlugin.init();
    registry = new PluginRegistry();
    registry.register(tsPlugin);
    registerAllParsers(registry);
    treeSitterReady = true;
  } catch (err) {
    failures.push({ path: null, stage: 'tree-sitter-init', message: err.message });
    process.stderr.write(
      `Warning: extract-import-map: tree-sitter init failed ` +
      `(${err.message}) — all importMap entries will be empty — ` +
      `structural graph will have no import edges\n`,
    );
  }

  // Build resolution context (cached configs). The loader pass for the
  // tsconfig/go.mod/composer.json files inside is parallelised — see
  // `buildResolutionContext`.
  const ctx = await buildResolutionContext(projectRoot, files);
  failures.push(...ctx.failures);

  const importMap = {};
  let filesWithImports = 0;
  let totalEdges = 0;

  for (const file of analysisFiles) {
    const path = toPosix(file.path);

    // Non-code files always get an empty array
    if (file.fileCategory !== 'code') {
      importMap[path] = [];
      continue;
    }

    // Tree-sitter init failed earlier — produce empty importMap entries for
    // every code file and skip the analysis path. The one-time warning was
    // already emitted at startup.
    if (!treeSitterReady) {
      importMap[path] = [];
      continue;
    }

    const absolutePath = join(projectRoot, file.path);

    // Read file content (per-file resilience)
    let content;
    try {
      content = readFileSync(absolutePath, 'utf-8');
    } catch (err) {
      failures.push({ path, stage: 'file-read', message: err.message });
      process.stderr.write(
        `Warning: extract-import-map: import resolution failed for ${path} ` +
        `(read error: ${err.message}) — importMap[${path}]=[]\n`,
      );
      importMap[path] = [];
      continue;
    }

    // Analyze + resolve
    let resolved;
    try {
      const resolvedSet = new Set();

      // Ruby is the only language whose tree-sitter import field doesn't
      // preserve the require vs require_relative discriminator, so the
      // resolver needs the regex-parsed shape directly. All other tree-sitter
      // languages get analyzed once and dispatched normally.
      if (file.language === 'ruby') {
        for (const imp of parseRubyImports(content)) {
          for (const out of resolveRubyImport(imp, file, ctx)) {
            if (out && ctx.fileSet.has(out)) resolvedSet.add(out);
          }
        }
      } else {
        const analysis = registry.analyzeFile(file.path, content);
        const imports = analysis?.imports ?? [];
        for (const imp of imports) {
          const outs = resolveImport(imp, file, ctx);
          for (const out of outs) {
            if (out && ctx.fileSet.has(out)) {
              resolvedSet.add(out);
            }
          }
        }
        // Supplemental pass for sources tree-sitter doesn't capture (e.g.
        // CJS require() calls, Kotlin imports). Dedup via the same set.
        for (const extra of extractExtraImportSources(file, content)) {
          const outs = resolveImport({ source: extra, specifiers: [] }, file, ctx);
          for (const out of outs) {
            if (out && ctx.fileSet.has(out)) {
              resolvedSet.add(out);
            }
          }
        }
      }
      resolved = [...resolvedSet].sort((a, b) =>
        file.language === 'scala'
          ? compareScalaPackageMembers(a, b)
          : comparePaths(a, b),
      );
    } catch (err) {
      failures.push({ path, stage: 'file-analyze', message: err.message });
      process.stderr.write(
        `Warning: extract-import-map: import resolution failed for ${path} ` +
        `(analyze error: ${err.message}) — importMap[${path}]=[]\n`,
      );
      importMap[path] = [];
      continue;
    }

    importMap[path] = resolved;
    if (resolved.length > 0) {
      filesWithImports += 1;
      totalEdges += resolved.length;
    }
  }

  const output = {
    scriptCompleted: true,
    stats: {
      filesScanned: analysisFiles.length,
      filesWithImports,
      totalEdges,
    },
    failures,
    importMap,
  };

  writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf-8');

  if (!existsSync(outputPath)) {
    throw new Error(`output file missing after write: ${outputPath}`);
  }

  process.stderr.write(
    `extract-import-map: filesScanned=${analysisFiles.length} ` +
    `filesWithImports=${filesWithImports} totalEdges=${totalEdges}\n`,
  );
}

// ---------------------------------------------------------------------------
// Run only when executed directly as a CLI; importing the module (e.g. from
// tests) must not trigger main().
//
// Canonicalize both sides through realpathSync. Node ESM resolves
// import.meta.url through symlinks but pathToFileURL(process.argv[1]) preserves
// them, so a raw equality check silently no-ops when the script is invoked via
// a symlinked plugin install path (the default in Claude Code / Copilot CLI
// caches). See GitHub issue #162.
// ---------------------------------------------------------------------------
function isCliEntry() {
  if (!process.argv[1]) return false;
  try {
    const modulePath = realpathSync(fileURLToPath(import.meta.url));
    const argvPath = realpathSync(process.argv[1]);
    return modulePath === argvPath;
  } catch {
    return false;
  }
}

if (isCliEntry()) {
  try {
    await main();
  } catch (err) {
    process.stderr.write(`extract-import-map.mjs failed: ${err.message}\n${err.stack}\n`);
    process.exit(1);
  }
}
