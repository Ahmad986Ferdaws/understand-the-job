import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addProject,
  isOptedIn,
  optInFilePath,
  readOptInList,
  removeProject,
} from '../../../understand-anything-plugin/skills/understand/auto-update-optin.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const script = resolve(
  __dirname,
  '../../../understand-anything-plugin/skills/understand/auto-update-optin.mjs',
);

let sandbox;
let home;
let project;
let listFile;

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'ua-optin-')));
  home = join(sandbox, 'home');
  project = join(sandbox, 'project');
  mkdirSync(home);
  mkdirSync(project);
  listFile = optInFilePath(home);
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function runCli(args) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
}

describe('auto-update opt-in list', () => {
  it('lives in the user home directory, never in a project', () => {
    expect(listFile).toBe(join(home, '.understand-the-job', 'auto-update.json'));
  });

  it('adds the realpath of the project once and reports membership', () => {
    const link = join(sandbox, 'project-link');
    symlinkSync(project, link);

    expect(addProject(link, listFile)).toEqual({ changed: true, projectRoot: project });
    expect(addProject(project, listFile)).toEqual({ changed: false, projectRoot: project });
    expect(JSON.parse(readFileSync(listFile, 'utf8'))).toEqual({ projects: [project] });
    expect(isOptedIn(project, listFile)).toBe(true);
    expect(isOptedIn(link, listFile)).toBe(true);
    expect(isOptedIn(sandbox, listFile)).toBe(false);
  });

  it('removes a project and keeps the others', () => {
    const other = join(sandbox, 'other');
    mkdirSync(other);
    addProject(project, listFile);
    addProject(other, listFile);

    expect(removeProject(project, listFile)).toEqual({ changed: true, projectRoot: project });
    expect(readOptInList(listFile)).toEqual([other]);
    expect(removeProject(project, listFile).changed).toBe(false);
  });

  it('removes a project whose directory no longer exists', () => {
    addProject(project, listFile);
    rmSync(project, { recursive: true });

    expect(removeProject(project, listFile).changed).toBe(true);
    expect(readOptInList(listFile)).toEqual([]);
  });

  it('writes the list with owner-only permissions', () => {
    addProject(project, listFile);
    if (process.platform !== 'win32') {
      expect(statSync(listFile).mode & 0o077).toBe(0);
    }
  });

  it('fails closed on a missing or malformed list', () => {
    expect(readOptInList(listFile)).toEqual([]);
    expect(isOptedIn(project, listFile)).toBe(false);

    mkdirSync(dirname(listFile), { recursive: true });
    for (const contents of ['{not-json', '[]', '{"projects": "x"}']) {
      writeFileSync(listFile, contents);
      expect(readOptInList(listFile)).toEqual([]);
      expect(isOptedIn(project, listFile)).toBe(false);
    }
  });

  it('ignores relative or non-string entries', () => {
    mkdirSync(dirname(listFile), { recursive: true });
    writeFileSync(listFile, JSON.stringify({ projects: ['relative/path', 7, project] }));
    expect(readOptInList(listFile)).toEqual([project]);
  });

  it('refuses to overwrite a malformed list', () => {
    mkdirSync(dirname(listFile), { recursive: true });
    writeFileSync(listFile, '{not-json');

    expect(() => addProject(project, listFile)).toThrow();
    expect(readFileSync(listFile, 'utf8')).toBe('{not-json');
  });

  it('rejects a project root that is not a directory', () => {
    const file = join(sandbox, 'file.txt');
    writeFileSync(file, 'x');
    expect(() => addProject(file, listFile)).toThrow(/not a directory/);
    expect(() => addProject(join(sandbox, 'missing'), listFile)).toThrow();
    expect(existsSync(listFile)).toBe(false);
  });
});

describe('auto-update-optin CLI', () => {
  it('adds, reports, lists, and removes a project under $HOME', () => {
    const add = runCli(['add', project]);
    expect(add.status).toBe(0);
    expect(add.stdout).toContain(`auto-update enabled for ${project}`);
    expect(readOptInList(listFile)).toEqual([project]);

    expect(runCli(['status', project]).stdout).toContain('auto-update enabled');
    expect(runCli(['list']).stdout).toBe(`${project}\n`);

    const remove = runCli(['remove', project]);
    expect(remove.status).toBe(0);
    expect(remove.stdout).toContain(`auto-update disabled for ${project}`);
    expect(runCli(['status', project]).stdout).toContain('auto-update disabled');
  });

  it.each([[[]], [['add']], [['enable', '/tmp']], [['add', '/tmp', 'extra']]])(
    'rejects bad usage %j',
    (args) => {
      const result = runCli(args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Usage:');
    },
  );

  it('exits 1 with a message for a malformed list', () => {
    mkdirSync(dirname(listFile), { recursive: true });
    writeFileSync(listFile, '{not-json');
    const result = runCli(['add', project]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('auto-update-optin:');
  });
});
