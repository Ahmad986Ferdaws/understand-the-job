# Contributing to Understand the Job

Thank you for your interest in contributing to Understand the Job! This project is a hardened fork of [Understand-Anything](https://github.com/Egonex-AI/Understand-Anything) (MIT). This document provides guidelines and instructions for contributing to it.

## 🌟 Ways to Contribute

- **Bug Reports**: Found a bug? Open an issue with detailed reproduction steps
- **Feature Requests**: Have an idea? Share it in the issues section
- **Documentation**: Improve the documentation
- **Code**: Fix bugs, add features, or improve performance
- **Testing**: Write tests to improve code coverage

## 🚀 Getting Started

### Prerequisites

- Node.js >= 22 (developed on v24)
- pnpm >= 10 (pinned via `packageManager` field in root `package.json`)
- Git for version control

### Setup

1. **Fork and Clone**
   ```bash
   git clone https://github.com/YOUR_USERNAME/understand-the-job.git
   cd understand-the-job
   ```

2. **Install Dependencies**
   ```bash
   pnpm install --frozen-lockfile
   ```
   Use a plain `pnpm install` only when your change adds or updates a dependency, and commit the updated `pnpm-lock.yaml` with it.

3. **Build Core Package**
   ```bash
   pnpm --filter @understand-anything/core build
   ```

4. **Run Tests**
   ```bash
   pnpm --filter @understand-anything/core test
   pnpm test
   ```

5. **Start Dashboard (Optional)**
   ```bash
   pnpm dev:dashboard
   ```

## 🔒 Security rules

This fork exists to be safe to run on code you did not write. The **Security model** section of the [README](README.md#security-model) is a promise to users, so:

> **Any change that runs code, writes files, or touches the network must keep the Security model in README true.**

In practice:

- Treat everything read from an analyzed project as untrusted data. Agent prompts keep their `## Untrusted input` section, and agents get only the tools they need.
- Anything that reads or writes the data directory (`.ua/` or `.understand-anything/`) goes through the safe-data-directory check first.
- A repository must never be able to switch something on. Opt-ins live in `~/.understand-the-job/`, not in project files; hooks may only suggest.
- No downloading and running code at run time, no network calls from the dashboard page, and no new remote hosts in the Content-Security-Policy.
- Pin what you add: GitHub Actions to a full commit SHA, dependencies through the lockfile.
- If a change makes a sentence in the Security model false, update the sentence and say why in the PR description — and expect that PR to get extra scrutiny.

Report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md).

## 📝 Development Workflow

### 1. Create a Branch

Create a descriptive branch name:
```bash
git checkout -b feat/my-feature        # For new features
git checkout -b fix/bug-description    # For bug fixes
git checkout -b docs/update-readme     # For documentation
```

### 2. Make Changes

- Write clean, readable code
- Follow existing code style and conventions
- Add tests for new functionality
- Update documentation as needed

### 3. Test Your Changes

```bash
# Run all tests
pnpm --filter @understand-anything/core test
pnpm test

# Python helper tests (the same loop CI uses; `tests/` has no __init__.py)
python3 -m unittest $(git ls-files 'tests/**/test_*.py' | sed 's#/#.#g; s#\.py$##') -v

# Run linter
pnpm lint

# Build packages
pnpm build
```

### 4. Commit Your Changes

Write clear, descriptive commit messages:
```bash
git add .
git commit -m "feat: add keyboard shortcuts to dashboard"
```

**Commit Message Convention:**
- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation changes
- `style:` - Code style changes (formatting, etc.)
- `refactor:` - Code refactoring
- `test:` - Adding or updating tests
- `chore:` - Maintenance tasks

### 5. Push and Create Pull Request

```bash
git push origin your-branch-name
```

Then open a Pull Request on GitHub with:
- Clear title describing the change
- Detailed description of what changed and why
- Link to related issues (if any)
- Screenshots (for UI changes)

## 🧪 Testing Guidelines

### Large Repository Benchmarks

Use the [large monorepo benchmark](docs/benchmarks/large-monorepo.md) to collect
reproducible scale, timing, and memory reports from projects that are too large
for CI fixtures. The guide includes a pinned TensorFlow example and explains
which deterministic stages are measured.

### Writing Tests

- Use Vitest for testing
- Place tests in `__tests__` directories or `*.test.ts` files
- Aim for high test coverage for new features
- Test edge cases and error conditions

Example test structure:
```typescript
import { describe, it, expect } from 'vitest';

describe('MyFeature', () => {
  it('should do something', () => {
    // Arrange
    const input = 'test';

    // Act
    const result = myFunction(input);

    // Assert
    expect(result).toBe('expected');
  });
});
```

### Running Tests

```bash
# Run skill and dashboard tests from the repository root
pnpm test

# Run core package tests (excluded from the root suite)
pnpm --filter @understand-anything/core test

# Run tests in watch mode
pnpm --filter @understand-anything/core test --watch
```

Run both commands for the complete test coverage used by CI. The root Vitest config covers `tests/skill/`, plugin source, and dashboard tests; it excludes the core package. The skill package's own `test` script only prints a reminder to run `pnpm test` from the repository root.

## 📚 Code Style Guidelines

### TypeScript

- Use TypeScript strict mode
- Define explicit types for function parameters and return values
- Avoid `any` type - use `unknown` if type is truly unknown
- Use interfaces for object shapes
- Use type aliases for unions and complex types

### Formatting

- The project uses ESLint for code quality
- Consistent indentation (2 spaces)
- Use meaningful variable and function names
- Keep functions small and focused

### React/Dashboard

- Use functional components with hooks
- Keep components focused and single-purpose
- Use Zustand for state management
- Follow the existing component structure

### Tech Stack

TypeScript, pnpm workspaces, React 19, Vite, TailwindCSS v4, React Flow, Zustand, web-tree-sitter, Fuse.js, Zod, Dagre

### File Organization

```
understand-anything-plugin/
├── packages/
│   ├── core/              # Core analysis engine
│   │   ├── src/
│   │   └── package.json
│   └── dashboard/         # React dashboard
│       ├── src/
│       │   ├── components/
│       │   ├── utils/
│       │   └── store.ts
│       └── package.json
├── src/                   # Plugin skills implementation
├── agents/                # AI agent prompts
└── skills/                # Skill definitions
```

## 🐛 Bug Reports

When reporting bugs, include:

- **Description**: Clear description of the issue
- **Steps to Reproduce**: Detailed steps to reproduce the bug
- **Expected Behavior**: What you expected to happen
- **Actual Behavior**: What actually happened
- **Environment**: OS, Node version, pnpm version
- **Screenshots**: If applicable
- **Error Messages**: Full error output

## 💡 Feature Requests

When requesting features:

- **Use Case**: Describe the problem you're trying to solve
- **Proposed Solution**: How you envision the feature working
- **Alternatives**: Other solutions you've considered
- **Additional Context**: Any other relevant information

## 📋 Pull Request Checklist

Before submitting a PR, ensure:

- [ ] Code follows the project's style guidelines
- [ ] Core tests and root skill/dashboard tests pass (`pnpm --filter @understand-anything/core test` and `pnpm test`)
- [ ] New code has test coverage
- [ ] Documentation is updated (if needed)
- [ ] The README Security model is still true (see Security rules above)
- [ ] Version bumped in all six manifests listed in `CLAUDE.md` (only if the change is user-visible)
- [ ] Commit messages follow convention
- [ ] PR description clearly explains changes
- [ ] No console.log or debug code left behind
- [ ] Branch is up to date with main

## 🤝 Code Review Process

1. **Automated Checks**: CI runs tests and linting
2. **Maintainer Review**: Project maintainers review the code
3. **Feedback**: Address any requested changes
4. **Approval**: Once approved, PR will be merged
5. **Cleanup**: Delete your branch after merge

## 📞 Getting Help

- **Issues**: For bugs and feature requests
- **Discussions**: For questions and general discussion
- **Documentation**: Check existing docs first

## 📄 License

By contributing, you agree that your contributions will be licensed under the MIT License.

## 🙏 Recognition

Contributors will be recognized in:
- GitHub contributors list
- Release notes (for significant contributions)
- Special mentions for exceptional contributions

---

**Thank you for contributing to Understand the Job! Your contributions help make code understanding accessible to everyone.** 🚀
