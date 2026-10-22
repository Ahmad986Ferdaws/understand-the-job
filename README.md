<h1 align="center">Understand the Job</h1>

<p align="center">
  <strong>Turn any codebase, knowledge base, or docs into an interactive knowledge graph you can explore, search, and ask questions about.</strong>
  <br />
  <em>Works with Claude Code, Codex, Cursor, Copilot, Gemini CLI, and more.</em>
</p>

<p align="center">
  Hardened fork of <a href="https://github.com/Egonex-AI/Understand-Anything">Understand-Anything</a> by Egonex-AI (MIT)
</p>

<p align="center">
  <a href="#quick-start"><img src="https://img.shields.io/badge/Quick_Start-blue" alt="Quick Start" /></a>
  <a href="#security-model"><img src="https://img.shields.io/badge/Security_model-2ea44f" alt="Security model" /></a>
  <a href="https://github.com/Ahmad986Ferdaws/understand-the-job/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow" alt="License: MIT" /></a>
  <a href="https://docs.anthropic.com/en/docs/claude-code"><img src="https://img.shields.io/badge/Claude_Code-8A2BE2" alt="Claude Code" /></a>
  <a href="#platform-compatibility"><img src="https://img.shields.io/badge/Codex-000000" alt="Codex" /></a>
  <a href="#vs-code--github-copilot"><img src="https://img.shields.io/badge/Copilot-24292e" alt="Copilot" /></a>
  <a href="#copilot-cli"><img src="https://img.shields.io/badge/Copilot_CLI-24292e" alt="Copilot CLI" /></a>
  <a href="#platform-compatibility"><img src="https://img.shields.io/badge/Gemini_CLI-4285F4" alt="Gemini CLI" /></a>
  <a href="#platform-compatibility"><img src="https://img.shields.io/badge/OpenCode-38bdf8" alt="OpenCode" /></a>
  <a href="#platform-compatibility"><img src="https://img.shields.io/badge/Vibe_CLI-7c3aed" alt="Vibe CLI" /></a>
  <a href="#platform-compatibility"><img src="https://img.shields.io/badge/Trae-7e22ce" alt="Trae" /></a>
</p>

---

**You just joined a new team. The codebase is 200,000 lines of code. Where do you even start?**

Understand the Job is a [Claude Code Plugin](https://code.claude.com/docs/en/plugins-reference#plugins-reference) that analyzes your project with a multi-agent pipeline, builds a knowledge graph of every file, function, class, and dependency, then gives you an interactive dashboard to explore it all visually. Stop reading code blind. Start seeing the big picture.

> **The goal isn't a graph that wows you with how complex your codebase is — it's a graph that quietly teaches you how every piece fits together.**

It is built to be safer to run on code you did not write. The features are the upstream project's; what this fork changes is what the tool is allowed to do while it works. See the [Security model](#security-model) and [Changes from upstream](#changes-from-upstream).

---

## Features

### Explore the structural graph

Navigate your codebase as an interactive knowledge graph — every file, function, and class is a node you can click, search, and explore. Select any node to see plain-English summaries, relationships, and guided tours.

### Understand business logic

Switch to the domain view and see how your code maps to real business processes — domains, flows, and steps laid out as a horizontal graph.

### Analyze knowledge bases

Point `/understand-knowledge` at a [Karpathy-pattern LLM wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) and get a force-directed knowledge graph with community clustering. The deterministic parser extracts wikilinks and categories from `index.md`, then LLM agents discover implicit relationships, extract entities, and surface claims — turning your wiki into a navigable graph of interconnected ideas.

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>Guided Tours</h3>
      <p>Auto-generated walkthroughs of the architecture, ordered by dependency. Learn the codebase in the right order.</p>
    </td>
    <td width="50%" valign="top">
      <h3>Fuzzy Search</h3>
      <p>Find anything by name, tag, or summary text across the graph. (The "semantic" toggle in the search bar is not wired up yet.)</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>Diff Impact Analysis</h3>
      <p>See which parts of the system your changes affect before you commit. Understand ripple effects across the codebase.</p>
    </td>
    <td width="50%" valign="top">
      <h3>Persona-Adaptive UI</h3>
      <p>The dashboard adjusts its detail level based on who you are — junior dev, PM, or power user.</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>Layer Visualization</h3>
      <p>Automatic grouping by architectural layer — API, Service, Data, UI, Utility — with color-coded legend.</p>
    </td>
    <td width="50%" valign="top">
      <h3>Language Concepts</h3>
      <p>12 programming patterns (generics, closures, decorators, etc.) explained in context wherever they appear.</p>
    </td>
  </tr>
</table>

---

## Quick Start

### 1. Install the plugin

```bash
/plugin marketplace add Ahmad986Ferdaws/understand-the-job
/plugin install understand-the-job
```

Other platforms (Codex, Gemini CLI, OpenCode, ...) use the installer, which is pinned to a release tag — see [Multi-Platform Installation](#multi-platform-installation).

> **Using a local model?** For privacy or enterprise setups, point your platform at a local model provider such as [Ollama](https://docs.ollama.com/integrations) — follow their integration guide to change the model provider.

### 2. Analyze your codebase

```bash
/understand
```

A multi-agent pipeline scans your project, extracts every file, function, class, and dependency, then builds a knowledge graph saved to `.ua/knowledge-graph.json`. (Projects that already have a `.understand-anything/` directory keep using it — it stays the data directory when present, so nothing needs migrating.)

> **Heads up on token usage:** The initial `/understand` analyzes your whole codebase and can consume a significant number of tokens on large projects. We recommend running it on a token plan / subscription, or using a local model (see above) for initialization. Subsequent runs are incremental by default — only changed files are re-analyzed — so they use far fewer tokens.

**Localized output:** Use `--language` to generate content in your preferred language:

```bash
# Generate Chinese content (知识图节点描述和 Dashboard UI)
/understand --language zh

# Supported languages: en (default), zh, zh-TW, ja, ko, ru, vi
```

On the **first run** in a project — when you don't pass `--language` and no language is stored yet — `/understand` detects the language you're conversing in. If it isn't English, it asks you to confirm (or override) before generating; English conversations are unaffected. Your choice is saved to `.ua/config.json` and reused on every later run. That file is a local preference file — see [Do not commit `.ua/config.json`](#do-not-commit-uaconfigjson).

The `--language` parameter affects:
- Node summaries and descriptions in the knowledge graph
- Dashboard UI labels, buttons, and tooltips
- Guided tour explanations

### 3. Explore the dashboard

```bash
/understand-dashboard
```

An interactive web dashboard opens with your codebase visualized as a graph — color-coded by architectural layer, searchable, and clickable. Select any node to see its code, relationships, and a plain-English explanation. The dashboard is built from this plugin's own sources; nothing is downloaded when you run it.

### 4. Keep learning

```bash
# Ask anything about the codebase
/understand-chat How does the payment flow work?

# Analyze impact of your current changes
/understand-diff

# Deep-dive into a specific file or function
/understand-explain src/auth/login.ts

# Generate an onboarding guide for new team members
/understand-onboard

# Extract business domain knowledge (domains, flows, steps)
/understand-domain

# Analyze a Karpathy-pattern LLM wiki knowledge base
/understand-knowledge ~/path/to/wiki

# Re-run anytime — incremental by default (only re-analyzes changed files)
/understand

# Opt THIS project in (for you only) to "graph is out of date" reminders
/understand --auto-update
/understand --no-auto-update   # opt back out

# Scope to a subdirectory (for huge monorepos)
/understand src/frontend
```

---

## Multi-Platform Installation

Understand the Job works across multiple AI coding platforms.

### Claude Code (Native)

```bash
/plugin marketplace add Ahmad986Ferdaws/understand-the-job
/plugin install understand-the-job
```


### One-line install (Codex / OpenCode / OpenClaw / Antigravity / Gemini CLI / Pi Agent / Vibe CLI / VS Code Copilot / Hermes / Cline / KIMI CLI / Trae / Nanobot / Kiro)

The installer is **pinned to a release tag** (`v1.0.0`): both the script you download and the checkout it makes come from that tag, never from a moving branch. It needs no `sudo` and writes only under your home directory. Read it before you run it:

**macOS / Linux:**
```bash
curl -fsSLO https://raw.githubusercontent.com/Ahmad986Ferdaws/understand-the-job/v1.0.0/install.sh
less install.sh
bash install.sh codex      # or run it with no argument to pick from a menu
```

If you accept the risk of running a script you have not read, the one-liner is:
```bash
curl -fsSL https://raw.githubusercontent.com/Ahmad986Ferdaws/understand-the-job/v1.0.0/install.sh | bash -s codex
```

**Windows (PowerShell):**
```powershell
iwr -useb https://raw.githubusercontent.com/Ahmad986Ferdaws/understand-the-job/v1.0.0/install.ps1 -OutFile install.ps1
Get-Content install.ps1          # read it first
./install.ps1 codex              # or run it with no argument to pick from a menu
```

The installer clones the repo to `~/.understand-the-job/repo` at the pinned tag and creates the right symlinks for the chosen platform. Restart your CLI/IDE afterwards. It refuses to reuse an existing checkout whose `origin` is a different repository, and it never runs `git pull` on a branch. To install a different release, set `UTJ_REF` to its tag (for example `UTJ_REF=v1.1.0 bash install.sh codex`).

> **Note on invoking skills:** the invocation prefix differs per platform. Most platforms use slash commands (`/understand`), but **Codex uses `$` instead** — type `$understand`, not `/understand`. If neither prefix is recognized on your platform, just ask in plain language: *"Use the understand skill to analyze this project."*

- Supported `<platform>` values: `gemini`, `codex`, `opencode`, `pi`, `openclaw`, `antigravity`, `vibe`, `vscode`, `hermes`, `cline`, `kimi`, `trae`, `nanobot`, `kiro`
- Update later (re-fetches the pinned tag; use `UTJ_REF=<new tag>` to move to a newer release):
  - macOS / Linux: `bash ~/.understand-the-job/repo/install.sh --update`
  - Windows: `& "$HOME/.understand-the-job/repo/install.ps1" -Update`
- Uninstall (the shared `~/.understand-anything-plugin` link stays until the last platform is removed):
  - macOS / Linux: `bash ~/.understand-the-job/repo/install.sh --uninstall <platform>`
  - Windows: `& "$HOME/.understand-the-job/repo/install.ps1" -Uninstall <platform>`

### Cursor

Cursor auto-discovers the plugin via `.cursor-plugin/plugin.json` when this repo is cloned. No manual installation needed — just clone and open in Cursor.

If auto-discovery doesn't pick it up, install it manually: open **Cursor Settings → Plugins**, paste `https://github.com/Ahmad986Ferdaws/understand-the-job` into the search field, and add it from there.

### VS Code + GitHub Copilot

VS Code with GitHub Copilot (v1.108+) auto-discovers the plugin via `.copilot-plugin/plugin.json` when this repo is cloned. No manual installation needed — just clone and open in VS Code.

For personal skills (available across all projects), run the `install.sh` above with the `vscode` platform.

### Copilot CLI

```bash
copilot plugin install Ahmad986Ferdaws/understand-the-job:understand-anything-plugin
```

### Kiro CLI / IDE

```bash
bash install.sh kiro     # after downloading and reading install.sh as above
```

After installation:
- **Kiro CLI**: `kiro-cli chat --agent understand "Analyze this project"`
- **Kiro IDE**: The skills are symlinked into `~/.kiro/skills/` and the `understand` agent is written to `~/.kiro/agents/understand.json`, so both are available after restarting the IDE.

For personal skills (available across all projects), run the `install.sh` above with the `kiro` platform.

### Platform Compatibility

| Platform | Status | Install Method |
|----------|--------|----------------|
| Claude Code | Native | Plugin marketplace |
| Cursor | Supported | Auto-discovery |
| VS Code + GitHub Copilot | Supported | Auto-discovery |
| Copilot CLI | Supported | Plugin install |
| Codex | Supported | `install.sh codex` |
| OpenCode | Supported | `install.sh opencode` |
| OpenClaw | Supported | `install.sh openclaw` |
| Antigravity | Supported | `install.sh antigravity` |
| Gemini CLI | Supported | `install.sh gemini` |
| Pi Agent | Supported | `install.sh pi` |
| Vibe CLI | Supported | `install.sh vibe` |
| Hermes | Supported | `install.sh hermes` |
| Cline | Supported | `install.sh cline` |
| KIMI CLI | Supported | `install.sh kimi` |
| Trae | Supported | `install.sh trae` |
| Nanobot | Supported | `install.sh nanobot` |
| Kiro CLI / IDE | Supported | `install.sh kiro` |


---

## Security model

Analyzing a repository means reading files somebody else wrote. This fork assumes those files may be hostile and limits what the tool can be talked into doing. These are the guarantees; if a change makes one of them untrue, that is a bug.

- **Nothing turns itself on from inside a repository.** Auto-update is opt-in *per user*: the list of opted-in projects lives outside every repo, in `~/.understand-the-job/auto-update.json`, and `/understand --auto-update` / `--no-auto-update` edit it. An `autoUpdate` setting in a project's `.ua/config.json` is ignored.
- **Hooks only suggest, they never act.** A hook may print one line saying the graph looks out of date and that you should ask whether to run `/understand`. It does not run anything, does not tell the model to skip asking you, and only fires for projects you opted in.
- **Project content is data, not instructions.** Every agent starts with an "Untrusted input" rule: text found in source, comments, docs, configs, commit messages or file names is described, never obeyed, and the agent may only read inside the project and the plugin directory and write only the output files its prompt names. Every agent has an explicit tool list with no web tools. The agents that read raw project files (project-scanner, file-analyzer, domain-, article- and design-analyzer, assemble-reviewer) have **no shell**: the deterministic scripts they used to run now run in the main session, where you see them.
- **The data directory is checked before it is used.** `.ua/` (or the legacy `.understand-anything/`) is refused if it is a symlink, contains any symlink, or resolves outside the project. A hostile repo cannot point the tool's reads and writes at your home directory.
- **No code is downloaded at run time.** `/understand-dashboard` runs the dashboard built from this plugin's own sources; there is no `npx <url>` and no release tarball. Dependency installs use `pnpm install --frozen-lockfile` and stop on failure instead of falling back to an unlocked install.
- **The dashboard page talks to nobody else.** It uses system fonts, shows remote images in rendered markdown as placeholders, and a Content-Security-Policy blocks requests to any other host.
- **The dashboard server is local and gated.** It binds to localhost only, requires a random per-run token, rejects requests whose `Host` header is not localhost, and serves file contents only for paths in the graph, never through a symlink and never from outside the project.
- **Installers are pinned.** `install.sh` / `install.ps1` check out a release tag, refuse a checkout whose `origin` is another repository, never `git pull` a moving branch, and write nothing outside `$HOME`. CI pins every GitHub Action to a commit SHA and runs with a read-only token.

The one skill that deliberately talks to a remote service is `/understand-figma`, which calls the Figma API with your own `FIGMA_TOKEN` when you run it. Your model provider sees whatever the agents read, as with any LLM tool — use a local model if that matters (see above).

**Limits.** These rules shrink the attack surface; they do not make a hostile repository harmless.
- Prompt rules are followed by a model, not enforced by code. A clever enough injection in project text can still mislead an agent's *output* (wrong summaries, misleading tours).
- Three agents keep a shell, restricted by their prompt to one exact `node` command each: architecture-analyzer, tour-builder and graph-reviewer. They read the merged graph JSON, not raw source, but that JSON contains model-written text derived from the project.
- Your Claude Code permission mode is the last line of defence. Keep Claude asking before it runs commands when you analyze code you don't trust, or run the analysis in a container or throwaway VM.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

---

## Share the Graph with Your Team

The graph is just JSON — **commit it once, and teammates skip the pipeline**. Good for onboarding, PR reviews, and docs-as-code.

> **Example:** [GoogleCloudPlatform/microservices-demo](https://github.com/GoogleCloudPlatform/microservices-demo) — Go / Java / Python / Node reference with a committed graph.

**What to commit:** everything in `.ua/` *except* `intermediate/`, `tmp/`, `.trash-*/`, `diff-overlay.json` and `config.json` (those are local scratch or local preferences). (Legacy projects use `.understand-anything/` — substitute that directory name below if it's the one present.)

```gitignore
.ua/intermediate/
.ua/tmp/
.ua/.trash-*/
.ua/diff-overlay.json
.ua/config.json
```

**Keep it fresh:** each teammate who wants reminders runs `/understand --auto-update` for themselves (it is stored on their machine, not in the repo), or re-runs `/understand` manually before releases.

**Large graphs (10 MB+):** track with **git-lfs**.

```bash
git lfs install
git lfs track ".ua/*.json"
git add .gitattributes .ua/
```

### Do not commit `.ua/config.json`

`.ua/config.json` holds per-user preferences such as your output language. Keep it out of the repository (see the gitignore list above). A config file that arrives with a cloned repo is untrusted input, so this fork treats it that way: it can set a language, but it cannot switch behavior on, and `autoUpdate` in it is ignored.

### View the dashboard without Claude Code

Once a graph has been generated and committed, anyone on the team can open it from a clone of this repo — no Claude Code, no LLM, no API key. You need Node.js (>= 22) and pnpm (>= 10):

```bash
git clone --depth 1 --branch v1.0.0 https://github.com/Ahmad986Ferdaws/understand-the-job.git
cd understand-the-job
pnpm install --frozen-lockfile
pnpm --filter understand-anything-viewer build
node understand-anything-plugin/packages/viewer/bin/viewer.mjs /path/to/analyzed/project
```

The terminal prints a tokenized URL (`http://127.0.0.1:5173/?token=…`) and opens the full interactive dashboard in your browser. The project directory (default: current directory) must contain the committed data directory (`.ua/`, or legacy `.understand-anything/`). Everything is served read-only from local disk, bound to localhost — no LLM calls, no data leaves your machine.

Prefer the Vite dev server? `pnpm install --frozen-lockfile && pnpm --filter @understand-anything/core build`, then `GRAPH_DIR=/path/to/analyzed/project pnpm dev:dashboard` does the same.

---

## Changes from upstream

Forked from [Understand-Anything](https://github.com/Egonex-AI/Understand-Anything) at commit `b8c807c`. Same features, same slash commands, same data format.

**Security**
- Auto-update can no longer be enabled by a repository; it is an opt-in per user, stored outside the repo. Hooks are advisory only.
- Every agent has an explicit tool list (no web tools) and an "Untrusted input" rule; the agents that read raw project files have no shell.
- The data directory is refused when it contains symlinks or escapes the project, and graph files are written atomically without following symlinks.
- `/understand-figma` and `/understand-knowledge` refuse to overwrite an existing code graph unless you pass `--force`.
- The git freshness check validates commit hashes and reports "unknown" instead of "fresh" when git fails.
- The dashboard no longer downloads code at run time (the `npx <release tarball>` path is gone), makes no outside requests (CSP), and its local server checks token, `Host` header and symlinks.
- Installers are pinned to a release tag, refuse a foreign `origin`, and uninstalling one platform keeps the shared link other platforms still use.
- CI actions pinned to commit SHAs, read-only token, Dependabot for actions and npm.
- Removed the upstream marketing site, translated READMEs (they pointed at the upstream install), AI-generated planning docs, and the note to AI agents hidden in the old README.

**Correctness**
- Incremental runs keep edges that point *into* a re-analyzed file (calls, docs, config, inheritance) instead of dropping them for good.
- TypeScript re-exports (`export * from`, `export { x } from`) and dynamic `import()` produce import edges, so barrel files are no longer dead ends.
- `tsconfig` `extends`, `jsconfig.json`, `baseUrl`-only imports and workspace package names are resolved.
- Inverse edge-type aliases (`documented_by`, `triggers_on`) swap direction instead of pointing backwards.
- The dashboard filter panel changes the graph again; a stale access token returns you to the token screen.
- Scripts call `python3`, CI job steps no longer produce conflicting `step:` nodes, and binary artefacts (`.wasm`, `.so`, `.onnx`, …) are ignored by default.

---

## Under the Hood

### Tree-sitter + LLM hybrid

Static analysis and LLMs do what each does best:

- **Tree-sitter (deterministic)** — parses source into a concrete syntax tree and extracts structural facts: imports, exports, function/class definitions, call sites, inheritance. Pre-resolved into an `importMap` during the scan phase and passed to file-analyzers so they don't re-derive imports from source. Same input → same output, every run. Also powers fingerprint-based change detection for incremental updates.
- **LLM (semantic)** — reads the parsed structure alongside the original source to produce what parsers can't: plain-English summaries, tags, architectural layer assignments, business-domain mapping, guided tours, language concept callouts.

This split is why the graph is reproducible on the structural side (the same code always yields the same edges) while still capturing intent on the semantic side (what a file is *for*, not just what it imports).

### Multi-Agent Pipeline

Ten agent definitions live in `understand-anything-plugin/agents/`. `/understand` orchestrates six of them; the domain, knowledge-base and Figma skills add their own, and one is a reference agent for questions about a finished graph:

| Agent                   | Role                                                                                                               | Used By                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| `project-scanner`       | Discovers files, detects languages and frameworks                                                                  | `/understand`           |
| `file-analyzer`         | Extracts functions, classes, imports; produces graph nodes and edges                                               | `/understand`           |
| `assemble-reviewer`     | Reviews the merged batch output for semantic gaps the merge script cannot fix                                      | `/understand`           |
| `architecture-analyzer` | Identifies architectural layers                                                                                    | `/understand`           |
| `tour-builder`          | Generates guided learning tours                                                                                    | `/understand`           |
| `graph-reviewer`        | Validates graph completeness and referential integrity. Runs inline by default; use `--review` for full LLM review | `/understand`           |
| `domain-analyzer`       | Extracts business domains, flows, and process steps                                                                | `/understand-domain`    |
| `article-analyzer`      | Extracts entities, claims, and implicit relationships from wiki articles                                           | `/understand-knowledge` |
| `design-analyzer`       | Adds summaries and tags to a Figma design graph                                                                    | `/understand-figma`     |
| `knowledge-graph-guide` | Explains graph structure and dashboard usage to users                                                              | on request              |

File analyzers run in parallel, up to 5 concurrent workers and 20–30 files per batch.

The pipeline also supports incremental updates: only files changed since the last run are re-analyzed.


---

## Contributing

Contributions are welcome! Here's how to get started:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Run the tests (`pnpm --filter @understand-anything/core test` and `pnpm test`)
4. Commit your changes and open a pull request

Please open an issue first for major changes so we can discuss the approach. Read [CONTRIBUTING.md](CONTRIBUTING.md) first: any change that runs code, writes files, or touches the network has to keep the [Security model](#security-model) above true.

---

<p align="center">
  <strong>Stop reading code blind. Start understanding everything.</strong>
</p>

<p align="center">
  MIT License. Original work &copy; its upstream authors; modifications &copy; 2026 Ahmad986Ferdaws. See <a href="LICENSE">LICENSE</a>.
</p>
