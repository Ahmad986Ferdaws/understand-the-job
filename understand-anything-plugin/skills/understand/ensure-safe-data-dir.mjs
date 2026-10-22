#!/usr/bin/env node
/**
 * ensure-safe-data-dir.mjs
 *
 * Guard run as the first step of every skill that reads or writes the data
 * directory. The data dir (`.understand-anything/` when that legacy directory
 * exists, otherwise `.ua/`) lives inside the analyzed repository and teams
 * commit it, so a hostile repo can ship it - or any file in it - as a symlink
 * and turn "save the graph" into "overwrite a file elsewhere on this machine".
 *
 * Unsafe means any of:
 *   - the data dir is a symlink / junction (even one pointing inside the repo)
 *   - any entry anywhere inside it is a symlink / junction
 *   - its realpath is not inside realpath(projectRoot)
 *   - it exists but is not a directory, or cannot be inspected
 * A missing data dir is safe (the first run creates it).
 *
 * Usage:
 *   node ensure-safe-data-dir.mjs <projectRoot>
 * Exit codes: 0 safe, 2 unsafe (one-line reason on stderr), 1 bad usage.
 *
 * Other scripts: `import { assertSafeDataDir } from './ensure-safe-data-dir.mjs'`.
 * Plain Node, no dependencies; works with Windows paths.
 */

import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const UA_DIR = '.ua';
const LEGACY_UA_DIR = '.understand-anything';

export class UnsafeDataDirError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsafeDataDirError';
  }
}

/** lstat that maps "does not exist" to null. */
function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null;
    throw err;
  }
}

/**
 * File names come from the repo being analyzed: keep the reason on one line
 * and free of control characters / terminal escapes.
 */
function printable(text) {
  let out = '';
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    out += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? '?' : ch;
  }
  return out;
}

/**
 * Mirror core's resolveUaDir, but with lstat so a symlinked or dangling
 * `.understand-anything` still counts as present (and is then rejected).
 */
function resolveDataDirName(projectRoot) {
  return lstatOrNull(join(projectRoot, LEGACY_UA_DIR)) ? LEGACY_UA_DIR : UA_DIR;
}

/**
 * Throw UnsafeDataDirError (one-line message) unless the project's data
 * directory is absent or safe. Returns the data directory's path.
 */
export function assertSafeDataDir(projectRoot) {
  if (typeof projectRoot !== 'string' || projectRoot === '') {
    throw new UnsafeDataDirError('no project root given');
  }
  const root = resolve(projectRoot);
  const name = resolveDataDirName(root);
  const dir = join(root, name);
  const fail = (what) => {
    throw new UnsafeDataDirError(`refusing to use ${name}/: ${printable(what)}`);
  };

  let stat;
  try {
    stat = lstatOrNull(dir);
  } catch (err) {
    return fail(`cannot inspect it (${err.code ?? err.message})`);
  }
  if (stat === null) return dir; // first run: nothing to protect yet
  if (stat.isSymbolicLink()) return fail('it is a symbolic link');
  if (!stat.isDirectory()) return fail('it exists but is not a directory');

  try {
    const rel = relative(realpathSync(root), realpathSync(dir));
    if (rel === '' || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
      return fail('it resolves outside the project root');
    }
  } catch (err) {
    if (err instanceof UnsafeDataDirError) throw err;
    return fail(`cannot resolve it (${err.code ?? err.message})`);
  }

  // Walk every entry (iteratively; never descending into a link).
  const pending = [dir];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (err) {
      return fail(`cannot read ${relative(dir, current) || '.'} (${err.code ?? err.message})`);
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      let isLink = entry.isSymbolicLink();
      let isDir = entry.isDirectory();
      if (!isLink && !isDir && !entry.isFile()) {
        // Unknown dirent type on this filesystem: ask lstat.
        try {
          const s = lstatSync(full);
          isLink = s.isSymbolicLink();
          isDir = s.isDirectory();
        } catch (err) {
          return fail(`cannot inspect ${relative(dir, full)} (${err.code ?? err.message})`);
        }
      }
      if (isLink) return fail(`${relative(dir, full)} is a symbolic link`);
      if (isDir) pending.push(full);
    }
  }
  return dir;
}

function main(argv) {
  const projectRoot = argv[2];
  if (!projectRoot || argv.length > 3) {
    process.stderr.write('Usage: node ensure-safe-data-dir.mjs <projectRoot>\n');
    return 1;
  }
  try {
    assertSafeDataDir(projectRoot);
    return 0;
  } catch (err) {
    if (err instanceof UnsafeDataDirError) {
      process.stderr.write(`Unsafe data directory: ${err.message}\n`);
      return 2;
    }
    process.stderr.write(`Unsafe data directory: ${printable(err && err.message)}\n`);
    return 2;
  }
}

function isMainModule() {
  try {
    return (
      process.argv[1] !== undefined &&
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isMainModule()) {
  process.exitCode = main(process.argv);
}
