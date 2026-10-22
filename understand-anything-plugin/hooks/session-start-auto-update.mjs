// SessionStart hook: in an opted-in project whose graph was built at another
// commit, add one advisory line suggesting a refresh. It never runs anything
// and never tells Claude to act without asking the user.
import {
  STALE_GRAPH_MESSAGE,
  emitContext,
  graphIsStale,
  optedInSafeProject,
  readHookInput,
} from './auto-update-check.mjs';

async function main() {
  const payload = await readHookInput();
  const project = await optedInSafeProject(payload?.cwd);
  if (!project || !graphIsStale(project)) return;

  emitContext('SessionStart', STALE_GRAPH_MESSAGE);
}

await main().catch(() => {});
