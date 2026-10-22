// PostToolUse (Bash) hook: after a commit-like git command in an opted-in
// project, add one advisory line suggesting a graph refresh. It never runs
// anything and never tells Claude to act without asking the user.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  COMMIT_MESSAGE,
  emitContext,
  optedInSafeProject,
  readHookInput,
} from './auto-update-check.mjs';

const COMMIT_COMMAND = /git\s+(commit|merge|cherry-pick|rebase)/;

async function main() {
  const payload = await readHookInput();
  const command = payload?.tool_input?.command;
  if (typeof command !== 'string' || !COMMIT_COMMAND.test(command)) return;

  const project = await optedInSafeProject(payload?.cwd);
  if (!project) return;
  if (!existsSync(join(project.dataDir, 'knowledge-graph.json'))) return;

  emitContext('PostToolUse', COMMIT_MESSAGE);
}

await main().catch(() => {});
