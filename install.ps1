<#
.SYNOPSIS
  Understand the Job installer for Windows (PowerShell).

.DESCRIPTION
  Clones the repo and creates skill symlinks/junctions for the chosen platform.
  Installs a PINNED release: the clone is checked out at the tag in $env:UTJ_REF
  (default v1.0.0), never at a moving branch. -Update re-fetches that same ref;
  to move to a newer release, set UTJ_REF to its tag.

.EXAMPLE
  ./install.ps1                       # prompt for platform
  ./install.ps1 codex                 # install for codex
  ./install.ps1 -Update               # re-fetch the pinned ref
  ./install.ps1 -Uninstall codex      # remove links for codex

.NOTES
  Environment:
    UTJ_REF       Tag (or branch) to install (default: v1.0.0)
    UTJ_REPO_URL  Override clone URL (default: the official GitHub repo)
    UTJ_DIR       Override clone destination (default: %USERPROFILE%\.understand-the-job\repo)
#>

param(
    [Parameter(Position = 0)]
    [string]$Platform,
    [switch]$Update,
    [string]$Uninstall,
    [switch]$Help
)

$ErrorActionPreference = 'Stop'

$UtjRef     = if ($env:UTJ_REF)      { $env:UTJ_REF }      else { 'v1.0.0' }
$RepoUrl    = if ($env:UTJ_REPO_URL) { $env:UTJ_REPO_URL } else { 'https://github.com/Ahmad986Ferdaws/understand-the-job.git' }
$RepoDir    = if ($env:UTJ_DIR)      { $env:UTJ_DIR }      else { Join-Path $HOME '.understand-the-job\repo' }
$RepoDir    = $RepoDir.TrimEnd('\', '/')
# The SKILL.md files resolve the plugin through this exact path, so it keeps
# the upstream name. Do not rename it without changing every skill.
$PluginLink = Join-Path $HOME '.understand-anything-plugin'

# Platform table - Target = skills directory; Style = "per-skill" | "folder"
$Platforms = [ordered]@{
    gemini      = @{ Target = (Join-Path $HOME '.agents\skills');             Style = 'per-skill' }
    codex       = @{ Target = (Join-Path $HOME '.agents\skills');             Style = 'per-skill' }
    opencode    = @{ Target = (Join-Path $HOME '.agents\skills');             Style = 'per-skill' }
    pi          = @{ Target = (Join-Path $HOME '.agents\skills');             Style = 'per-skill' }
    openclaw    = @{ Target = (Join-Path $HOME '.openclaw\skills');           Style = 'folder' }
    antigravity = @{ Target = (Join-Path $HOME '.gemini\antigravity\skills'); Style = 'folder' }
    vibe        = @{ Target = (Join-Path $HOME '.vibe\skills');               Style = 'per-skill' }
    vscode      = @{ Target = (Join-Path $HOME '.copilot\skills');            Style = 'per-skill' }
    hermes      = @{ Target = (Join-Path $HOME '.hermes\skills');             Style = 'folder' }
    cline       = @{ Target = (Join-Path $HOME '.cline\skills');              Style = 'folder' }
    kimi        = @{ Target = (Join-Path $HOME '.kimi-code\skills');          Style = 'folder' }
    trae        = @{ Target = (Join-Path $HOME '.trae\skills');               Style = 'per-skill' }
    nanobot     = @{ Target = (Join-Path $HOME '.nanobot\workspace\skills');  Style = 'per-skill' }
    kiro        = @{ Target = (Join-Path $HOME '.kiro\skills');               Style = 'per-skill' }
}

function Show-Usage {
    @"
Understand the Job installer (Windows)

Usage:
  install.ps1 [<platform>]                Install for <platform> (or prompt if omitted)
  install.ps1 -Update                     Re-fetch the pinned ref
  install.ps1 -Uninstall <platform>       Remove links for <platform>
  install.ps1 -Help

Supported platforms:
$($Platforms.Keys -join ', ')

Environment:
  UTJ_REF       Tag (or branch) to install (default: v1.0.0)
  UTJ_REPO_URL  Override clone URL (default: official repo)
  UTJ_DIR       Override clone destination (default: %USERPROFILE%\.understand-the-job\repo)
"@
}

function Resolve-Platform([string]$Id) {
    if (-not $Platforms.Contains($Id)) {
        Write-Error "Unknown platform: $Id. Supported: $($Platforms.Keys -join ', ')"
    }
    return $Platforms[$Id]
}

function Prompt-Platform {
    $ids = @($Platforms.Keys)
    Write-Host 'Which platform are you installing for?'
    for ($i = 0; $i -lt $ids.Count; $i++) {
        Write-Host ("  {0}) {1}" -f ($i + 1), $ids[$i])
    }
    $choice = Read-Host ("Choose [1-{0}]" -f $ids.Count)
    $n = 0
    if (-not [int]::TryParse($choice, [ref]$n) -or $n -lt 1 -or $n -gt $ids.Count) {
        Write-Error "Invalid choice: $choice"
    }
    return $ids[$n - 1]
}

function Get-SkillsRoot { Join-Path $RepoDir 'understand-anything-plugin\skills' }
function Get-PluginRoot { Join-Path $RepoDir 'understand-anything-plugin' }

function Invoke-Git([string[]]$GitArgs) {
    # Native commands do not honour $ErrorActionPreference, so check the exit code.
    & git @GitArgs
    if ($LASTEXITCODE -ne 0) { Write-Error "git $($GitArgs -join ' ') failed (exit $LASTEXITCODE)" }
}

# Both values come from the environment and end up on a git command line, so
# reject anything that git could read as an option or a command-running
# transport.
function Assert-ValidInputs {
    if ($UtjRef -notmatch '^[A-Za-z0-9._/][A-Za-z0-9._/-]*$' -or $UtjRef.Contains('..')) {
        Write-Error "Invalid UTJ_REF '$UtjRef': use a tag or branch name (letters, digits, . _ - /)."
    }
    if ([string]::IsNullOrEmpty($RepoUrl) -or $RepoUrl.StartsWith('-') -or $RepoUrl.StartsWith('ext::')) {
        Write-Error "Invalid UTJ_REPO_URL '$RepoUrl'."
    }
}

function ConvertTo-NormalizedUrl([string]$Url) {
    $u = $Url.TrimEnd('/')
    if ($u.EndsWith('.git')) { $u = $u.Substring(0, $u.Length - 4) }
    return $u.ToLowerInvariant()
}

# Refuse to fetch into (or run scripts from) a checkout of some other repo,
# e.g. a leftover clone of the upstream project.
function Assert-OriginMatches {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $actual = [string](& git -C $RepoDir remote get-url origin 2>$null) }
    finally { $ErrorActionPreference = $prev }
    if ((ConvertTo-NormalizedUrl $actual) -ne (ConvertTo-NormalizedUrl $RepoUrl)) {
        if (-not $actual) { $actual = '<none>' }
        Write-Error ("Refusing to use the existing checkout at $RepoDir.`n" +
            "  its 'origin' is: $actual`n" +
            "  this installer is for: $RepoUrl`n" +
            "Remove that directory, or point UTJ_DIR / UTJ_REPO_URL at a matching one, and run again.")
    }
}

# Detached checkout of the pinned ref. Never `git pull`: that would follow
# whatever a branch points at today instead of the release that was pinned.
function Sync-Checkout {
    if (Test-Path (Join-Path $RepoDir '.git')) {
        Assert-OriginMatches
        Write-Host "-> Fetching $UtjRef in $RepoDir"
        Invoke-Git @('-C', $RepoDir, 'fetch', '--quiet', '--depth', '1', 'origin', $UtjRef)
        Invoke-Git @('-C', $RepoDir, '-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', 'FETCH_HEAD')
    } else {
        if ((Test-Path $RepoDir) -and (Get-ChildItem -LiteralPath $RepoDir -Force | Select-Object -First 1)) {
            Write-Error "$RepoDir exists and is not a git checkout; refusing to clone into it."
        }
        Write-Host "-> Cloning $RepoUrl ($UtjRef) -> $RepoDir"
        $parent = Split-Path -Parent $RepoDir
        if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent | Out-Null }
        Invoke-Git @('-c', 'advice.detachedHead=false', 'clone', '--branch', $UtjRef, '--depth', '1', '--', $RepoUrl, $RepoDir)
    }
    $short = (& git -C $RepoDir rev-parse --short HEAD)
    Write-Host "  at $UtjRef ($short)"
}

function Get-SkillNames {
    $root = Get-SkillsRoot
    if (-not (Test-Path $root)) { Write-Error "Skills directory not found: $root" }
    Get-ChildItem -Path $root -Directory | Select-Object -ExpandProperty Name
}

function Test-IsReparse([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if (-not $item) { return $false }
    return ($item.LinkType -eq 'Junction' -or $item.LinkType -eq 'SymbolicLink')
}

function Remove-Reparse([string]$Path) {
    # Removes a junction/symlink without touching its target. Refuses to touch
    # real files or directories so an existing user folder at the same path is
    # never destroyed.
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if (-not $item) { return $false }
    if ($item.LinkType -eq 'Junction' -or $item.LinkType -eq 'SymbolicLink') {
        $item.Delete()
        return $true
    }
    Write-Warning "Refusing to delete $Path - it is a real file/directory, not a junction/symlink we created. Remove it manually if you intended to."
    return $false
}

function New-Junction([string]$LinkPath, [string]$TargetPath) {
    if (Get-Item -LiteralPath $LinkPath -Force -ErrorAction SilentlyContinue) {
        if (Test-IsReparse $LinkPath) {
            (Get-Item -LiteralPath $LinkPath -Force).Delete()
        } else {
            Write-Error "Refusing to overwrite $LinkPath - it is a real file/directory, not a junction. Move or remove it first."
        }
    }
    New-Item -ItemType Junction -Path $LinkPath -Target $TargetPath | Out-Null
}

function Link-Skills([string]$Target, [string]$Style) {
    $root = Get-SkillsRoot
    if (-not (Test-Path $Target)) { New-Item -ItemType Directory -Path $Target | Out-Null }

    switch ($Style) {
        'per-skill' {
            # Pass 1: never replace a real file/dir the user already has there.
            foreach ($skill in Get-SkillNames) {
                $link = Join-Path $Target $skill
                if ((Get-Item -LiteralPath $link -Force -ErrorAction SilentlyContinue) -and -not (Test-IsReparse $link)) {
                    Write-Error "$link already exists and is not a junction/symlink; refusing to replace it. Move it away and run again."
                }
            }
            foreach ($skill in Get-SkillNames) {
                $link = Join-Path $Target $skill
                $src  = Join-Path $root $skill
                New-Junction $link $src
                Write-Host "  OK $link -> $src"
            }
        }
        'folder' {
            $link = Join-Path $Target 'understand-anything'
            New-Junction $link $root
            Write-Host "  OK $link -> $root"
        }
        default { Write-Error "Unknown style: $Style" }
    }
}

function Get-LinkTarget([string]$Path) {
    # Target of a junction/symlink, or $null when $Path is not one.
    # Get-Item (not Test-Path) so a dangling link, e.g. after the checkout was deleted, still counts.
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if (-not $item) { return $null }
    if ($item.LinkType -ne 'Junction' -and $item.LinkType -ne 'SymbolicLink') { return $null }
    return [string](@($item.Target)[0])
}

function Test-SamePath([string]$A, [string]$B) {
    return ($A.TrimEnd('\', '/') -ieq $B.TrimEnd('\', '/'))
}

# True when $Path is a link this installer could have made: it points at our
# skills dir or something inside it. Links to any other checkout (for example
# a leftover upstream install) are never ours to remove.
function Test-IsOurSkillLink([string]$Path) {
    $t = Get-LinkTarget $Path
    if (-not $t) { return $false }
    $root = Get-SkillsRoot
    return ((Test-SamePath $t $root) -or $t.StartsWith($root.TrimEnd('\', '/') + '\', [System.StringComparison]::OrdinalIgnoreCase))
}

# True when <Target>/<Style> still holds at least one of our links.
function Test-LinksPresent([string]$Target, [string]$Style) {
    if (-not (Test-Path -LiteralPath $Target)) { return $false }
    switch ($Style) {
        'per-skill' {
            foreach ($child in Get-ChildItem -LiteralPath $Target -Force) {
                if (Test-IsOurSkillLink $child.FullName) { return $true }
            }
            return $false
        }
        'folder' { return (Test-IsOurSkillLink (Join-Path $Target 'understand-anything')) }
        default  { return $false }
    }
}

function Unlink-Skills([string]$Target, [string]$Style) {
    if (-not (Test-Path -LiteralPath $Target)) { return }
    switch ($Style) {
        'per-skill' {
            # Scan the target dir instead of listing the checkout's skills, so
            # this still cleans up after the checkout has been deleted - and
            # only ever removes links that point into our own skills dir.
            foreach ($child in @(Get-ChildItem -LiteralPath $Target -Force)) {
                if (Test-IsOurSkillLink $child.FullName) { Remove-Reparse $child.FullName | Out-Null }
            }
        }
        'folder' {
            $link = Join-Path $Target 'understand-anything'
            if (Test-IsOurSkillLink $link) { Remove-Reparse $link | Out-Null }
        }
    }
}

# The universal plugin root link is read by the SKILL.md files. Refuse to
# adopt a link that points somewhere else (a leftover upstream install would
# make the skills run that code instead of this checkout).
function Assert-PluginLinkUsable {
    $want = Get-PluginRoot
    if (-not (Get-Item -LiteralPath $PluginLink -Force -ErrorAction SilentlyContinue)) { return }
    $have = Get-LinkTarget $PluginLink
    if (-not $have) {
        Write-Error "$PluginLink exists and is not a junction/symlink; refusing to touch it."
    }
    if (-not (Test-SamePath $have $want)) {
        Write-Error ("$PluginLink already points to $have,`n" +
            "not to this install ($want).`n" +
            "If it is a leftover from another install, remove it (Remove-Item '$PluginLink') and run again.")
    }
}

function Link-Plugin-Root {
    if (Get-Item -LiteralPath $PluginLink -Force -ErrorAction SilentlyContinue) {
        Write-Host "  * $PluginLink already linked"
    } else {
        $src = Get-PluginRoot
        New-Item -ItemType Junction -Path $PluginLink -Target $src | Out-Null
        Write-Host "  OK $PluginLink -> $src"
    }
}

function ConvertTo-FileUri([string]$Path) {
    # Produce a forward-slashed file URI (Windows: file:///C:/path/...).
    return 'file:///' + ($Path -replace '\\', '/')
}

function Cmd-Install([string]$Id) {
    $cfg = Resolve-Platform $Id
    Assert-ValidInputs
    Sync-Checkout
    Assert-PluginLinkUsable
    Write-Host "-> Linking skills for $Id ($($cfg.Style) -> $($cfg.Target))"
    Link-Skills $cfg.Target $cfg.Style
    Write-Host '-> Linking universal plugin root'
    Link-Plugin-Root

    if ($Id -eq 'kiro') {
        Write-Host '-> Creating Kiro agent configuration'
        $agentsDir = Join-Path $HOME '.kiro\agents'
        if (-not (Test-Path $agentsDir)) { New-Item -ItemType Directory -Path $agentsDir | Out-Null }
        $pluginRoot = Get-PluginRoot

        # Build the "resources" list dynamically from the agent definitions in
        # the repo so it never drifts as agents are added or removed.
        $resources = @(
            Get-ChildItem -Path (Join-Path $pluginRoot 'agents') -Filter '*.md' -File |
                Sort-Object Name |
                ForEach-Object { ConvertTo-FileUri $_.FullName }
        )
        $agent = [ordered]@{
            name        = 'understand'
            description = 'Analyze codebase into interactive knowledge graph - Understand the Job'
            prompt      = ConvertTo-FileUri (Join-Path $pluginRoot 'skills\understand\SKILL.md')
            tools       = @('read', 'write', 'shell', 'grep', 'glob', 'code', 'subagent')
            resources   = $resources
        }
        $agentJson = Join-Path $agentsDir 'understand.json'
        # WriteAllText emits UTF-8 without a BOM on every PowerShell version.
        [System.IO.File]::WriteAllText($agentJson, ($agent | ConvertTo-Json -Depth 5))
        Write-Host "  OK $agentJson"
    }

    Write-Host "`nOK Installed Understand the Job $UtjRef for $Id"
    Write-Host '  Restart your CLI or IDE to pick up the skills.'
    if ($Id -eq 'codex') {
        Write-Host "`n  Tip: Codex invokes skills with `$ instead of / - type `$understand, not /understand."
    }
    if ($Id -eq 'vscode') {
        Write-Host "`n  Tip: VS Code can also auto-discover the plugin by opening this repo"
        Write-Host '       directly (it reads .copilot-plugin/plugin.json), no symlinks needed.'
    }
    if ($Id -eq 'kiro') {
        Write-Host "`n  Usage: kiro-cli chat --agent understand `"Analyze this project`""
    }
}

function Cmd-Uninstall([string]$Id) {
    $cfg = Resolve-Platform $Id
    Write-Host "-> Removing skill links for $Id"
    Unlink-Skills $cfg.Target $cfg.Style
    if ($Id -eq 'kiro') {
        $agentJson = Join-Path $HOME '.kiro\agents\understand.json'
        if (Test-Path $agentJson) {
            Remove-Item -LiteralPath $agentJson -Force
            Write-Host "  OK removed $agentJson"
        }
    }
    # The plugin root link is shared by every platform: keep it while any other
    # platform still has skill links in place. Platforms that share this one's
    # target dir and style share the very same links, so they went with it.
    $others = @()
    foreach ($oid in $Platforms.Keys) {
        if ($oid -eq $Id) { continue }
        $o = $Platforms[$oid]
        if ((Test-SamePath $o.Target $cfg.Target) -and $o.Style -eq $cfg.Style) { continue }
        if (Test-LinksPresent $o.Target $o.Style) { $others += $oid }
    }
    if ($others.Count -gt 0) {
        Write-Host "  * kept $PluginLink - still used by: $($others -join ', ')"
    } elseif (Get-Item -LiteralPath $PluginLink -Force -ErrorAction SilentlyContinue) {
        $have = Get-LinkTarget $PluginLink
        if ($have -and (Test-SamePath $have (Get-PluginRoot))) {
            if (Remove-Reparse $PluginLink) { Write-Host "  OK removed $PluginLink" }
        } else {
            Write-Host "  * left $PluginLink alone - it does not point at this install"
        }
    }
    if (Test-Path $RepoDir) {
        Write-Host "`nThe checkout at $RepoDir was kept (other platforms may still use it)."
        Write-Host "To remove it: Remove-Item -Recurse -Force '$RepoDir'"
    }
}

function Cmd-Update {
    if (-not (Test-Path (Join-Path $RepoDir '.git'))) {
        Write-Error "No installation found at $RepoDir. Run install first."
    }
    Assert-ValidInputs
    Sync-Checkout
    Write-Host "OK Updated (pinned to $UtjRef)."
}

if ($Help) { Show-Usage; return }
if ($Update) { Cmd-Update; return }
if ($Uninstall) { Cmd-Uninstall $Uninstall; return }

if (-not $Platform) { $Platform = Prompt-Platform }
Cmd-Install $Platform
