import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(
  __dirname,
  '../../../understand-anything-plugin/skills/understand-figma/figma-merge.mjs',
);

const manifest = {
  project: {
    name: 'MyApp',
    languages: ['figma'],
    frameworks: [],
    description: 'Figma design file: MyApp',
    analyzedAt: '2026-01-01T00:00:00.000Z',
    gitCommitHash: '',
  },
  fileKey: 'abc',
  figmaVersion: 'v42',
  nodes: [
    { id: 'page:1:0', type: 'page', name: 'Onboarding', summary: 'Onboarding', tags: ['page'], complexity: 'simple' },
    { id: 'screen:1:1', type: 'screen', name: 'Login', summary: 'Login', tags: ['screen'], complexity: 'simple' },
    { id: 'component:2:1', type: 'component', name: 'Primary', summary: 'Primary', tags: ['component'], complexity: 'simple' },
  ],
  edges: [
    { source: 'page:1:0', target: 'screen:1:1', type: 'contains', direction: 'forward', weight: 1 },
  ],
};

const codeGraph = (extra = {}) => ({
  version: '1.0.0',
  ...extra,
  project: {
    name: 'real-project',
    languages: ['typescript'],
    frameworks: [],
    description: 'the user code graph',
    analyzedAt: '2026-01-01T00:00:00.000Z',
    gitCommitHash: 'abc1234def',
  },
  nodes: [
    { id: 'file:src/a.ts', type: 'file', name: 'a.ts', filePath: 'src/a.ts', summary: 's', tags: [], complexity: 'simple' },
    { id: 'function:src/a.ts:f', type: 'function', name: 'f', filePath: 'src/a.ts', summary: 's', tags: [], complexity: 'simple' },
  ],
  edges: [],
  layers: [],
  tour: [],
});

const codeMeta = {
  lastAnalyzedAt: '2026-01-01T00:00:00.000Z',
  gitCommitHash: 'abc1234def',
  version: '1.0.0',
  analyzedFiles: 2,
};

function run(root, ...extra) {
  const r = spawnSync(process.execPath, [SCRIPT, root, ...extra], { encoding: 'utf-8' });
  return { status: r.status, stderr: r.stderr, stdout: r.stdout };
}

describe('figma-merge.mjs', () => {
  let base;
  let root;
  let dataDir;

  const readJson = (name) => JSON.parse(readFileSync(join(dataDir, name), 'utf-8'));
  const writeJson = (name, value) => writeFileSync(join(dataDir, name), JSON.stringify(value, null, 2));

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'ua-figma-merge-')));
    root = join(base, 'repo');
    dataDir = join(root, '.ua');
    mkdirSync(join(dataDir, 'intermediate'), { recursive: true });
    writeJson('intermediate/scan-manifest.json', manifest);
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  describe('output', () => {
    it('writes a design graph and a meta.json without gitCommitHash', () => {
      const r = run(root);
      expect(r.status).toBe(0);
      expect(r.stderr).toMatch(/Design graph: 3 nodes/);

      const graph = readJson('knowledge-graph.json');
      expect(graph.kind).toBe('design');
      expect(graph.nodes).toHaveLength(3);

      const meta = readJson('meta.json');
      expect('gitCommitHash' in meta).toBe(false);
      expect(meta.figmaVersion).toBe('v42');
      expect(meta.analyzedFiles).toBe(3);
      expect(meta.version).toBe('1.0.0');
      expect(typeof meta.lastAnalyzedAt).toBe('string');
    });

    it('leaves no temp files in the data dir', () => {
      run(root);
      expect(readdirSync(dataDir).sort()).toEqual(['intermediate', 'knowledge-graph.json', 'meta.json']);
    });

    it('uses the legacy .understand-anything dir when it exists', () => {
      const legacy = join(root, '.understand-anything');
      mkdirSync(join(legacy, 'intermediate'), { recursive: true });
      writeFileSync(join(legacy, 'intermediate', 'scan-manifest.json'), JSON.stringify(manifest));
      expect(run(root).status).toBe(0);
      expect(existsSync(join(legacy, 'knowledge-graph.json'))).toBe(true);
      expect(existsSync(join(dataDir, 'knowledge-graph.json'))).toBe(false);
    });

    it('exits 1 with usage when no project root is given', () => {
      const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf-8' });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/Usage:/);
    });
  });

  describe('refuses to destroy a code graph', () => {
    it.each([
      ['kind: codebase', () => codeGraph({ kind: 'codebase' }), null],
      ['kind-less graph with file/function nodes', () => codeGraph(), null],
      ['kind-less graph with a git-commit meta', () => ({ ...codeGraph(), nodes: [] }), codeMeta],
    ])('%s -> exit 3 and nothing is touched', (_label, makeGraph, meta) => {
      writeJson('knowledge-graph.json', makeGraph());
      if (meta) writeJson('meta.json', meta);
      const graphBefore = readFileSync(join(dataDir, 'knowledge-graph.json'), 'utf-8');
      const metaBefore = meta ? readFileSync(join(dataDir, 'meta.json'), 'utf-8') : null;

      const r = run(root);

      expect(r.status).toBe(3);
      expect(r.stderr).toMatch(/Refusing to overwrite/);
      expect(r.stderr).toMatch(/--force/);
      expect(readFileSync(join(dataDir, 'knowledge-graph.json'), 'utf-8')).toBe(graphBefore);
      if (meta) {
        expect(readFileSync(join(dataDir, 'meta.json'), 'utf-8')).toBe(metaBefore);
      } else {
        expect(existsSync(join(dataDir, 'meta.json'))).toBe(false);
      }
    });

    it('a /understand meta.json alone (no graph file) also blocks', () => {
      writeJson('meta.json', codeMeta);
      const r = run(root);
      expect(r.status).toBe(3);
      expect(readJson('meta.json')).toEqual(codeMeta);
      expect(existsSync(join(dataDir, 'knowledge-graph.json'))).toBe(false);
    });

    it('an unreadable existing graph blocks rather than being clobbered', () => {
      writeFileSync(join(dataDir, 'knowledge-graph.json'), '{ not json');
      const r = run(root);
      expect(r.status).toBe(3);
      expect(readFileSync(join(dataDir, 'knowledge-graph.json'), 'utf-8')).toBe('{ not json');
    });

    it('--force replaces it', () => {
      writeJson('knowledge-graph.json', codeGraph({ kind: 'codebase' }));
      writeJson('meta.json', codeMeta);

      const r = run(root, '--force');

      expect(r.status).toBe(0);
      expect(r.stderr).toMatch(/--force: replacing/);
      expect(readJson('knowledge-graph.json').kind).toBe('design');
      expect('gitCommitHash' in readJson('meta.json')).toBe(false);
    });

    it('--force may come before the project root', () => {
      writeJson('knowledge-graph.json', codeGraph());
      expect(run('--force', root).status).toBe(0);
    });
  });

  describe('re-running over its own or a knowledge output is fine', () => {
    it('replaces a previous design graph (including an old meta with gitCommitHash "")', () => {
      expect(run(root).status).toBe(0);
      writeJson('meta.json', { lastAnalyzedAt: 't', gitCommitHash: '', figmaVersion: 'v1', version: '1.0.0', analyzedFiles: 1 });
      expect(run(root).status).toBe(0);
      expect('gitCommitHash' in readJson('meta.json')).toBe(false);
    });

    it('replaces a kind:knowledge graph even when its meta records a commit', () => {
      writeJson('knowledge-graph.json', { ...codeGraph({ kind: 'knowledge' }), nodes: [] });
      writeJson('meta.json', codeMeta);
      expect(run(root).status).toBe(0);
      expect(readJson('knowledge-graph.json').kind).toBe('design');
    });
  });

  describe.skipIf(process.platform === 'win32')('symlink hardening', () => {
    it('refuses a symlinked data dir (exit 2) and writes nothing outside the repo', () => {
      const elsewhere = join(base, 'elsewhere');
      mkdirSync(join(elsewhere, 'intermediate'), { recursive: true });
      writeFileSync(join(elsewhere, 'intermediate', 'scan-manifest.json'), JSON.stringify(manifest));
      rmSync(dataDir, { recursive: true });
      symlinkSync(elsewhere, dataDir);

      const r = run(root);

      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/symbolic link/);
      expect(existsSync(join(elsewhere, 'knowledge-graph.json'))).toBe(false);
    });

    it('does not write through a symlinked knowledge-graph.json', () => {
      const victim = join(base, '.zshrc');
      writeFileSync(victim, '# precious\n');
      symlinkSync(victim, join(dataDir, 'knowledge-graph.json'));

      const r = run(root, '--force');

      expect(r.status).toBe(2);
      expect(readFileSync(victim, 'utf-8')).toBe('# precious\n');
    });
  });
});
