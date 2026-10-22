import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(
  __dirname,
  '../../../understand-anything-plugin/skills/understand/ensure-safe-data-dir.mjs',
);
const { assertSafeDataDir, UnsafeDataDirError } = await import(pathToFileURL(SCRIPT).href);

// Symlink creation needs elevated rights on Windows; the guard is exercised on POSIX CI.
const describePosix = process.platform === 'win32' ? describe.skip : describe;

function runCli(...args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf-8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('ensure-safe-data-dir.mjs', () => {
  let base;
  let root; // the project under analysis
  let outside; // where a hostile link would point

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'ua-safe-dir-')));
    root = join(base, 'repo');
    outside = join(base, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  describe('safe layouts (exit 0)', () => {
    it('a missing data dir is safe', () => {
      const r = runCli(root);
      expect(r.status).toBe(0);
      expect(r.stderr).toBe('');
    });

    it('a normal .ua directory with nested files is safe', () => {
      mkdirSync(join(root, '.ua', 'intermediate', 'deep'), { recursive: true });
      writeFileSync(join(root, '.ua', 'knowledge-graph.json'), '{}');
      writeFileSync(join(root, '.ua', 'intermediate', 'deep', 'batch-1.json'), '{}');
      expect(runCli(root).status).toBe(0);
    });

    it('a normal legacy .understand-anything directory is safe', () => {
      mkdirSync(join(root, '.understand-anything'));
      writeFileSync(join(root, '.understand-anything', 'meta.json'), '{}');
      expect(runCli(root).status).toBe(0);
    });

    it('accepts a relative project root', () => {
      mkdirSync(join(root, '.ua'));
      const r = spawnSync(process.execPath, [SCRIPT, '.'], { cwd: root, encoding: 'utf-8' });
      expect(r.status).toBe(0);
    });

    it('assertSafeDataDir returns the data dir path', () => {
      expect(assertSafeDataDir(root)).toBe(join(root, '.ua'));
      mkdirSync(join(root, '.understand-anything'));
      expect(assertSafeDataDir(root)).toBe(join(root, '.understand-anything'));
    });

    it('a project root reached through a symlink is fine when the data dir is real', () => {
      if (process.platform === 'win32') return;
      mkdirSync(join(root, '.ua'));
      const alias = join(outside, 'alias');
      symlinkSync(root, alias);
      expect(runCli(alias).status).toBe(0);
    });
  });

  describePosix('unsafe layouts (exit 2)', () => {
    it('the data dir itself is a symlink out of the project', () => {
      symlinkSync(outside, join(root, '.ua'));
      const r = runCli(root);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/symbolic link/);
      expect(r.stderr.trim().split('\n')).toHaveLength(1);
    });

    it('a symlink that points inside the project is still rejected', () => {
      mkdirSync(join(root, 'real-data'));
      symlinkSync(join(root, 'real-data'), join(root, '.ua'));
      const r = runCli(root);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/symbolic link/);
    });

    it('a dangling symlinked data dir is rejected', () => {
      symlinkSync(join(outside, 'nowhere'), join(root, '.ua'));
      expect(runCli(root).status).toBe(2);
    });

    it('a symlinked file nested directly in the data dir is rejected', () => {
      mkdirSync(join(root, '.ua'));
      writeFileSync(join(outside, '.zshrc'), '# precious');
      symlinkSync(join(outside, '.zshrc'), join(root, '.ua', 'fingerprints.json'));
      const r = runCli(root);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/fingerprints\.json is a symbolic link/);
    });

    it('a symlink nested several levels down is rejected', () => {
      mkdirSync(join(root, '.ua', 'intermediate', 'a', 'b'), { recursive: true });
      symlinkSync(outside, join(root, '.ua', 'intermediate', 'a', 'b', 'link'));
      const r = runCli(root);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/link is a symbolic link/);
    });

    it('a nested symlink to a file inside the project is still rejected', () => {
      mkdirSync(join(root, '.ua'));
      writeFileSync(join(root, 'README.md'), 'hi');
      symlinkSync(join(root, 'README.md'), join(root, '.ua', 'config.json'));
      expect(runCli(root).status).toBe(2);
    });

    it('a dangling nested symlink is rejected', () => {
      mkdirSync(join(root, '.ua'));
      symlinkSync(join(outside, 'ghost'), join(root, '.ua', 'meta.json'));
      expect(runCli(root).status).toBe(2);
    });

    it('a symlinked legacy .understand-anything dir is rejected', () => {
      symlinkSync(outside, join(root, '.understand-anything'));
      expect(runCli(root).status).toBe(2);
    });

    it('a data dir that is a regular file is rejected', () => {
      writeFileSync(join(root, '.ua'), 'not a directory');
      const r = runCli(root);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/not a directory/);
    });

    it('the reason stays on one line and carries no control characters from file names', () => {
      mkdirSync(join(root, '.ua'));
      symlinkSync(outside, join(root, '.ua', 'evil\n\u001b[31mname'));
      const r = runCli(root);
      expect(r.status).toBe(2);
      expect(r.stderr.trim().split('\n')).toHaveLength(1);
      const body = r.stderr.replace(/\n$/, '');
      expect([...body].some((ch) => ch.codePointAt(0) < 0x20)).toBe(false);
    });

    it('assertSafeDataDir throws UnsafeDataDirError with the same reason', () => {
      mkdirSync(join(root, '.ua'));
      symlinkSync(outside, join(root, '.ua', 'link'));
      expect(() => assertSafeDataDir(root)).toThrow(UnsafeDataDirError);
      expect(() => assertSafeDataDir(root)).toThrow(/link is a symbolic link/);
      const cli = runCli(root);
      let message = '';
      try {
        assertSafeDataDir(root);
      } catch (err) {
        message = err.message;
      }
      expect(cli.stderr.trim()).toBe(`Unsafe data directory: ${message}`);
    });

    it('legacy .understand-anything wins over .ua when both exist', () => {
      // Only the legacy dir is hostile: it is the one that must be checked.
      mkdirSync(join(root, '.ua'));
      mkdirSync(join(root, '.understand-anything'));
      symlinkSync(outside, join(root, '.understand-anything', 'link'));
      expect(runCli(root).status).toBe(2);

      // And the reverse: a hostile .ua is ignored while a clean legacy dir exists,
      // because that is the directory every script actually uses.
      rmSync(join(root, '.understand-anything', 'link'));
      symlinkSync(outside, join(root, '.ua', 'link'));
      expect(runCli(root).status).toBe(0);
    });
  });

  describe('usage', () => {
    it('exits 1 with a usage line when no project root is given', () => {
      const r = runCli();
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/Usage:/);
    });

    it('importing the module does not run the CLI or exit', () => {
      const r = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', `import(${JSON.stringify(pathToFileURL(SCRIPT).href)}).then(() => console.log('ok'))`],
        { encoding: 'utf-8' },
      );
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('ok');
      expect(r.stderr).toBe('');
    });
  });
});
