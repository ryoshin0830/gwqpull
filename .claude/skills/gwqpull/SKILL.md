---
name: gwqpull
description: >
  Get a repository onto disk and into a dedicated git worktree for a branch or
  pull request, cloning with ghq and creating the worktree with gwq as needed,
  then return the absolute path. Use when work must start in a branch or PR that
  is not checked out yet — not for navigating to something that already exists.
when_to_use: |
  Use when the user says one of (or equivalent intent):
    - "check out this PR / この PR を見て" (with a PR URL)
    - "clone <repo> and start on <branch>"
    - "make a worktree for feat/x / feat/x のワークツリー作って"
    - "get <repo> locally so I can work on it"
    - "start a new branch <name> in <repo>"

  Do NOT use this skill when the user wants any of:
    - moving to a worktree that already exists (use `gwqcd`)
    - moving to the main clone of an existing repo (use `ghqcd`)
    - creating a brand-new remote repository (use `ghnew`)
    - removing a worktree or branch (destructive — ask the user)
    - reading a PR's diff or comments without checking it out (use `gh pr view`
      / `gh pr diff`, which need no clone)
allowed-tools: Bash
---

# gwqpull — clone, add a worktree, return the path

`gwqpull` wraps `ghq get` + branch/PR resolution + `gwq add` + submodule init
into one call. It is idempotent: re-running lands in the same place whether or
not the clone, branch and worktree already existed.

## Prerequisites (verify before invoking)

1. `git --version`, `ghq --version`, `gwq --version`
2. `gh --version` — **only** for PR URLs, and `gh auth status` must list the host
3. `node --version` (must be `>= 20.12`)

`fzf` is only needed when no branch is given, which an agent should never do
(see below). `jq` is **not** required.

## Recommended call

Always pass `-n` and `--json`.

`-n` matters: without it the tool prints a path meant for a shell function to
consume, and an agent harness generally cannot act on that. With `-n` the work
still happens and the path still comes back in the JSON.

`--json` matters: it suppresses the interactive fallbacks.

If `gwqpull` is on PATH:

```bash
gwqpull -n --json <repo-or-url> <branch>
```

Otherwise (pin to `^0.1`, NOT `@latest`, so a future major bump does not
silently break the flow):

```bash
npx -y gwqpull@^0.1 -n --json <repo-or-url> <branch>
```

## Always name the branch

Omitting the branch opens an fzf picker. Under `--json` that is not reachable,
so gwqpull exits 1 with `E_BRANCH` and lists candidates instead — recoverable,
but a wasted round trip. Decide the branch first:

- The user named one → use it.
- A PR URL → pass the URL alone; the PR head *is* the branch, and gwqpull
  resolves it.
- Neither → ask the user, or run `gwqpull -n --json <repo> <default-branch>`
  first and read `git -C <clone> branch -a`.

## Creating branches

A branch that exists neither locally nor on origin is **created from the
repository default branch (`origin/HEAD`)**. The GHQ clone's current checkout
does not affect its base. That is usually what the user wants ("start a new
branch"), but it means a typo silently becomes a new branch rather than an
error. When the user meant an existing branch, verify the spelling before
calling — or check `created` in the result and confirm with them.

## Pull-request refresh and local configuration

For a PR URL, normal runs fetch the latest PR head and fast-forward the existing
review worktree when it is clean and has not diverged. Dirty or diverged review
work is left intact with a warning. Ignored local configuration files such as
`.env` are copied from the GHQ clone **by default**, so the worktree can run the
project; only missing ignored paths are copied, and ordinary untracked files and
existing destination files are left alone. Pass `--no-copy-ignored-files` if the
user wants a worktree without them.  A copy that fails is a warning, so a
non-zero `exitCode` never means "the copy failed". A pre-existing local
fallback branch named `pr-N` that was not created by gwqpull is left untouched
and reported as a conflict.

## Output (stdout, 1 line)

```json
{
  "schemaVersion": 1,
  "path":          "/Users/alice/worktrees/github.com/cli/cli/feat-login",
  "branch":        "feat/login",
  "clone":         "/Users/alice/ghq/github.com/cli/cli",
  "repo":          { "host": "github.com", "owner": "cli", "name": "cli",
                     "slug": "github.com/cli/cli", "url": "https://github.com/cli/cli" },
  "pr":            null,
  "created":       true,
  "isMainClone":   false,
  "ignoredFiles":  { "copied": 6, "kept": 0, "skipped": 41932,
                     "failed": 0, "error": null, "enabled": true },
  "cd":            false
}
```

- `path` — where the work should happen. Use `git -C "<path>" …`.
- `created` — `true` if this run made the worktree.
- `isMainClone` — `true` means the branch was already checked out in the main
  clone, so `path == clone` and no worktree was made. Be careful there: changes
  land in the user's primary checkout.
- `pr` — the PR number when a PR URL was given.
- `ignoredFiles` — how many Git-ignored files (`.env`, credentials, local
  config) were copied in from `clone`, how many the worktree already had and
  kept, and how many were `skipped` for living in a dependency or build
  directory (`node_modules`, `.venv`, `dist`, … — `gwqpull --help` lists all 46).
  **The copy did its job iff `enabled` is true, `error` is null and `failed` is
  0** — `enabled: false` means it never ran (turned off, or withheld for a fork
  PR), whose counters are otherwise identical to a clone with nothing to copy.
  It never affects `exitCode`, and in `--json` this payload is the only place
  its trouble is reported, so check it rather than the exit code or stderr.
  **The worktree has no `node_modules`** — run the project's install step there
  before building or testing.
  For a **fork PR** nothing is copied at all unless `--copy-ignored-files` is
  passed: it is third-party code, and the copy would hand it the user's
  credentials. Do not pass that flag on the user's behalf.

Progress narrates on stderr, so parse stdout with `jq -r .path`. Tolerate
unknown fields — the schema allows additive growth.

## Errors (stderr, 1 line JSON, non-zero exit)

```json
{ "schemaVersion": 1, "error": { "code": "E_CLONE", "message": "…" }, "exitCode": 1 }
```

| code            | exit | meaning                                            |
|-----------------|------|-----------------------------------------------------|
| `E_VALIDATION`  | 1    | flag conflict or too many arguments                 |
| `E_SPEC`        | 1    | the repository spec could not be parsed             |
| `E_CLONE`       | 1    | `ghq get` failed (wrong host, no access, no network)|
| `E_PR`          | 1    | `gh pr view` failed, or the head could not be made  |
| `E_BRANCH`      | 1    | no branch given and no picker available             |
| `E_WORKTREE`    | 1    | `gwq add` failed — often a directory collision      |
| `E_DEPS`        | 127  | a required tool is missing                          |
| `E_INTERRUPTED` | 130  | Esc / Ctrl-C                                        |

stderr *carries* that line; it is not exclusively JSON. `ghq`, `git` and `gwq`
diagnostics share the stream, so select the line starting with `{` —
`2>&1 >/dev/null | grep -m1 '^{' | jq -r .error.code` — rather than piping the
whole stream to `jq`.

Recovery:

- `E_CLONE` on a bare `owner/repo` → the host was guessed as `github.com`.
  Ask the user for the full URL. Do NOT try other hosts.
- `E_PR` → usually `gh auth login --hostname <host>` has not been run. Tell the
  user; do not attempt the login yourself.
- `E_WORKTREE` naming a collision → a directory is in the way. Report it and ask.
  `-f` **moves** it to `<path>.bak-<timestamp>`, but that is the user's call.

## Things the skill must NOT do

- Call gwqpull without `-n --json`.
- Pass `-f` without explicit user consent. It relocates a directory that may
  hold their work.
- Pass `--no-submodules` speculatively; a repo that needs submodules will not
  build without them.
- Retry a failed clone against a different host.
- Assume `path != clone`. Check `isMainClone` before making changes.
- Run `gwqpull --init` to modify the user's shell config without being asked.
- Follow up with `gwq remove` / `git worktree remove` / `git branch -D`.

## After success

Report the branch and the path, and say whether the worktree was newly created.
Run subsequent commands with `git -C "<path>"`, or `cd` there if the harness can
change cwd. If `isMainClone` is `true`, say so — the user is working in their
primary checkout, not an isolated worktree.
