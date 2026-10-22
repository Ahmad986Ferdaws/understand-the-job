import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');
const skillsDir = resolve(repoRoot, 'understand-anything-plugin/skills');

function readRepoFile(relPath) {
  return readFileSync(resolve(repoRoot, relPath), 'utf-8');
}

const skillFiles = readdirSync(skillsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => `understand-anything-plugin/skills/${entry.name}/SKILL.md`);

describe('skill command hardening', () => {
  it.each(skillFiles)('%s quotes PROJECT_ROOT in shell command snippets', (relPath) => {
    const unsafePatterns = [
      /\b(?:node|python|python3|mkdir|find|rm|cat)\s+(?:-[^\n]*\s+)*\$PROJECT_ROOT\b/,
      />\s*\$PROJECT_ROOT\b/,
      /--changed-files=\$PROJECT_ROOT\b/,
      /rm\s+-rf\s+\$PROJECT_ROOT\b/,
      /mkdir\s+-p\s+\$UA_DIR\b/,
    ];

    const content = readRepoFile(relPath);
    for (const pattern of unsafePatterns) {
      expect(content, `${relPath} should not contain ${pattern}`).not.toMatch(pattern);
    }
  });

  it('quotes skill and target directory placeholders in knowledge commands', () => {
    const content = readRepoFile('understand-anything-plugin/skills/understand-knowledge/SKILL.md');

    expect(content).not.toMatch(/python3\s+<SKILL_DIR>\/[^\n]+ <TARGET_DIR>/);
    expect(content).not.toMatch(/rm\s+-rf\s+<TARGET_DIR>/);
  });

  it('quotes bundled script paths in figma commands', () => {
    const content = readRepoFile('understand-anything-plugin/skills/understand-figma/SKILL.md');

    expect(content).not.toMatch(/node\s+<SKILL_DIR>/);
    expect(content).toContain('node "<SKILL_DIR>/figma-merge.mjs" "$PROJECT_ROOT"');
  });

  it('does not rewrite metadata for generated-only commits', () => {
    const content = readRepoFile('understand-anything-plugin/skills/understand/SKILL.md');

    expect(content).toContain('generated-artifact-only');
    expect(content).toContain('intentionally advances nothing for generated-artifact-only commits');
  });

  it('dashboard runs only the local viewer (contract D)', () => {
    const content = readRepoFile('understand-anything-plugin/skills/understand-dashboard/SKILL.md');

    expect(content).not.toMatch(/<(?:dashboard-dir|plugin-root|project-dir)>/);
    expect(content).toMatch(/PROJECT_DIR=\$\(pwd -P\)/);
    expect(content).toMatch(/UA_DIR="\$PROJECT_DIR\/\.understand-anything"/);
    expect(content).toMatch(/\[ ! -f "\$UA_DIR\/knowledge-graph\.json" \]/);
    expect(content).toMatch(/VIEWER_DIR="\$PLUGIN_ROOT\/packages\/viewer"/);
    expect(content).toMatch(/: "\$\{PLUGIN_ROOT:\?Run step 2 first so PLUGIN_ROOT is set\}"/);
    expect(content).toMatch(/: "\$\{PROJECT_DIR:\?Run step 1 first so PROJECT_DIR is set\}"/);
    expect(content).toContain(
      'cd "$PLUGIN_ROOT" && pnpm install --frozen-lockfile && pnpm --filter understand-anything-viewer build',
    );
    expect(content).toContain('node "$VIEWER_DIR/bin/viewer.mjs" "$PROJECT_DIR"');

    // Nothing is downloaded or run from the internet.
    const commands = [...content.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n');
    expect(commands).not.toMatch(/\bnpx\b/);
    expect(commands).not.toMatch(/https?:\/\//);
    expect(commands).not.toMatch(/releases\/download/);
    expect(commands).not.toMatch(/\bcurl\b|\bwget\b/);
    expect(content).not.toMatch(/\|\|\s*pnpm install/);
  });

  it('marks project-controlled context as untrusted data', () => {
    const understand = readRepoFile('understand-anything-plugin/skills/understand/SKILL.md');
    const knowledge = readRepoFile('understand-anything-plugin/skills/understand-knowledge/SKILL.md');

    expect(understand).not.toMatch(/README and manifest are authoritative/i);
    expect(understand).toMatch(/untrusted project data/i);
    expect(knowledge).toMatch(/untrusted article data/i);
  });
});
