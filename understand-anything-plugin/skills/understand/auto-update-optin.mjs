#!/usr/bin/env node
/**
 * auto-update-optin.mjs
 *
 * Per-user opt-in list for the auto-update hooks. A repository can never turn
 * auto-update on for itself: the list lives in the user's home directory, not
 * in any project, and the `autoUpdate` field of `.ua/config.json` is ignored.
 *
 * File: ~/.understand-the-job/auto-update.json
 *   { "projects": ["<absolute realpath of project root>", ...] }
 *
 * Usage:
 *   node auto-update-optin.mjs add <projectRoot>      # /understand --auto-update
 *   node auto-update-optin.mjs remove <projectRoot>   # /understand --no-auto-update
 *   node auto-update-optin.mjs status <projectRoot>
 *   node auto-update-optin.mjs list
 *
 * Exit codes: 0 on success, 1 on a usage error or an unusable opt-in file.
 *
 * The hooks import `isOptedIn` from this module. Reads fail closed: a missing,
 * unreadable, or malformed file means "nothing is opted in". Writes refuse to
 * replace a malformed file so a typo never silently drops the user's list.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const OPT_IN_DIR_NAME = '.understand-the-job';
export const OPT_IN_FILE_NAME = 'auto-update.json';

export function optInFilePath(home = homedir()) {
  return join(home, OPT_IN_DIR_NAME, OPT_IN_FILE_NAME);
}

/** Realpath of an existing directory. Throws when it is missing or not a directory. */
export function canonicalProjectRoot(projectRoot) {
  if (typeof projectRoot !== 'string' || projectRoot === '') {
    throw new Error('project root is required');
  }
  const real = realpathSync(resolve(projectRoot));
  if (!statSync(real).isDirectory()) {
    throw new Error(`not a directory: ${projectRoot}`);
  }
  return real;
}

function parseProjects(raw, filePath) {
  const data = JSON.parse(raw);
  if (data === null || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.projects)) {
    throw new Error(`${filePath} must be an object with a "projects" array`);
  }
  return data.projects.filter(entry => typeof entry === 'string' && isAbsolute(entry));
}

/**
 * Strict read used before writing: a missing file is an empty list, anything
 * unreadable or malformed throws.
 */
function readProjectsStrict(filePath) {
  if (!existsSync(filePath)) return [];
  return parseProjects(readFileSync(filePath, 'utf8'), filePath);
}

/** Lenient read used by the hooks: any problem means an empty list. */
export function readOptInList(filePath = optInFilePath()) {
  try {
    return readProjectsStrict(filePath);
  } catch {
    return [];
  }
}

export function isOptedIn(projectRoot, filePath = optInFilePath()) {
  let real;
  try {
    real = canonicalProjectRoot(projectRoot);
  } catch {
    return false;
  }
  return readOptInList(filePath).includes(real);
}

function writeProjects(filePath, projects) {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const body = JSON.stringify({ projects: [...new Set(projects)].sort() }, null, 2) + '\n';
  // Write a sibling temp file and rename it over the target, so a crash never
  // leaves a half-written list and an existing symlink is replaced, not followed.
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  try {
    writeFileSync(tmpPath, body, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmpPath, filePath);
  } finally {
    rmSync(tmpPath, { force: true });
  }
}

export function addProject(projectRoot, filePath = optInFilePath()) {
  const real = canonicalProjectRoot(projectRoot);
  const projects = readProjectsStrict(filePath);
  if (projects.includes(real)) return { changed: false, projectRoot: real };
  writeProjects(filePath, [...projects, real]);
  return { changed: true, projectRoot: real };
}

export function removeProject(projectRoot, filePath = optInFilePath()) {
  // A project that no longer exists can still be removed by its absolute path.
  let key;
  try {
    key = canonicalProjectRoot(projectRoot);
  } catch {
    key = resolve(String(projectRoot ?? ''));
  }
  const projects = readProjectsStrict(filePath);
  if (!projects.includes(key)) return { changed: false, projectRoot: key };
  writeProjects(filePath, projects.filter(entry => entry !== key));
  return { changed: true, projectRoot: key };
}

const USAGE = 'Usage: node auto-update-optin.mjs <add|remove|status> <projectRoot> | list';

function main(argv) {
  const [command, projectRoot] = argv;
  const filePath = optInFilePath();
  try {
    if (command === 'list' && projectRoot === undefined) {
      for (const entry of readProjectsStrict(filePath)) process.stdout.write(`${entry}\n`);
      return 0;
    }
    if (!['add', 'remove', 'status'].includes(command) || !projectRoot || argv.length !== 2) {
      process.stderr.write(`${USAGE}\n`);
      return 1;
    }
    if (command === 'status') {
      const real = canonicalProjectRoot(projectRoot);
      const on = readProjectsStrict(filePath).includes(real);
      process.stdout.write(`auto-update ${on ? 'enabled' : 'disabled'} for ${real}\n`);
      return 0;
    }
    const { changed, projectRoot: key } = command === 'add'
      ? addProject(projectRoot, filePath)
      : removeProject(projectRoot, filePath);
    const state = command === 'add' ? 'enabled' : 'disabled';
    process.stdout.write(`auto-update ${state} for ${key}${changed ? '' : ' (no change)'} — list: ${filePath}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`auto-update-optin: ${err.message}\n`);
    return 1;
  }
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMain()) process.exitCode = main(process.argv.slice(2));
