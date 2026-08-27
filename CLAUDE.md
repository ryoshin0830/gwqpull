# CLAUDE.md

Guidance for any AI agent (Claude Code, Codex, opencode, etc.) that works
**inside** this repository.

This file is for **maintainers of `gwqpull`**. To USE gwqpull from an agent
session, see `.claude/skills/gwqpull/SKILL.md` and the "For scripts and AI
agents" section of `README.md` instead.

---

## What this package does

A Node.js CLI (~900 lines, zero runtime dependencies) that takes a repository
spec and lands the shell in a worktree for a branch, creating whatever is
missing along the way:

1. `ghq get` if the clone is absent, else `git fetch --prune`.
2. Resolve the branch — argument, `/tree/<branch>` URL tail, PR head, or fzf.
3. Reuse an existing worktree (fast-forwarding it), else `gwq add`.
4. `git submodule update --init --recursive` when `.gitmodules` exists.
5. Print the path; `--init <shell>` emits a function so the *shell* cds.

Single source of behavior: `bin/gwqpull.mjs`.

`reference/gw.zsh.original` is the zsh function this was ported from, kept for
provenance. It is excluded from the tarball. When a behavioural question comes
up ("why does it fetch instead of `ghq get -u`?"), that file's comments are the
original reasoning — but the invariants below are what ships.

Sibling packages built to the same contract: `ghqcd`, `gwqcd`, `ghnew`.

---

## Invariants (do not break)

### I1. stdout / stderr discipline

- **stdout** is for machine-readable output **only**: the `--quiet` path, the
  `--json` payload, the `--init` snippet, and the `--help`/`--version` body.
- **stderr** carries everything else — and here that is a lot: clone progress,
  fetch output, the PR summary, `gwq add`'s report, warnings, the `cd` box.

This matters more in gwqpull than in its siblings, because gwqpull spawns
children that are chatty. Every child gets `stdio: ['inherit', 2, 'inherit']`
— fd 1 folded onto **our stderr** — so `ghq get`'s progress can never end up
inside the path the shell function is about to `cd` into. Never give a child
`'inherit'` on fd 1.

### I2. `--quiet` still narrates

In `ghqcd`/`gwqcd`, `--quiet` means near-silence. Here it must not: `--quiet`
is the shell function's mode, cloning a large repository takes a minute, and a
silent minute reads as a hang. `log()` therefore suppresses only under
`--json`. This asymmetry is deliberate — do not "align" it with the siblings.

### I3. `--no-cd` prints nothing on stdout

The generated function cds to whatever appears on stdout. So `-n` in `--quiet`
mode must emit **nothing at all**, not the path — otherwise the wrapper follows
it and `--no-cd` does the opposite of what it says. In `--json`, `-n` is
reported as `"cd": false` and the path stays in the payload.

The generated function treats empty stdout as success, so `-n` returns 0 without
moving the shell.

`--help` and `--version` are a different matter, and this file claimed they were
fine when they were not: they print *to stdout*, so the function captured the
text and fed it to `cd` — `--version` produced "no such file or directory:
gwqpull 0.1.2" and `--help` produced "file name too long". See I8b.

### I4. `--init` is a flag, not a subcommand

`gwqpull init zsh` is ambiguous — the first positional is a repository spec, so
`init` would be parsed as a repo and `zsh` as a branch. This is the reason all
four tools in the family spell it `--init <shell>`. Do not "fix" this to match
zoxide.

### I5. The generated function resolves its binary in three steps

`PATH` → the absolute path of the script that generated the snippet →
`npx -y gwqpull@<version>`. Each step exists for a reason:

- **PATH first** so a global install wins and picks up upgrades.
- **Baked path second** so `eval "$(npx -y gwqpull --init zsh)"` works at all.
- **npx last** because npm garbage-collects `~/.npm/_npx/<hash>/`, and without
  this step the user's shell silently loses the command.

The lookup MUST be PATH-only (`whence -p` / `type -P` / `command -s`). The
emitted function shares its name with the binary by default, so a
function-aware lookup finds the function and recurses until the shell dies.

### I8b. The function must not capture output that is not a path

Every flag whose result goes to stdout has to be passed through uncaptured:
`-h`, `--help`, `-V`, `--version`, `--init`, `--json`. The wrapper adds
`--quiet`, so `--json` would additionally collide with it and error out.

This shipped broken in every one of these packages and was only found by running
the emitted function rather than syntax-checking it — `zsh -n` is perfectly happy
with a function that cds into a help page. There are tests now that install the
function in zsh, bash and fish and run `--version` and `--help` through it.

### I8c. The install snippet must say `command`

The emitted function shares its name with the binary, so `eval "$(gwqpull --init
zsh)"` in `~/.zshrc` resolves to the *function* on every re-source after the
first. A stale function then captures the `--init` output and hands it to `cd`:

    gwqcd:cd:5: no such file or directory: # gwqcd 0.2.1 — zsh integration\n…

Reported by a user running `source ~/.zshrc` after an upgrade. `command` skips
functions and goes to PATH, which makes re-sourcing idempotent no matter what is
already defined. The npx form (`eval "$(npx -y gwqpull --init zsh)"`) never had the
problem, because npx is not the function.

The generated snippet's own header comment shows the `command` form too — it is
the line people copy.

### I6. Never `ghq get -u` on an existing clone

`ghq get -u` runs `git pull --ff-only` internally, which fails outright when the
main clone is dirty or has diverged — and the main clone is exactly where people
leave half-finished work. `git fetch --prune` never touches a working tree, so
it is safe over any state. This is the single most important behavioural
decision inherited from the zsh original.

### I6b. Ask ghq where the clone is; never assemble the path

`ghq.root` may be repeated and `GHQ_ROOT` may be colon-separated, but `ghq root`
prints only the first. Building `dir` from it made every repository under a
secondary root unreachable: `ghq get` saw a clone it already had and did
nothing, then this died with "clone did not land where expected".

`existingClone(slug)` (`ghq list -e -p`) is the source of truth, with the
constructed path used only for a repository that does not exist yet — and
`ensureClone()` re-resolves *after* cloning, because which root `ghq get` picks
is ghq's business, not ours.

### I7. An existing worktree is never handed to `gwq add`

That is where in-progress work lives. An existing worktree gets
`git merge --ff-only origin/<branch>` and nothing else; a divergence or a dirty
tree produces a **warning and a successful exit**, never a rewrite and never a
hard failure. Losing someone's uncommitted work is worse than any convenience
this tool offers.

### I8. `git worktree list` includes the main working tree

The main clone appears in `git worktree list --porcelain` like any other entry,
so `worktreePath(dir, branch)` finds it when the main clone has the branch
checked out. `isMainClone` is therefore decided by comparing the found path
against the clone dir — **through `realpathSync`**, because git reports resolved
paths and on macOS a `/var/...` ghq root arrives back as `/private/var/...`.

An earlier version returned `isMainClone: false` here because it assumed only
linked worktrees were listed. The `rev-parse --abbrev-ref HEAD` branch below it
is a fallback for states git's porcelain does not cover, not the primary path.

### I9. PR resolution has three shapes, not one

- **same-repo PR** → check out `headRefName`
- **fork PR** (`isCrossRepository: true`) → the head is not on origin; fetch
  `refs/pull/N/head` into a local `pr-N`
- **merged PR whose head branch was deleted** → same `pr-N` fallback

The fork case must warn that no upstream is set. Collapsing these into "just use
headRefName" breaks two of the three.

### I10. Collisions are moved, never deleted

gwq v0.1.1 does not forward `-f` to `git worktree add`, so a colliding directory
has to be cleared here. With `-f` it is **renamed** to `<path>.bak-<timestamp>`.
Without `-f` it is left alone and the error names it, says how many entries it
holds, and points at `-f`. Never `rm` a collision — it may be someone's work.

The destination path is recovered from gwq's error text. Prefer git's quoted
`fatal: '<path>' already exists`; the command echo is the fallback and needs to
be told whether `-b` was used, because that swaps the argument order
(`add -b <branch> <path>` versus `add <path> <branch>`).

Two ways this has already been got wrong: a pattern that stopped at the first
space read the path-first form correctly *by accident* and silently broke `-f`
for anyone whose gwq basedir sits under a directory with a space in it; a
pattern that ran to the colon then swallowed the branch name along with the
path. Both orders, with and without spaces, are now tested.

### I10b. Roll back only the branch this run created

`git worktree add -b` creates the branch while "preparing" and then dies on an
occupied destination, leaving a branch with no worktree. The next run then fails
with "branch already exists" and the tool stops being idempotent.

This is easy to trigger by accident because gwq sanitises `/` to `-`: asking for
`feat-template-rate-limit` targets the directory `feat/template-rate-limit`
already occupies. It was found exactly that way, by fat-fingering a branch name
during a smoke test.

`rollbackBranch()` deletes it — but only when the branch did not exist before
(`known`), and only when no worktree materialised after all. A branch the user
already had may hold their work and is never touched. Both halves are tested;
`gwqadd` carries the same rule and the same pair of tests.

The `-f` retry must also notice a leftover branch and drop `-b`, or git refuses
to create it twice.

### I11. `--json` schema (external contract)

```json
{
  "schemaVersion": 1,
  "path":          "<worktree path — where the shell would cd>",
  "branch":        "<resolved branch>",
  "clone":         "<main clone dir>",
  "repo":          { "host": "…", "owner": "…", "name": "…", "slug": "…", "url": "…" },
  "pr":            <number> | null,
  "created":       true | false,
  "isMainClone":   true | false,
  "cd":            true | false
}
```

Error (stderr, exit ≠ 0):

```json
{ "schemaVersion": 1, "error": { "code": "E_*", "message": "…" }, "exitCode": <number> }
```

Adding fields is fine; removing or renaming requires a `schemaVersion` bump.

stderr *carries* the error line; it is not exclusively JSON. Node warnings and
child diagnostics share the stream. Consumers — including our own tests — must
select the line starting with `{`, never parse the whole stream.

### I12. Exit codes

| Code | Constant        | Meaning                                              |
|------|-----------------|------------------------------------------------------|
| 0    | —               | success                                              |
| 1    | `E_VALIDATION`  | flag conflict, missing/extra positional              |
| 1    | `E_SPEC`        | the repository spec could not be parsed              |
| 1    | `E_CLONE`       | `ghq get` failed, or the clone is not where expected |
| 1    | `E_PR`          | `gh pr view` failed, or the head could not be made   |
| 1    | `E_BRANCH`      | no branch and no terminal for the picker             |
| 1    | `E_WORKTREE`    | `gwq add` failed                                     |
| 127  | `E_DEPS`        | a required tool is missing                           |
| 130  | `E_INTERRUPTED` | Esc / Ctrl-C                                         |

`gh` is checked lazily — only a PR URL needs it, and demanding it up front would
lock out anyone who never touches PRs.

### I13. Zero runtime dependencies

`jq` was a hard dependency of the zsh original (for `gh pr view --json`); it is
now `JSON.parse`. Do not reintroduce it, or any npm runtime dependency. The one
prompt we need (`confirmYesNo`) is fifteen lines over the raw-mode keypress
reader we already have.

### I14. Raw mode cleanup

`process.stdin.setRawMode(true)` is guarded by `stdin.isTTY`. Cleanup runs on
`exit`, `SIGTERM`, `SIGHUP`, `uncaughtException`, and inside `try/finally`.
Cursor restore (`\x1b[?25h`) is guarded by `stderr.isTTY`.

### I15. Engines

`engines.node >= 20.12.0` for `node:util` `parseArgs`. Do not lower.

---

## Do NOT

- Add `preinstall` / `postinstall` scripts to `package.json` (Shai-Hulud worm
  infection vector). `npm install --ignore-scripts` must work.
- Remove `.claude/`, `CLAUDE.md`, `test/` or `reference/` from `.npmignore`.
- Use `console.log` for human output. Use `stderr.write(...)` / `log()`.
- `rm` anything. The only destructive operation in this tool is a rename, and
  only under `-f`.
- Add a runtime dependency (see I13).
- Reintroduce a `const VERSION = '…'` literal. `npm version` only bumps the
  manifest, so a literal drifts and `--version` names a build nobody is running.

---

## Release workflow

```sh
git add -A && git commit -m "feat: …"
npm pack --dry-run          # must not contain .claude/, CLAUDE.md, test/, .git/
npm version patch           # or minor / major — commits and tags
git push --follow-tags      # pushing main fires .github/workflows/publish.yml
gh run watch                # optional; the publish happens in CI
npx -y gwqpull@latest --version
```

**Do not run `npm publish` by hand.** **Every push to main releases.** CI runs
the suite, then publishes whatever `package.json` says — raising patch itself,
and committing that bump back to main, when the version there has already
shipped. Bump manually first (`npm version minor`) to choose a number; forget,
and you still shipped at +patch. Re-run a failure with
`gh workflow run publish.yml` — there is nothing to undo and no tag to move.

Because every push releases, treat main as the publish button: docs fixes and
test tweaks land as real versions. That is deliberate.

Commit-message footgun: GitHub reads **every line** of a push's HEAD message,
not just the subject, and skips the whole event when any of them carries a CI
skip token. Never write the token in prose; say "the skip token" instead. The
bot's own releases use it legitimately, which is why they never fan out.

CI publishes with npm trusted publishing (OIDC): no npm token exists on any
laptop or in this repository's secrets, and no release needs a browser or a
passkey. One-time setup per package, on npmjs.com → the package → Settings →
Trusted Publisher: GitHub Actions, owner `ryoshin0830`, repository `gwqpull`,
workflow filename `publish.yml`, allowed action `npm publish`.

The developer machine's `.npmrc` points `registry=` at a private mirror, so
anything run locally against npmjs.org needs
`--registry=https://registry.npmjs.org`. CI has no such mirror.

---

## Testing

`npm test` runs `test/cli.test.mjs` against a **real git repository** in a
sandbox, with `ghq`, `gwq` and `fzf` shimmed. git is deliberately not shimmed:
worktree creation, branch existence and fast-forwarding are the logic under
test, and faking them would only test the fakes.

Covered: every spec-parsing shape, clone-on-demand, worktree creation for
existing / origin-only / brand-new branches, idempotent re-runs, the I8
main-clone case, the I10 collision paths (both with and without `-f`, asserting
the stray file survives inside the backup), and the I1/I3 stdout contract.

Two traps for anyone adding tests:

- **Realpath the sandbox root.** macOS `$TMPDIR` is `/var/...` symlinked to
  `/private/var/...`, git reports the resolved form, and unresolved
  expectations will never match.
- **Stay hermetic against the developer's own environment.** `run()` deletes
  `FORCE_COLOR` from the child env because we set `NO_COLOR`, and node warns to
  stderr when it sees both — which made the suite fail on a machine that
  exported `FORCE_COLOR`, and only at `npm publish` time via `prepublishOnly`.
  Assertions that stderr is empty go through `ourStderr()`, which strips
  `(node:NNN) Warning:` lines first. Never assert on raw `r.stderr` being `''`:
  stderr is a shared stream, and node's warnings are not ours to control.

Not covered — run by hand:

| Scenario | Command | Expect |
| --- | --- | --- |
| Branch picker | `gwqpull <repo>` | fzf lists local + origin branches |
| Picker cancel | `gwqpull <repo>`, Esc | exit 130, shell stays put |
| Real clone | `gwqpull cli/cli trunk` | clones from the network, lands in a worktree |
| Same-repo PR | `gwqpull <url>/pull/<n>` | head ref checked out |
| Fork PR | `gwqpull <fork-pr-url>` | `pr-N` branch, "no upstream" warning |
| Deleted head PR | `gwqpull <merged-pr-url>` | `pr-N` fallback with a note |
| Submodules | `gwqpull <repo-with-submodules>` | submodules populated |
| Dirty worktree | edit a file, re-run | warns, does not rewrite (I7) |
| Diverged branch | commit locally, re-run | warns, does not rewrite (I7) |
| npx one-shot | `npx gwqpull <repo> <branch>` | box on terminal, `c` copies |

Do **not** try to drive the interactive fzf picker by piping keystrokes into
`script` — fzf reads `/dev/tty`, the writes do not reach it, and the harness
hangs until killed.

---

## Where things live

- `bin/gwqpull.mjs` — the entire CLI (ESM, top-level await OK).
- `package.json` — `bin.gwqpull`, `engines.node`, `files`, `prepublishOnly`.
- `.npmignore` — defense-in-depth complement to `files`.
- `.claude/skills/gwqpull/SKILL.md` — agent USE contract.
- `README.md` — end-user docs.
- `test/cli.test.mjs` — real-git sandbox tests.
- `reference/gw.zsh.original` — the zsh function this was ported from.

---

## Things that are intentionally NOT here

- **Removing worktrees.** `gwq remove` is destructive; this tool only creates.
- **`ghq get -u`.** See I6.
- **Pushing, or creating PRs.** `gh` does that.
- **Retrying a failed clone with a mutated URL.** A wrong host is a question for
  the user, not something to brute-force.
- **A prompt library, a logger, a clipboard package, or `jq`.** See I13.
- **Telemetry / analytics.**
