#!/usr/bin/env bash
# Understand the Job installer (macOS / Linux)
#
# Installs a PINNED release: the clone is checked out at the tag in UTJ_REF
# (default v1.0.0), never at a moving branch. `--update` re-fetches that same
# ref; to move to a newer release, set UTJ_REF to its tag. Nothing here uses
# sudo or writes outside $HOME.
#
# Usage:
#   ./install.sh                       Prompt for platform
#   ./install.sh <platform>            Install for <platform>
#   ./install.sh --update              Re-fetch the pinned ref (UTJ_REF)
#   ./install.sh --uninstall <plat>    Remove links for <plat>
#   ./install.sh --help
#
# Recommended (read the script before you run it):
#   curl -fsSLO https://raw.githubusercontent.com/Ahmad986Ferdaws/understand-the-job/v1.0.0/install.sh
#   less install.sh
#   bash install.sh codex
#
# Curl-pipe usage (script and checkout are both pinned to the same tag):
#   curl -fsSL https://raw.githubusercontent.com/Ahmad986Ferdaws/understand-the-job/v1.0.0/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/Ahmad986Ferdaws/understand-the-job/v1.0.0/install.sh | bash -s codex
#
# Environment:
#   UTJ_REF       Tag (or branch) to install (default: v1.0.0)
#   UTJ_REPO_URL  Override clone URL (default: the official GitHub repo)
#   UTJ_DIR       Override clone destination (default: $HOME/.understand-the-job/repo)

set -euo pipefail

UTJ_REF="${UTJ_REF:-v1.0.0}"
REPO_URL="${UTJ_REPO_URL:-https://github.com/Ahmad986Ferdaws/understand-the-job.git}"
REPO_DIR="${UTJ_DIR:-$HOME/.understand-the-job/repo}"
REPO_DIR="${REPO_DIR%/}"
# The SKILL.md files resolve the plugin through this exact path, so it keeps
# the upstream name. Do not rename it without changing every skill.
PLUGIN_LINK="$HOME/.understand-anything-plugin"

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

# Platform table — id|skills-target-dir|style
# style "per-skill": one symlink per skill into the target dir
# style "folder":    one symlink for the whole skills/ dir into the target,
#                    named "understand-anything"
platforms_table() {
  cat <<EOF
gemini|$HOME/.agents/skills|per-skill
codex|$HOME/.agents/skills|per-skill
opencode|$HOME/.agents/skills|per-skill
pi|$HOME/.agents/skills|per-skill
openclaw|$HOME/.openclaw/skills|folder
antigravity|$HOME/.gemini/antigravity/skills|folder
vibe|$HOME/.vibe/skills|per-skill
vscode|$HOME/.copilot/skills|per-skill
hermes|$HOME/.hermes/skills|folder
cline|$HOME/.cline/skills|folder
kimi|$HOME/.kimi-code/skills|folder
trae|$HOME/.trae/skills|per-skill
nanobot|$HOME/.nanobot/workspace/skills|per-skill
kiro|$HOME/.kiro/skills|per-skill
EOF
}

platform_ids() { platforms_table | cut -d'|' -f1; }

resolve_platform() {
  local id="$1"
  local row
  row="$(platforms_table | awk -F'|' -v id="$id" '$1==id {print; exit}')"
  if [[ -z "$row" ]]; then
    printf 'Unknown platform: %s\n' "$id" >&2
    printf 'Supported: %s\n' "$(platform_ids | tr '\n' ' ')" >&2
    exit 1
  fi
  printf '%s\n' "$row"
}

prompt_platform() {
  local ids=()
  while IFS= read -r id; do ids+=("$id"); done < <(platform_ids)

  printf 'Which platform are you installing for?\n' >&2
  local i=1
  for id in "${ids[@]}"; do
    printf '  %d) %s\n' "$i" "$id" >&2
    i=$((i+1))
  done
  printf 'Choose [1-%d]: ' "${#ids[@]}" >&2

  local choice=""
  if { exec 3</dev/tty; } 2>/dev/null; then
    read -r choice <&3 || true
    exec 3<&-
  else
    read -r choice || true
  fi
  if [[ -z "$choice" ]]; then
    printf '\nNo input received. Pass the platform as an argument instead, e.g.:\n' >&2
    printf '  install.sh codex\n' >&2
    exit 1
  fi
  if ! [[ "$choice" =~ ^[0-9]+$ ]] || (( choice < 1 || choice > ${#ids[@]} )); then
    printf 'Invalid choice: %s\n' "$choice" >&2
    exit 1
  fi
  printf '%s\n' "${ids[$((choice-1))]}"
}

# Both values come from the environment and end up on a git command line, so
# reject anything that git could read as an option or a command-running
# transport.
validate_inputs() {
  case "$UTJ_REF" in
    ""|-*|*..*|*[!A-Za-z0-9._/-]*)
      die "Invalid UTJ_REF '$UTJ_REF': use a tag or branch name (letters, digits, . _ - /)." ;;
  esac
  case "$REPO_URL" in
    ""|-*|ext::*)
      die "Invalid UTJ_REPO_URL '$REPO_URL'." ;;
  esac
}

normalize_url() {
  local u="$1"
  u="${u%/}"
  u="${u%.git}"
  printf '%s' "$u" | tr '[:upper:]' '[:lower:]'
}

# Refuse to fetch into (or run scripts from) a checkout of some other repo,
# e.g. a leftover clone of the upstream project.
verify_origin() {
  local actual
  actual="$(git -C "$REPO_DIR" remote get-url origin 2>/dev/null || true)"
  if [[ "$(normalize_url "$actual")" != "$(normalize_url "$REPO_URL")" ]]; then
    printf 'Refusing to use the existing checkout at %s.\n' "$REPO_DIR" >&2
    printf "  its 'origin' is: %s\n" "${actual:-<none>}" >&2
    printf '  this installer is for: %s\n' "$REPO_URL" >&2
    printf 'Remove that directory, or point UTJ_DIR / UTJ_REPO_URL at a matching one, and run again.\n' >&2
    exit 1
  fi
}

# Detached checkout of the pinned ref. Never `git pull`: that would follow
# whatever a branch points at today instead of the release that was pinned.
sync_checkout() {
  if [[ -d "$REPO_DIR/.git" ]]; then
    verify_origin
    printf -- '→ Fetching %s in %s\n' "$UTJ_REF" "$REPO_DIR"
    git -C "$REPO_DIR" fetch --quiet --depth 1 origin "$UTJ_REF"
    git -C "$REPO_DIR" -c advice.detachedHead=false checkout --quiet --detach FETCH_HEAD
  else
    if [[ -e "$REPO_DIR" && -n "$(ls -A "$REPO_DIR" 2>/dev/null)" ]]; then
      die "$REPO_DIR exists and is not a git checkout; refusing to clone into it."
    fi
    printf -- '→ Cloning %s (%s) → %s\n' "$REPO_URL" "$UTJ_REF" "$REPO_DIR"
    mkdir -p "$(dirname "$REPO_DIR")"
    git -c advice.detachedHead=false clone --branch "$UTJ_REF" --depth 1 -- "$REPO_URL" "$REPO_DIR"
  fi
  printf '  at %s (%s)\n' "$UTJ_REF" "$(git -C "$REPO_DIR" rev-parse --short HEAD)"
}

skills_root() { printf '%s\n' "$REPO_DIR/understand-anything-plugin/skills"; }
plugin_root() { printf '%s\n' "$REPO_DIR/understand-anything-plugin"; }

list_skills() {
  local root
  root="$(skills_root)"
  if [[ ! -d "$root" ]]; then
    printf 'Skills directory not found: %s\n' "$root" >&2
    exit 1
  fi
  local d
  for d in "$root"/*/; do
    [[ -d "$d" ]] || continue
    basename "$d"
  done
}

# True when $1 is a symlink this installer could have made: it points at our
# skills dir or something inside it. Links to any other checkout (for example
# a leftover upstream install) are never ours to remove.
is_our_skill_link() {
  local link="$1" resolved root
  [[ -L "$link" ]] || return 1
  resolved="$(readlink "$link" 2>/dev/null || true)"
  root="$(skills_root)"
  [[ "$resolved" == "$root" || "$resolved" == "$root/"* ]]
}

# True when <target>/<style> still holds at least one of our links.
links_present() {
  local target="$1" style="$2" link
  [[ -d "$target" ]] || return 1
  case "$style" in
    per-skill)
      for link in "$target"/*; do
        is_our_skill_link "$link" && return 0
      done
      return 1
      ;;
    folder)
      is_our_skill_link "$target/understand-anything"
      ;;
    *)
      return 1
      ;;
  esac
}

link_skills() {
  local target="$1" style="$2"
  local root
  root="$(skills_root)"
  mkdir -p "$target"
  case "$style" in
    per-skill)
      local skill
      # Pass 1: never write through a real file/dir the user already has there.
      while IFS= read -r skill; do
        if [[ -e "$target/$skill" && ! -L "$target/$skill" ]]; then
          die "$target/$skill already exists and is not a symlink; refusing to replace it. Move it away and run again."
        fi
      done < <(list_skills)
      while IFS= read -r skill; do
        ln -sfn "$root/$skill" "$target/$skill"
        printf '  ✓ %s → %s\n' "$target/$skill" "$root/$skill"
      done < <(list_skills)
      ;;
    folder)
      if [[ -e "$target/understand-anything" && ! -L "$target/understand-anything" ]]; then
        die "$target/understand-anything already exists and is not a symlink; refusing to replace it. Move it away and run again."
      fi
      ln -sfn "$root" "$target/understand-anything"
      printf '  ✓ %s → %s\n' "$target/understand-anything" "$root"
      ;;
    *)
      printf 'Unknown style: %s\n' "$style" >&2
      exit 1
      ;;
  esac
}

unlink_skills() {
  local target="$1" style="$2"
  [[ -d "$target" ]] || return 0
  local link
  case "$style" in
    per-skill)
      # Scan the target dir instead of listing the checkout's skills, so this
      # still cleans up after the checkout has been deleted — and only ever
      # removes links that point into our own skills dir.
      for link in "$target"/*; do
        is_our_skill_link "$link" && rm -f "$link"
      done
      ;;
    folder)
      link="$target/understand-anything"
      is_our_skill_link "$link" && rm -f "$link"
      ;;
  esac
  return 0
}

# The universal plugin root link is read by the SKILL.md files. Refuse to
# adopt a link that points somewhere else (a leftover upstream install would
# make the skills run that code instead of this checkout).
check_plugin_link() {
  local want have
  want="$(plugin_root)"
  if [[ -L "$PLUGIN_LINK" ]]; then
    have="$(readlink "$PLUGIN_LINK")"
    if [[ "$have" != "$want" ]]; then
      printf '%s already points to %s,\n' "$PLUGIN_LINK" "$have" >&2
      printf 'not to this install (%s).\n' "$want" >&2
      printf 'If it is a leftover from another install, remove it (rm "%s") and run again.\n' "$PLUGIN_LINK" >&2
      exit 1
    fi
  elif [[ -e "$PLUGIN_LINK" ]]; then
    die "$PLUGIN_LINK exists and is not a symlink; refusing to touch it."
  fi
}

link_plugin_root() {
  if [[ -L "$PLUGIN_LINK" ]]; then
    printf '  • %s already linked\n' "$PLUGIN_LINK"
  else
    ln -s "$(plugin_root)" "$PLUGIN_LINK"
    printf '  ✓ %s → %s\n' "$PLUGIN_LINK" "$(plugin_root)"
  fi
}

cmd_install() {
  local id="$1"
  local row target style
  row="$(resolve_platform "$id")"
  target="$(printf '%s\n' "$row" | cut -d'|' -f2)"
  style="$(printf '%s\n' "$row" | cut -d'|' -f3)"

  validate_inputs
  sync_checkout
  check_plugin_link
  printf -- '→ Linking skills for %s (%s → %s)\n' "$id" "$style" "$target"
  link_skills "$target" "$style"
  printf -- '→ Linking universal plugin root\n'
  link_plugin_root

  if [[ "$id" == "kiro" ]]; then
    printf -- '→ Creating Kiro agent configuration\n'
    mkdir -p "$HOME/.kiro/agents"
    local plugin_root
    plugin_root="$(plugin_root)"

    # Build the "resources" list dynamically from the agent definitions in the
    # repo so it never drifts as agents are added or removed. Deterministic
    # order via LC_ALL=C sort; no external deps (no jq) so it runs anywhere.
    local resources="" agent_md
    while IFS= read -r agent_md; do
      [[ -n "$agent_md" ]] || continue
      [[ -n "$resources" ]] && resources+=$',\n'
      resources+="    \"file://$agent_md\""
    done < <(find "$plugin_root/agents" -maxdepth 1 -type f -name '*.md' | LC_ALL=C sort)

    cat > "$HOME/.kiro/agents/understand.json" <<KIROEOF
{
  "name": "understand",
  "description": "Analyze codebase into interactive knowledge graph — Understand the Job",
  "prompt": "file://$plugin_root/skills/understand/SKILL.md",
  "tools": ["read", "write", "shell", "grep", "glob", "code", "subagent"],
  "resources": [
$resources
  ]
}
KIROEOF
    printf '  ✓ %s\n' "$HOME/.kiro/agents/understand.json"
  fi

  printf '\n✓ Installed Understand the Job %s for %s\n' "$UTJ_REF" "$id"
  printf '  Restart your CLI or IDE to pick up the skills.\n'
  if [[ "$id" == "codex" ]]; then
    printf '\n  Tip: Codex invokes skills with $ instead of / — type $understand, not /understand.\n'
  fi
  if [[ "$id" == "vscode" ]]; then
    printf '\n  Tip: VS Code can also auto-discover the plugin by opening this repo\n'
    printf '       directly (it reads .copilot-plugin/plugin.json), no symlinks needed.\n'
  fi
  if [[ "$id" == "kiro" ]]; then
    printf '\n  Usage: kiro-cli chat --agent understand "Analyze this project"\n'
  fi
}

cmd_uninstall() {
  local id="$1"
  local row target style
  row="$(resolve_platform "$id")"
  target="$(printf '%s\n' "$row" | cut -d'|' -f2)"
  style="$(printf '%s\n' "$row" | cut -d'|' -f3)"

  printf -- '→ Removing skill links for %s\n' "$id"
  unlink_skills "$target" "$style"
  if [[ "$id" == "kiro" && -f "$HOME/.kiro/agents/understand.json" ]]; then
    rm -f "$HOME/.kiro/agents/understand.json"
    printf '  ✓ removed %s\n' "$HOME/.kiro/agents/understand.json"
  fi

  # The plugin root link is shared by every platform: keep it while any other
  # platform still has skill links in place. Platforms that share this one's
  # target dir and style share the very same links, so they went with it.
  local others="" oid otarget ostyle
  while IFS='|' read -r oid otarget ostyle; do
    [[ "$oid" == "$id" ]] && continue
    [[ "$otarget" == "$target" && "$ostyle" == "$style" ]] && continue
    if links_present "$otarget" "$ostyle"; then
      others+="${others:+, }$oid"
    fi
  done < <(platforms_table)

  if [[ -n "$others" ]]; then
    printf '  • kept %s — still used by: %s\n' "$PLUGIN_LINK" "$others"
  elif [[ -L "$PLUGIN_LINK" ]]; then
    if [[ "$(readlink "$PLUGIN_LINK")" == "$(plugin_root)" ]]; then
      rm -f "$PLUGIN_LINK"
      printf '  ✓ removed %s\n' "$PLUGIN_LINK"
    else
      printf '  • left %s alone — it does not point at this install\n' "$PLUGIN_LINK"
    fi
  fi

  if [[ -d "$REPO_DIR" ]]; then
    printf '\nThe checkout at %s was kept (other platforms may still use it).\n' "$REPO_DIR"
    printf 'To remove it: rm -rf "%s"\n' "$REPO_DIR"
  fi
}

cmd_update() {
  if [[ ! -d "$REPO_DIR/.git" ]]; then
    printf 'No installation found at %s. Run install first.\n' "$REPO_DIR" >&2
    exit 1
  fi
  validate_inputs
  sync_checkout
  printf '✓ Updated (pinned to %s).\n' "$UTJ_REF"
}

usage() {
  cat <<USAGE
Understand the Job installer

Usage:
  install.sh [<platform>]            Install for <platform> (or prompt if omitted)
  install.sh --update                Re-fetch the pinned ref (skills update through symlinks)
  install.sh --uninstall <platform>  Remove links for <platform>
  install.sh --help

Supported platforms:
$(platform_ids | sed 's/^/  - /')

Environment:
  UTJ_REF       Tag (or branch) to install (default: v1.0.0)
  UTJ_REPO_URL  Override clone URL (default: official repo)
  UTJ_DIR       Override clone destination (default: \$HOME/.understand-the-job/repo)
USAGE
}

main() {
  case "${1:-}" in
    -h|--help)
      usage
      ;;
    --update)
      cmd_update
      ;;
    --uninstall)
      shift
      if [[ -z "${1:-}" ]]; then
        printf '%s\n' '--uninstall requires a platform argument' >&2
        usage >&2
        exit 1
      fi
      cmd_uninstall "$1"
      ;;
    "")
      local id
      id="$(prompt_platform)"
      cmd_install "$id"
      ;;
    -*)
      printf 'Unknown option: %s\n' "$1" >&2
      usage >&2
      exit 1
      ;;
    *)
      cmd_install "$1"
      ;;
  esac
}

main "$@"
