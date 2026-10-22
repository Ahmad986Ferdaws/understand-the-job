# understand-anything-viewer

Standalone read-only viewer for [Understand the Job](https://github.com/Ahmad986Ferdaws/understand-the-job) knowledge graphs (a hardened fork of Understand-Anything by Egonex-AI, MIT). It opens the full interactive dashboard for a graph that was already generated with `/understand` — no Claude Code, no LLM, no API key. Running it needs only Node.js (>= 18); building it from source uses the repository's toolchain (Node >= 22, pnpm).

## Usage

Run it from a local clone of the repository. Nothing is downloaded or run from a URL.

```bash
# from the repository root, once (and again after changing the dashboard)
pnpm install --frozen-lockfile
pnpm --filter understand-anything-viewer build

# then, for any project that has a .ua/knowledge-graph.json
node understand-anything-plugin/packages/viewer/bin/viewer.mjs /path/to/analyzed/project
```

The project directory (default: current directory) must contain a data directory — `.ua/` or legacy `.understand-anything/` — with a `knowledge-graph.json`. The terminal prints a tokenized URL (`http://127.0.0.1:<port>/?token=…`) and tries to open it in your browser; if no browser can be opened (headless Linux, WSL, a container) it says so and you open the URL yourself.

Options: `--port <n>` (default 5173, auto-increments if taken), `--no-open`.

## What it will and will not do

The analyzed project is treated as untrusted. The viewer:

- binds to `127.0.0.1` only and refuses requests whose `Host` header is not `127.0.0.1:<port>` or `localhost:<port>` (DNS-rebinding guard);
- gates every data endpoint behind a random one-time token, compared in constant time;
- never reads a symlinked data file, and serves a source file only if the knowledge graph lists it **and** its real path (symlinks resolved) stays inside the project root;
- serves HTML with a strict Content-Security-Policy, so the page cannot request fonts, images, scripts or data from any other host;
- is read-only and sends nothing off your machine.

## Building a standalone tarball (maintainers)

```bash
pnpm --filter understand-anything-viewer pack:release
```

The pack step builds the dashboard and embeds its compiled `dist/` into the package, producing a self-contained, zero-dependency tarball. It is for local use; the viewer is not meant to be fetched and run from a URL.
