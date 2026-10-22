import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');
const hooksDir = join(repoRoot, 'understand-anything-plugin', 'hooks');
const hookScript = join(hooksDir, 'session-start-auto-update.mjs');
const hooksConfig = JSON.parse(readFileSync(join(hooksDir, 'hooks.json'), 'utf8'));

const sandboxes = [];
afterEach(() => {
  while (sandboxes.length) rmSync(sandboxes.pop(), { recursive: true, force: true });
});

function git(cwd, ...args) {
  return execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' },
  ).trim();
}

function runHook({
  optIn = true,
  stale = true,
  dataDirName = '.ua',
  createMeta = true,
  symlinkDataDir = false,
  config,
} = {}) {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'ua-session-start-')));
  sandboxes.push(sandbox);
  const home = join(sandbox, 'home');
  const projectRoot = join(sandbox, 'project');
  mkdirSync(home);
  mkdirSync(projectRoot);
  git(projectRoot, 'init', '-q');
  git(projectRoot, 'commit', '-q', '--allow-empty', '-m', 'init');
  const head = git(projectRoot, 'rev-parse', 'HEAD');

  const dataDir = join(projectRoot, dataDirName);
  if (symlinkDataDir) {
    const elsewhere = join(sandbox, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, dataDir);
  } else {
    mkdirSync(dataDir);
  }
  writeFileSync(join(dataDir, 'knowledge-graph.json'), '{}');
  if (createMeta) {
    const gitCommitHash = stale ? '0'.repeat(40) : head;
    writeFileSync(join(dataDir, 'meta.json'), JSON.stringify({ gitCommitHash }));
  }
  if (config !== undefined) writeFileSync(join(dataDir, 'config.json'), config);
  if (optIn) {
    mkdirSync(join(home, '.understand-the-job'));
    writeFileSync(
      join(home, '.understand-the-job', 'auto-update.json'),
      JSON.stringify({ projects: [projectRoot] }),
    );
  }

  const result = spawnSync(process.execPath, [hookScript], {
    cwd: projectRoot,
    input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd: projectRoot }),
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf8',
  });
  return { ...result, projectRoot };
}

describe('SessionStart auto-update hook', () => {
  it('is a node script, not inline shell', () => {
    expect(hooksConfig.hooks.SessionStart).toEqual([
      {
        hooks: [
          {
            type: 'command',
            command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/session-start-auto-update.mjs"',
          },
        ],
      },
    ]);
  });

  it('adds one advisory line when an opted-in graph is stale', () => {
    const result = runHook();
    const output = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(output).toEqual({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext:
          '[understand-the-job] The knowledge graph is out of date. ' +
          'Ask the user whether to run /understand to refresh it.',
      },
    });
  });

  it('supports the legacy .understand-anything data directory', () => {
    const result = runHook({ dataDirName: '.understand-anything' });

    expect(JSON.parse(result.stdout).hookSpecificOutput.hookEventName).toBe('SessionStart');
  });

  it('stays silent when the graph matches HEAD', () => {
    expect(runHook({ stale: false }).stdout).toBe('');
  });

  it('stays silent without meta.json', () => {
    expect(runHook({ createMeta: false }).stdout).toBe('');
  });

  it('stays silent when the project is not opted in, even with autoUpdate: true in the repo', () => {
    const result = runHook({ optIn: false, config: JSON.stringify({ autoUpdate: true }) });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('stays silent when the data directory is a symlink', () => {
    const result = runHook({ symlinkDataDir: true });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });
});

describe('hook texts', () => {
  const hookSources = readdirSync(hooksDir)
    .filter((name) => /\.(mjs|json|md)$/.test(name))
    .map((name) => [name, readFileSync(join(hooksDir, name), 'utf8')]);

  it('no longer ships a prompt file for hooks to execute', () => {
    expect(hookSources.map(([name]) => name)).not.toContain('auto-update-prompt.md');
  });

  it.each(hookSources)('%s is advisory only', (_name, source) => {
    expect(source).not.toMatch(/\bMUST\b/);
    expect(source).not.toMatch(/do not ask the user/i);
    expect(source).not.toMatch(/auto-update-prompt/);
    expect(source).not.toMatch(/execute its instructions/i);
  });

  it.each(hookSources.filter(([name]) => name.endsWith('.mjs')))(
    '%s never reads autoUpdate from the repository config',
    (_name, source) => {
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code).not.toMatch(/config\.json/);
      expect(code).not.toMatch(/autoUpdate/);
    },
  );
});
