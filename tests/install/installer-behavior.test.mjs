import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const installSh = resolve(__dirname, '../../install.sh');

// install.sh builds symlinks and is a bash script; Windows uses install.ps1.
describe.skipIf(process.platform === 'win32')('install.sh behaviour (pinned tag, shared link)', () => {
  let sandbox;
  let home;
  let origin;

  function git(cwd, ...args) {
    const r = spawnSync(
      'git',
      [
        '-c', 'user.name=test',
        '-c', 'user.email=test@example.invalid',
        '-c', 'commit.gpgsign=false',
        '-c', 'tag.gpgsign=false',
        ...args,
      ],
      { cwd, encoding: 'utf-8' },
    );
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout.trim();
  }

  function commit(file, content, message) {
    writeFileSync(join(origin, file), content);
    git(origin, 'add', '-A');
    git(origin, 'commit', '-q', '-m', message);
  }

  function run(args, env = {}) {
    return spawnSync('bash', [installSh, ...args], {
      encoding: 'utf-8',
      timeout: 60_000,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        UTJ_REPO_URL: `file://${origin}`,
        ...env,
      },
    });
  }

  const repoDir = () => join(home, '.understand-the-job', 'repo');
  const headSha = () => git(repoDir(), 'rev-parse', 'HEAD');
  const pluginLink = () => join(home, '.understand-anything-plugin');
  const isLink = (p) => {
    try {
      return lstatSync(p).isSymbolicLink();
    } catch {
      return false;
    }
  };

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'utj-install-'));
    home = join(sandbox, 'home');
    origin = join(sandbox, 'origin');
    mkdirSync(home, { recursive: true });
    mkdirSync(join(origin, 'understand-anything-plugin', 'skills', 'understand'), { recursive: true });
    mkdirSync(join(origin, 'understand-anything-plugin', 'skills', 'understand-dashboard'), { recursive: true });
    mkdirSync(join(origin, 'understand-anything-plugin', 'agents'), { recursive: true });
    writeFileSync(join(origin, 'understand-anything-plugin', 'skills', 'understand', 'SKILL.md'), '# understand\n');
    writeFileSync(join(origin, 'understand-anything-plugin', 'skills', 'understand-dashboard', 'SKILL.md'), '# dashboard\n');
    writeFileSync(join(origin, 'understand-anything-plugin', 'agents', 'a.md'), '# a\n');
    git(origin, 'init', '-q', '-b', 'main');
    git(origin, 'add', '-A');
    git(origin, 'commit', '-q', '-m', 'release 1.0.0');
    git(origin, 'tag', '-a', 'v1.0.0', '-m', 'v1.0.0');
    // The branch moves on after the release: an installer that follows the
    // branch (git pull) would pick this up, a pinned one must not.
    commit('NEWER', 'unreleased\n', 'unreleased work on main');
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('installs the pinned tag (detached), not the tip of main', () => {
    const r = run(['codex']);
    expect(r.status, r.stderr).toBe(0);

    expect(headSha()).toBe(git(origin, 'rev-parse', 'v1.0.0^{commit}'));
    expect(headSha()).not.toBe(git(origin, 'rev-parse', 'main'));
    expect(existsSync(join(repoDir(), 'NEWER'))).toBe(false);
    // detached HEAD: symbolic-ref fails
    expect(spawnSync('git', ['-C', repoDir(), 'symbolic-ref', '-q', 'HEAD']).status).not.toBe(0);

    const skillLink = join(home, '.agents', 'skills', 'understand');
    expect(isLink(skillLink)).toBe(true);
    expect(readlinkSync(skillLink)).toBe(join(repoDir(), 'understand-anything-plugin', 'skills', 'understand'));
    expect(readlinkSync(pluginLink())).toBe(join(repoDir(), 'understand-anything-plugin'));
  });

  it('--update re-fetches the pinned tag and never follows main', () => {
    expect(run(['codex']).status).toBe(0);
    const pinned = headSha();

    commit('NEWER2', 'more unreleased\n', 'more unreleased work on main');
    const r = run(['--update']);
    expect(r.status, r.stderr).toBe(0);
    expect(headSha()).toBe(pinned);
    expect(existsSync(join(repoDir(), 'NEWER2'))).toBe(false);

    // Moving to a newer release is an explicit act: name its tag.
    git(origin, 'tag', '-a', 'v1.1.0', '-m', 'v1.1.0');
    const moved = run(['--update'], { UTJ_REF: 'v1.1.0' });
    expect(moved.status, moved.stderr).toBe(0);
    expect(headSha()).toBe(git(origin, 'rev-parse', 'v1.1.0^{commit}'));
    expect(existsSync(join(repoDir(), 'NEWER2'))).toBe(true);
  });

  it('refuses an existing checkout whose origin is a different repo', () => {
    expect(run(['codex']).status).toBe(0);
    const before = headSha();
    git(repoDir(), 'remote', 'set-url', 'origin', 'https://github.com/Egonex-AI/Understand-Anything.git');

    for (const args of [['codex'], ['--update']]) {
      const r = run(args);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/Refusing to use the existing checkout/);
      expect(r.stderr).toMatch(/Egonex-AI\/Understand-Anything/);
    }
    expect(headSha()).toBe(before);
  });

  it('refuses option-like or command-running refs and URLs', () => {
    const badRef = run(['codex'], { UTJ_REF: '--upload-pack=touch pwned' });
    expect(badRef.status).not.toBe(0);
    expect(badRef.stderr).toMatch(/Invalid UTJ_REF/);

    const badUrl = run(['codex'], { UTJ_REPO_URL: 'ext::sh -c touch% pwned' });
    expect(badUrl.status).not.toBe(0);
    expect(badUrl.stderr).toMatch(/Invalid UTJ_REPO_URL/);

    expect(existsSync(repoDir())).toBe(false);
    expect(existsSync(join(sandbox, 'pwned'))).toBe(false);
  });

  it('keeps the shared plugin link until the last platform is uninstalled', () => {
    expect(run(['codex']).status).toBe(0); // per-skill  -> ~/.agents/skills
    expect(run(['openclaw']).status).toBe(0); // folder -> ~/.openclaw/skills

    const first = run(['--uninstall', 'codex']);
    expect(first.status, first.stderr).toBe(0);
    expect(isLink(join(home, '.agents', 'skills', 'understand'))).toBe(false);
    expect(isLink(join(home, '.agents', 'skills', 'understand-dashboard'))).toBe(false);
    expect(isLink(pluginLink())).toBe(true);
    expect(first.stdout).toMatch(/still used by: openclaw/);
    expect(isLink(join(home, '.openclaw', 'skills', 'understand-anything'))).toBe(true);

    const last = run(['--uninstall', 'openclaw']);
    expect(last.status, last.stderr).toBe(0);
    expect(isLink(join(home, '.openclaw', 'skills', 'understand-anything'))).toBe(false);
    expect(isLink(pluginLink())).toBe(false);
  });

  it('platforms that share one skills dir are removed together without blocking the link removal', () => {
    // codex and gemini both use ~/.agents/skills with identical links.
    expect(run(['codex']).status).toBe(0);
    expect(run(['gemini']).status).toBe(0);
    const r = run(['--uninstall', 'codex']);
    expect(r.status, r.stderr).toBe(0);
    expect(isLink(join(home, '.agents', 'skills', 'understand'))).toBe(false);
    expect(isLink(pluginLink())).toBe(false);
  });

  it('never removes links that point at some other checkout', () => {
    expect(run(['codex']).status).toBe(0);
    // Replace one of our links and the plugin link with links to somewhere else.
    const elsewhere = join(sandbox, 'upstream');
    mkdirSync(elsewhere);
    const foreign = join(home, '.agents', 'skills', 'understand');
    rmSync(foreign);
    symlinkSync(elsewhere, foreign);
    rmSync(pluginLink());
    symlinkSync(elsewhere, pluginLink());

    const r = run(['--uninstall', 'codex']);
    expect(r.status, r.stderr).toBe(0);
    expect(readlinkSync(foreign)).toBe(elsewhere);
    expect(readlinkSync(pluginLink())).toBe(elsewhere);
    expect(isLink(join(home, '.agents', 'skills', 'understand-dashboard'))).toBe(false);
  });

  it('refuses to adopt a plugin link that points at another install', () => {
    const upstream = join(sandbox, 'upstream');
    mkdirSync(upstream);
    symlinkSync(upstream, pluginLink());

    const r = run(['codex']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/already points to/);
    expect(readlinkSync(pluginLink())).toBe(upstream);
    expect(existsSync(join(home, '.agents', 'skills', 'understand'))).toBe(false);
  });

  it('refuses to replace a real directory in the skills dir', () => {
    mkdirSync(join(home, '.agents', 'skills', 'understand'), { recursive: true });
    const r = run(['codex']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/not a symlink/);
    expect(isLink(join(home, '.agents', 'skills', 'understand-dashboard'))).toBe(false);
  });
});
