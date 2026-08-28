# gwqpull

Clone with [ghq](https://github.com/x-motemen/ghq), add a [gwq](https://github.com/d-kuro/gwq) worktree, and `cd` into it — in one shot.

```console
$ gwqpull https://github.com/cli/cli/pull/9421
┌ gwqpull github.com/cli/cli
│ cloning  https://github.com/cli/cli
│ PR #9421 [OPEN] Add --json to gh run view
│ creating a new branch  feat/run-view-json
│ Created worktree at /Users/you/worktrees/github.com/cli/cli/feat-run-view-json
└ ✓ feat/run-view-json → /Users/you/worktrees/github.com/cli/cli/feat-run-view-json

$ pwd
/Users/you/worktrees/github.com/cli/cli/feat-run-view-json
```

One command replaces: figure out the URL → `ghq get` → `git fetch` → work out
what the PR's head branch is called → `gwq add` → `git submodule update` → `cd`.

## Install

```sh
npm install -g gwqpull
```

Then add the shell integration:

```sh
# zsh  — ~/.zshrc
eval "$(command gwqpull --init zsh)"

# bash — ~/.bashrc
eval "$(command gwqpull --init bash)"

# fish — ~/.config/fish/config.fish
command gwqpull --init fish | source
```

`command` matters: each tool defines a shell function with its own name, so on a
second `source ~/.zshrc` the *function* would answer, capture the `--init` output
and try to `cd` into it. `command` skips functions and goes to the binary.

Reload the shell and `gwqpull` moves it.

Prefer a different name? `eval "$(gwqpull --init zsh --cmd gw)"` gives you `gw`.

### Without installing

```sh
eval "$(npx -y gwqpull --init zsh)"
```

The emitted function resolves its binary in three steps — `gwqpull` on `PATH`,
then the script that generated the snippet, then `npx -y gwqpull@<version>` — so
it keeps working after npm garbage-collects the npx cache.

Requires `git`, `ghq`, `gwq` and `fzf` on `PATH`, plus `gh` for PR URLs
(`brew install git ghq fzf gh d-kuro/tap/gwq`), and Node >= 20.12.
**No `jq`** — `gh --json` is parsed in-process.

## Repository spec

| You type | It means |
| --- | --- |
| `cli/cli` | host inferred from an existing clone via `ghq list -e`, else `github.com` |
| `github.com/cli/cli` | explicit host |
| `https://github.com/cli/cli` | full URL |
| `git@github.com:cli/cli.git` | scp form, normalised to https |
| `https://github.com/cli/cli/tree/trunk` | branch taken from the URL |
| `https://github.com/cli/cli/pull/42` | branch taken from the PR's head ref |

Query strings and fragments are stripped, so pasting a URL straight out of the
browser works.

Omit the branch and fzf offers every local and origin branch.

## What it does

1. **Clone or fetch.** `ghq get` if the repository is not on disk; otherwise
   `git fetch --prune`.
2. **Resolve the branch** — from the argument, the URL, the PR head, or fzf.
3. **Choose a base.** A brand-new branch starts from the repository default
   branch (`origin/HEAD`), regardless of which branch the GHQ clone currently
   has checked out. A PR uses its latest head commit instead.
4. **Land on a worktree.** Reuse an existing one and fast-forward it when
   possible, else `gwq add` it and fast-forward it to the selected source.
5. **Seed local configuration.** Copy the Git-ignored files the worktree does
   not have yet from the GHQ clone; ordinary untracked files are excluded.
6. **Initialise submodules** when the tree has any — `git worktree add` does not.
7. **Hand the path back** so the shell can `cd` there.

Re-running is safe. Every step lands in the same place whether or not the clone,
the branch and the worktree already existed.

### It will not eat your work

- An existing clone gets `git fetch --prune`, never `ghq get -u` — that runs
  `git pull --ff-only` internally and fails on a dirty or diverged main clone.
- A new branch is created at `origin/HEAD`, not at the GHQ clone's current
  checkout. An existing branch keeps its own history.
- An existing worktree is never handed to `gwq add`. It gets a `--ff-only`
  merge from `origin/<branch>` or the latest PR head, and a divergence or a
  tracked local change is a warning, not a rewrite. Untracked files neither
  block that merge nor are lost to it — git refuses on its own when the merge
  would overwrite one.
- A fallback `pr-N` branch is updated only when it was created and associated
  by `gwqpull`; an unrelated local `pr-N` branch fails with an actionable error.
- The ignored-file copy never overwrites an existing destination file and never
  deletes anything, and a failure there is a warning rather than a failed run.
- A colliding directory is only touched with `-f`, and then it is **moved** to
  `<path>.bak-<timestamp>`, never deleted.

## Usage

```
gwqpull [options] <repo|URL|PR-URL> [branch]
```

| Option | Meaning |
| --- | --- |
| `--init <shell>` | print shell integration for `zsh` \| `bash` \| `fish` |
| `--cmd <name>` | function name emitted by `--init` (default: `gwqpull`) |
| `--no-fetch` | skip `git fetch` and the ff-only catch-up |
| `--no-submodules` | skip `git submodule update --init --recursive` |
| `--copy-ignored-files` | copy the clone's Git-ignored files in (the default; the opt-in a fork PR needs) |
| `--no-copy-ignored-files` | do not copy them |
| `-f`, `--force` | move a colliding worktree directory aside instead of failing |
| `-n`, `--no-cd` | do the work and report the path, but do not move the shell |
| `--json` | stdout = 1-line JSON |
| `--quiet` | stdout = path only |
| `--no-color` | disable ANSI colors (also respects `NO_COLOR`) |
| `-h`, `--help` | show help |
| `-V`, `--version` | show version |

### Pull requests

PR URLs cover the three shapes that actually happen:

- **same-repo PR** → its head ref is checked out and refreshed from the latest PR head
- **fork PR** → the head is not on origin, so `refs/pull/N/head` becomes a local
  `pr-N` branch (with a warning that pushing needs the fork as a remote)
- **merged PR whose branch was deleted** → same `pr-N` fallback

All three cases refresh an existing review worktree from the PR head on each
normal run. If the worktree has local changes or diverged commits, the command
warns and leaves it untouched. If a local fallback branch with the same `pr-N`
name was not created by `gwqpull`, the command stops instead of changing it.

### Local environment files

A worktree gets everything Git tracks and nothing it does not — no `.env`, no
credentials, no `config/local/`, so nothing that would let the project run. They
are copied over from the GHQ clone, by default:

```console
$ gwqpull https://github.com/cli/cli/pull/9421
│ copying ignored files from /Users/you/ghq/github.com/cli/cli
│ copied 6 ignored file(s), skipped 41932 in node_modules, .next
```

Dependency and build directories are **not** copied. They are reproducible from
what git does track, and copying one is slow and frequently wrong — a `.next`
cache carries absolute paths, and a half-filled `node_modules` is worse than an
empty one. git has no idea which ignored paths are regenerable: `--directory`
only tells you a directory is ignored as a whole, and that is just as true of
`.secrets/`, while a size budget would give a different answer on every machine.
So the exclusion is by name, the list is fixed, and every run says how many
files it skipped and which of these they were in:

```
.angular  .astro  .cache  .dart_tool  .direnv  .docusaurus  .eggs  .gradle
.mypy_cache  .next  .nuxt  .nyc_output  .output  .parcel-cache  .pnpm-store
.pytest_cache  .ruff_cache  .sass-cache  .serverless  .stack-work
.svelte-kit  .terraform  .terragrunt-cache  .tox  .turbo  .venv
.virtualenvs  .vite  .yarn  Carthage  Pods  __pycache__  _build
bower_components  build  coverage  deps  dist  jspm_packages  node_modules
out  site-packages  target  tmp  vendor  venv
```

Ordinary untracked files are never copied either.

The worktrees of this repository are skipped as well — a reading of `git
worktree list` rather than a guess, and it matters when gwq's basedir lives
inside the clone, where worktrees would otherwise copy each other. Relative
symlinks stay relative, so a copied `node_modules/.bin/tsc` cannot end up
pointing back into the clone.

**A fork PR is the exception to the default.** It is a checkout of third-party
code that you are about to run — `npm install && npm test` *is* the review — so
nothing is copied there unless you ask:

```console
$ gwqpull https://github.com/cli/cli/pull/9421
gwqpull: fork PR — the ignored files were not copied. Pass --copy-ignored-files
         to put your local configuration into third-party code.
```

Existing files in the worktree are kept, so a review-specific environment file
is never overwritten and re-running is a no-op. A copy that fails is a warning,
never a failed run: the worktree is reported either way. In `--json` that
trouble is reported in the payload instead — the copy did its job when
`ignoredFiles.error` is null and `ignoredFiles.failed` is 0.

The worktree therefore has no `node_modules`: run the project's install step
there before building or testing.

`--no-copy-ignored-files` turns it off. `--copy-ignored-files` is the default and
is accepted so a script can say so out loud.

## For scripts and AI agents

```console
$ gwqpull --json -n cli/cli trunk
{"schemaVersion":1,"path":"/Users/you/ghq/github.com/cli/cli","branch":"trunk","clone":"/Users/you/ghq/github.com/cli/cli","repo":{"host":"github.com","owner":"cli","name":"cli","slug":"github.com/cli/cli","url":"https://github.com/cli/cli"},"pr":null,"created":false,"isMainClone":true,"cd":false}
```

`created` says whether this run made the worktree; `isMainClone` says the branch
was already checked out in the main clone, so no worktree was needed;
`ignoredFiles` reports how many Git-ignored files were copied in from the clone,
how many the worktree already had and kept, and how many were `skipped` for
living in a dependency or build directory.

Progress narrates on stderr, so stdout stays parseable. Errors go to stderr as
JSON with stdout empty:

```console
$ gwqpull --json nobody/nothing
{"schemaVersion":1,"error":{"code":"E_CLONE","message":"ghq get failed for https://github.com/nobody/nothing"},"exitCode":1}
```

| Exit | Code | Meaning |
| --- | --- | --- |
| 0 | — | success |
| 1 | `E_VALIDATION` | bad flags or too many arguments |
| 1 | `E_SPEC` | the repository spec could not be parsed |
| 1 | `E_CLONE` | `ghq get` failed, or the clone did not land where expected |
| 1 | `E_PR` | `gh pr view` failed, or the head could not be materialised |
| 1 | `E_BRANCH` | no branch given and no terminal for the picker |
| 1 | `E_WORKTREE` | `gwq add` failed (see the message for collisions) |
| 127 | `E_DEPS` | `git`, `ghq`, `gwq`, `fzf` or `gh` not installed |
| 130 | `E_INTERRUPTED` | Esc or Ctrl-C |

Use `-n` in an agent session: without it the tool prints a path your harness may
not be able to act on anyway, and `-n --json` still reports everything.

## Related

- [`ghqcd`](https://github.com/ryoshin0830/ghqcd) — pick a ghq repository with fzf and cd into it
- [`gwqcd`](https://github.com/ryoshin0830/gwqcd) — pick an existing gwq worktree with fzf and cd into it
- [`gwqadd`](https://github.com/ryoshin0830/gwqadd) — create a branch and its gwq worktree in the repo you are in
- [`ghnew`](https://github.com/ryoshin0830/ghnew) — create a GitHub repo, ghq-get it, and cd into it

## License

MIT © ryoshin0830
