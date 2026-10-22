// Shared checks for the advisory auto-update hooks.
//
// A hook may speak only when BOTH hold:
//   1. the user opted this project in from outside the repo
//      (~/.understand-the-job/auto-update.json, via /understand --auto-update);
//   2. the project's data directory passes the symlink/containment check in
//      skills/understand/ensure-safe-data-dir.mjs.
// The `autoUpdate` field of `.ua/config.json` is never read: a cloned repo
// must not be able to switch hooks on. Every failure path is silent.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

const PREFIX = '[understand-the-job]';

export const STALE_GRAPH_MESSAGE =
  `${PREFIX} The knowledge graph is out of date. ` +
  'Ask the user whether to run /understand to refresh it.';

export const COMMIT_MESSAGE =
  `${PREFIX} A commit changed this project, so the knowledge graph may be out of date. ` +
  'Ask the user whether to run /understand to refresh it.';

const optInModule = new URL('../skills/understand/auto-update-optin.mjs', import.meta.url);
const safeDataDirModule = new URL('../skills/understand/ensure-safe-data-dir.mjs', import.meta.url);

export async function readHookInput() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

/**
 * Returns `{ projectRoot, dataDir }` for an opted-in project whose data
 * directory is safe, else null. Fails closed when either helper module is
 * missing or throws.
 */
export async function optedInSafeProject(cwd) {
  let projectRoot;
  try {
    projectRoot = realpathSync(typeof cwd === 'string' && cwd ? cwd : process.cwd());
  } catch {
    return null;
  }

  try {
    const { isOptedIn } = await import(optInModule.href);
    if (!isOptedIn(projectRoot)) return null;
    const { assertSafeDataDir } = await import(safeDataDirModule.href);
    assertSafeDataDir(projectRoot);
  } catch {
    return null;
  }

  const legacy = join(projectRoot, '.understand-anything');
  const dataDir = existsSync(legacy) ? legacy : join(projectRoot, '.ua');
  return { projectRoot, dataDir };
}

/** True when the graph exists and meta.json records a commit other than HEAD. */
export function graphIsStale({ projectRoot, dataDir }) {
  if (!existsSync(join(dataDir, 'knowledge-graph.json'))) return false;
  let recorded;
  try {
    recorded = JSON.parse(readFileSync(join(dataDir, 'meta.json'), 'utf8')).gitCommitHash;
  } catch {
    return false;
  }
  if (typeof recorded !== 'string' || recorded === '') return false;
  let head;
  try {
    head = execFileSync('git', ['-C', projectRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
  } catch {
    return false;
  }
  return head !== '' && head !== recorded;
}

export function emitContext(hookEventName, additionalContext) {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } }),
  );
}
