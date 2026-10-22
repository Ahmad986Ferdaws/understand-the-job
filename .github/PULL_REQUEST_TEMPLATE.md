## Summary

<!-- One or two sentences on what this PR changes and why. -->

## Linked issue(s)

<!-- e.g. Closes #123, Refs #456. Leave empty if there's no tracking issue. -->

## How I tested this

<!-- Concrete steps. "Ran the test suite" is fine; "Ran /understand on a 3k-file
Swift repo and verified the dashboard shows non-empty edges" is better. -->

- [ ] `pnpm lint`
- [ ] `pnpm --filter @understand-anything/core test`
- [ ] `pnpm test`
- [ ] Python helper tests (see CONTRIBUTING.md), if you touched `tests/**/test_*.py` or the Python scripts
- [ ] Manual smoke test (describe above)

## Security model

<!-- Any change that runs code, writes files, or touches the network must keep
the "Security model" in README.md true. -->

- [ ] This PR doesn't run code, write files, or touch the network, OR the README Security model is still true after it (explain below if the wording changed)

## Versioning

<!-- If this PR ships a user-visible behavior change, bump the version in ALL
six manifests per CLAUDE.md. If it's docs/tests/internal-only, leave them
alone and the maintainer will bump on merge. -->

- [ ] Version bumped in all six manifests, OR
- [ ] N/A — internal/docs-only change
