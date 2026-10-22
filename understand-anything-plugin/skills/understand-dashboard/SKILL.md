---
name: understand-dashboard
description: Launch the interactive web dashboard to visualize a codebase's knowledge graph
argument-hint: "[project-path]"
---

# /understand-dashboard

Start the Understand Anything dashboard to visualize the knowledge graph for the current project.

## Instructions

1. Determine the project directory and data directory:
   - If `$ARGUMENTS` contains a path, use that as the project directory
   - Otherwise, use the current working directory
   - Prefer the legacy `.understand-anything/` data directory when it exists, otherwise use `.ua/`

   Use the Bash tool to resolve:
   ```bash
   PROJECT_ARG="$ARGUMENTS"
   if [ -n "$PROJECT_ARG" ]; then
     PROJECT_DIR=$(cd "$PROJECT_ARG" 2>/dev/null && pwd -P)
   else
     PROJECT_DIR=$(pwd -P)
   fi

   if [ -z "$PROJECT_DIR" ] || [ ! -d "$PROJECT_DIR" ]; then
     echo "Error: Project directory not found: ${PROJECT_ARG:-$PWD}"
     exit 1
   fi

   if [ -d "$PROJECT_DIR/.understand-anything" ]; then
     UA_DIR="$PROJECT_DIR/.understand-anything"
   else
     UA_DIR="$PROJECT_DIR/.ua"
   fi
   ```

2. Find the plugin root. The dashboard is served by the plugin's own viewer at `packages/viewer/` relative to this plugin's root directory. Check these roots in order and use the first that contains `packages/viewer/bin/viewer.mjs`:
   - `${CLAUDE_PLUGIN_ROOT}` (Claude Code runtime root, highest priority)
   - `~/.understand-anything-plugin` (universal symlink, all installs)
   - Two levels up from `~/.agents/skills/understand-dashboard` real path (self-relative fallback)
   - Two levels up from `~/.copilot/skills/understand-dashboard` real path (Copilot personal skills fallback)
   - Common clone-based install roots:
     - `~/.codex/understand-anything/understand-anything-plugin`
     - `~/.opencode/understand-anything/understand-anything-plugin`
     - `~/.pi/understand-anything/understand-anything-plugin`
     - `~/understand-anything/understand-anything-plugin`

   Use the Bash tool to resolve:
   ```bash
   SKILL_REAL=$(realpath ~/.agents/skills/understand-dashboard 2>/dev/null || readlink -f ~/.agents/skills/understand-dashboard 2>/dev/null || echo "")
   SELF_RELATIVE=$([ -n "$SKILL_REAL" ] && cd "$SKILL_REAL/../.." 2>/dev/null && pwd || echo "")
   COPILOT_SKILL_REAL=$(realpath ~/.copilot/skills/understand-dashboard 2>/dev/null || readlink -f ~/.copilot/skills/understand-dashboard 2>/dev/null || echo "")
   COPILOT_SELF_RELATIVE=$([ -n "$COPILOT_SKILL_REAL" ] && cd "$COPILOT_SKILL_REAL/../.." 2>/dev/null && pwd || echo "")

   PLUGIN_ROOT=""
   for candidate in \
     "${CLAUDE_PLUGIN_ROOT}" \
     "$HOME/.understand-anything-plugin" \
     "$SELF_RELATIVE" \
     "$COPILOT_SELF_RELATIVE" \
     "$HOME/.codex/understand-anything/understand-anything-plugin" \
     "$HOME/.opencode/understand-anything/understand-anything-plugin" \
     "$HOME/.pi/understand-anything/understand-anything-plugin" \
     "$HOME/understand-anything/understand-anything-plugin"; do
     if [ -n "$candidate" ] && [ -f "$candidate/packages/viewer/bin/viewer.mjs" ]; then
       PLUGIN_ROOT="$candidate"; break
     fi
   done

   if [ -z "$PLUGIN_ROOT" ]; then
     echo "Error: Cannot find the understand-the-job plugin root."
     echo "Checked:"
     echo "  - ${CLAUDE_PLUGIN_ROOT:-<unset CLAUDE_PLUGIN_ROOT>}"
     echo "  - $HOME/.understand-anything-plugin"
     echo "  - ${SELF_RELATIVE:-<unresolved path derived from ~/.agents/skills/understand-dashboard>}"
     echo "  - ${COPILOT_SELF_RELATIVE:-<unresolved path derived from ~/.copilot/skills/understand-dashboard>}"
     echo "  - $HOME/.codex/understand-anything/understand-anything-plugin"
     echo "  - $HOME/.opencode/understand-anything/understand-anything-plugin"
     echo "  - $HOME/.pi/understand-anything/understand-anything-plugin"
     echo "  - $HOME/understand-anything/understand-anything-plugin"
     echo "Make sure you followed the installation instructions for your platform."
     exit 1
   fi

   VIEWER_DIR="$PLUGIN_ROOT/packages/viewer"
   ```

3. **Data directory safety check.** Before anything reads the data directory, run the bundled check:
   ```bash
   : "${PLUGIN_ROOT:?Run step 2 first so PLUGIN_ROOT is set}"
   : "${PROJECT_DIR:?Run step 1 first so PROJECT_DIR is set}"
   node "$PLUGIN_ROOT/skills/understand/ensure-safe-data-dir.mjs" "$PROJECT_DIR"
   ```
   If it exits non-zero, show its one-line reason to the user and **STOP**. It rejects a data directory (`.ua/`, or legacy `.understand-anything/`) that is a symlink, contains a symlink, or resolves outside the project, which could otherwise make the dashboard serve files from elsewhere on disk.

4. Check that `$UA_DIR/knowledge-graph.json` exists in the project directory. If not, tell the user:
   ```
   No knowledge graph found. Run /understand first to analyze this project.
   ```

   Use the Bash tool to check:
   ```bash
   if [ ! -f "$UA_DIR/knowledge-graph.json" ]; then
     echo "No knowledge graph found. Run /understand first to analyze this project."
     exit 1
   fi
   ```

5. **Build the local viewer if needed.** The viewer embeds a build of the plugin's own dashboard; nothing is downloaded or run from the internet. Build it only when its output is missing:
   ```bash
   : "${PLUGIN_ROOT:?Run step 2 first so PLUGIN_ROOT is set}"
   VIEWER_DIR="${VIEWER_DIR:-$PLUGIN_ROOT/packages/viewer}"
   if [ ! -f "$VIEWER_DIR/dist/index.html" ] || [ ! -f "$VIEWER_DIR/bin/dist/staleness.js" ]; then
     cd "$PLUGIN_ROOT" && pnpm install --frozen-lockfile && pnpm --filter understand-anything-viewer build
   fi
   ```
   If `pnpm install --frozen-lockfile` or the build fails, relay the error and **STOP**. Never fall back to `pnpm install` without `--frozen-lockfile`, to `npx`, or to a downloaded prebuilt viewer.

6. Start the viewer, pointing at the project's knowledge graph:
   ```bash
   : "${PROJECT_DIR:?Run step 1 first so PROJECT_DIR is set}"
   : "${VIEWER_DIR:?Run step 2 first so VIEWER_DIR is set}"
   node "$VIEWER_DIR/bin/viewer.mjs" "$PROJECT_DIR"
   ```
   Run this in the background so the user can continue working.

7. **Capture the access token URL from the server output.** The viewer prints a line like:
   ```
   🔑  Dashboard URL: http://127.0.0.1:<PORT>?token=<TOKEN>
   ```
   Extract the full URL including the `?token=` parameter. The token is required to access the knowledge graph data — without it the dashboard will show an "Access Token Required" gate.

8. Report to the user, including the full tokenized URL:
   ```
   Dashboard started at http://127.0.0.1:<PORT>?token=<TOKEN>
   Viewing: $UA_DIR/knowledge-graph.json

   The dashboard is running in the background. Press Ctrl+C in the terminal to stop it.
   ```
   **Important:** Always include the `?token=` parameter in the URL you share. If you omit it, the user will be blocked by the token gate and have to manually find the token in the terminal output.

## Notes

- The dashboard runs from the plugin's own local sources (`packages/viewer`, which embeds the built `packages/dashboard`). It never downloads or runs code from the internet: no `npx <url>`, no release tarballs, and dependency installs use only `pnpm install --frozen-lockfile`
- The viewer binds to `127.0.0.1`, serves the graph read-only, and gates every data endpoint behind the one-time `?token=`
- The dashboard auto-opens in the default browser
- If port 5173 is already in use, the next available port is picked
- After a plugin update, delete `packages/viewer/dist` so step 5 rebuilds the viewer from the updated sources
