import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
const hookScript = join(hooksDir, 'post-tool-use-auto-update.mjs');
const hooksConfig = JSON.parse(readFileSync(join(hooksDir, 'hooks.json'), 'utf8'));

const sandboxes = [];
afterEach(() => {
  while (sandboxes.length) rmSync(sandboxes.pop(), { recursive: true, force: true });
});

function setup({
  optIn = true,
  dataDirName = '.understand-anything',
  createGraph = true,
  symlinkDataDir = false,
  config,
} = {}) {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'ua-post-tool-use-')));
  sandboxes.push(sandbox);
  const home = join(sandbox, 'home');
  const projectRoot = join(sandbox, 'project');
  mkdirSync(home);
  mkdirSync(projectRoot);

  const dataDir = join(projectRoot, dataDirName);
  if (symlinkDataDir) {
    const elsewhere = join(sandbox, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, dataDir);
  } else {
    mkdirSync(dataDir);
  }
  if (createGraph) writeFileSync(join(dataDir, 'knowledge-graph.json'), '{}');
  if (config !== undefined) writeFileSync(join(dataDir, 'config.json'), config);

  if (optIn) {
    mkdirSync(join(home, '.understand-the-job'));
    writeFileSync(
      join(home, '.understand-the-job', 'auto-update.json'),
      JSON.stringify({ projects: [projectRoot] }),
    );
  }
  return { home, projectRoot };
}

function runHook(options = {}) {
  const { command = 'git commit -m "test"', input } = options;
  const { home, projectRoot } = setup(options);
  const result = spawnSync(process.execPath, [hookScript], {
    cwd: projectRoot,
    input:
      input ??
      JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: projectRoot }),
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PLUGIN_ROOT: join(projectRoot, 'plugin root') },
    encoding: 'utf8',
  });
  return result;
}

describe('PostToolUse auto-update hook', () => {
  it('is registered as the Bash PostToolUse handler', () => {
    const registration = hooksConfig.hooks.PostToolUse[0];

    expect(registration.matcher).toBe('Bash');
    expect(registration.hooks).toEqual([
      {
        type: 'command',
        command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/post-tool-use-auto-update.mjs"',
      },
    ]);
  });

  it('adds one advisory line for an opted-in project', () => {
    const result = runHook();
    const output = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(output).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: expect.stringContaining('[understand-the-job]'),
      },
    });
    const text = output.hookSpecificOutput.additionalContext;
    expect(text).toContain('Ask the user whether to run /understand');
    expect(text).not.toMatch(/\bMUST\b/);
    expect(text).not.toMatch(/do not ask/i);
    expect(text).not.toMatch(/\.md\b/);
    expect(text).not.toMatch(/execute|read the file/i);
    expect(text.split('\n')).toHaveLength(1);
  });

  it.each(['commit', 'merge', 'cherry-pick', 'rebase'])(
    'recognizes git %s as a graph-changing operation',
    (operation) => {
      const result = runHook({ command: `git ${operation} example` });

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).hookSpecificOutput.hookEventName).toBe('PostToolUse');
    },
  );

  it('supports the .ua data directory', () => {
    const result = runHook({ dataDirName: '.ua' });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.hookEventName).toBe('PostToolUse');
  });

  it('stays silent when the project is not on the per-user opt-in list', () => {
    const result = runHook({ optIn: false });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('ignores autoUpdate: true in the repository config', () => {
    const result = runHook({ optIn: false, config: JSON.stringify({ autoUpdate: true }) });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('ignores autoUpdate: false in the repository config for an opted-in project', () => {
    const result = runHook({ config: JSON.stringify({ autoUpdate: false }) });

    expect(JSON.parse(result.stdout).hookSpecificOutput.hookEventName).toBe('PostToolUse');
  });

  it('stays silent when the data directory is a symlink', () => {
    const result = runHook({ symlinkDataDir: true });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('stays silent for unrelated Bash commands', () => {
    const result = runHook({ command: 'git status --short' });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it.each([
    ['malformed stdin', { input: '{not-json' }],
    ['a missing graph', { createGraph: false }],
  ])('stays silent for %s', (_scenario, options) => {
    const result = runHook(options);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('');
  });
});
