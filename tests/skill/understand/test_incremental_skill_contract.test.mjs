import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const skill = readFileSync(
  resolve(__dirname, '../../../understand-anything-plugin/skills/understand/SKILL.md'),
  'utf-8',
);
const analyzer = readFileSync(
  resolve(__dirname, '../../../understand-anything-plugin/agents/file-analyzer.md'), 'utf-8',
);

describe('incremental execution contract', () => {
  it('routes inventory and baseline updates through bundled helpers', () => {
    expect(skill).toContain('prepare-incremental.mjs');
    expect(skill).toContain('finalize-incremental.mjs');
    expect(skill).toContain('filesToReanalyze');
    expect(skill).toContain('batch-existing.json');
    expect(skill).toContain('generated-artifact-only');
  });

  it('has a single incremental path: hooks no longer ship their own update prompt', () => {
    expect(
      existsSync(resolve(__dirname, '../../../understand-anything-plugin/hooks/auto-update-prompt.md')),
    ).toBe(false);
  });

  it('skips whole-graph LLM phases for ordinary partial updates', () => {
    expect(skill).toContain('Both incremental actions skip assemble-reviewer');
    expect(skill).toContain('For `PARTIAL_UPDATE`, dispatch no architecture agent');
    expect(skill).toContain('For `PARTIAL_UPDATE`, dispatch no tour agent');
    expect(skill).toContain('Without `--review`');
    expect(skill).toContain('Do not run Phase 6');
  });

  it('keeps explicit review and architecture escalation behavior', () => {
    expect(skill).toContain('The user-facing `--review` option is still honored');
    expect(skill).toContain('where `rerunArchitecture === true`');
    expect(skill).toContain('where `rerunTour === true`');
    expect(skill).toContain('`FULL_UPDATE`');
    expect(skill).toContain('With explicit `--review`');
    expect(skill).toContain('jump to the `--review` graph-reviewer path in Phase 6');
  });

  it('requires deterministic symbol checking and one targeted repair', () => {
    expect(skill).toContain('incremental-symbol-baseline.json');
    expect(skill).toContain('validate-incremental-symbols.mjs');
    expect(skill).toContain('incremental-symbol-report.json');
    expect(skill).toContain('prepare-symbol-retry.mjs');
    expect(skill).toContain('incremental-symbol-retry.json');
    expect(skill).toContain('previousSymbols');
    expect(skill).toContain('missingSymbols');
    expect(skill).toContain('independently reruns the shared symbol');
  });

  it('runs structural extraction in the main session for incremental and repair batches', () => {
    expect(skill).toContain('run the structural extraction step above on the incremental `batches.json`');
    expect(skill).toContain(
      'Run the structural extraction step with `$BATCHES_FILE` set to `$UA_DIR/intermediate/incremental-symbol-retry.json`',
    );
  });

  it('keeps significance filtering for new symbols but requires accounting for old methods', () => {
    expect(analyzer).toContain('New symbols continue to use the filter above');
    expect(analyzer).toContain('classes[].methods');
    expect(analyzer).toContain('check the complete `previousSymbols` checklist');
    expect(analyzer).toContain('explicitly report an error with its ID/name');
  });
});
