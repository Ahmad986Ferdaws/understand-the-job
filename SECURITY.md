# Reporting security issues

Thanks for taking the time to disclose responsibly.

## How to report

Please use GitHub's [private vulnerability reporting](https://github.com/Ahmad986Ferdaws/understand-the-job/security/advisories/new)
on this repository. That keeps the report visible to the maintainer without
exposing the details publicly. (How it works:
[GitHub docs](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability).)

If private reporting is unavailable for any reason, open a regular issue
titled `security: brief description` **without** any exploit details, and
the maintainer will reply with a private channel.

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.x     | Yes       |
| < 1.0 (including upstream Understand-Anything releases) | No — report upstream issues to the upstream project |

Security fixes land on the latest 1.x release. The installers pin to a release
tag, so update by moving to the newest tag.

## What to include

- A description of the issue and its potential impact.
- Steps to reproduce — minimal is fine, a full PoC is not required.
- Affected versions if you've narrowed them down.
- Whether you'd like to be credited in the eventual fix.

## What to expect

- Initial acknowledgement within a few days.
- A fix or mitigation plan within ~30 days for confirmed issues; longer for
  cases that require coordinated disclosure with upstream dependencies.
- Public credit once a fix has shipped, if you'd like.

## Threat model

This project is a **local** analysis tool. It runs on a developer's machine,
reads a project the user may not trust, and writes the resulting graph to the
project's data directory (`.ua/`, or the legacy `.understand-anything/` when
it already exists). It is designed around five assumptions:

1. **The analyzed project is hostile.** Everything in it — source, comments,
   docs, configs, commit messages, file names, and any `.ua/` contents that
   arrived with the clone — is untrusted data. Analyzing it must not run its
   code or act on text inside it.
2. **Agents can be prompt-injected through project text, so they are boxed in.**
   Agents that read project code get the smallest tool set they need, are told
   that project content is data and not instructions, may read only inside the
   project root and the plugin directory, and write only the files their prompt
   names. They do not use the network.
3. **The data directory is a trust boundary.** It is refused if it is a symlink,
   contains a symlink, or resolves outside the project, so a repository cannot
   redirect the tool's reads or writes elsewhere on the machine.
4. **The dashboard and its server are local-only.** The server binds to
   localhost, requires a random token, checks the `Host` header, and serves only
   files listed in the graph, never through a symlink or from outside the
   project. The page makes no requests to other hosts (Content-Security-Policy)
   and nothing is downloaded and executed at run time.
5. **A repository cannot enable background behavior, and the supply chain is
   pinned.** Auto-update is opt-in per user and stored outside the repo
   (`~/.understand-the-job/auto-update.json`); hooks only print a suggestion.
   Installers check out a release tag and refuse a foreign `origin`; CI pins
   actions to commit SHAs and uses a read-only token; dependency installs use a
   frozen lockfile.

Issues we care about:

- Code execution, or reads/writes outside the project, triggered by analyzing a
  hostile project (for example a path or symlink in a hostile repo, or text that
  makes an agent run a command).
- The dashboard server serving files outside the allowlist, or answering
  requests it should refuse (wrong `Host`, missing token).
- Any path by which a repository (not the user) switches on auto-update or other
  behavior that runs without the user asking.
- The installers or CI fetching or running code that is not pinned.

Issues that are **out of scope**:

- Bugs that require a malicious local user with write access to the
  analyzed project or to the user's home directory (they could just edit the
  source or the plugin directly).
- Anything that requires the user to copy a malicious URL and paste it back
  into the dashboard.
- What your model provider does with the code the agents read, and the
  `/understand-figma` skill's calls to the Figma API, which the user starts
  explicitly with their own token.
