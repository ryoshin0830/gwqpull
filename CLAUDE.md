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
3. For a new branch, use `origin/HEAD` as its base; for a PR, fetch its latest
   head into the local review ref.
4. Reuse an existing worktree and fast-forward it when possible, else `gwq add`.
5. Copy the ignored files the worktree lacks from the GHQ clone, minus the
   dependency and build directories.
6. `git submodule update --init --recursive` when `.gitmodules` exists.
7. Print the path; `--init <shell>` emits a function so the *shell* cds.

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

### I6c. New branches start at the remote default

When the requested branch exists neither locally nor on `origin`, resolve the
repository's default branch from `origin/HEAD` and create the new branch at
`origin/<default>`. Never use the GHQ clone's current `HEAD`: that checkout may
be on an unrelated feature branch. Existing local and remote branches keep
their own history.

### I7. An existing worktree is never handed to `gwq add`

That is where in-progress work lives. An existing worktree gets
`git merge --ff-only origin/<branch>` for ordinary branches, or the latest
`refs/gwqpull/pull/<number>/head` for PR URLs. Newly created worktrees receive
the same fast-forward step after `gwq add`. A divergence or local changes
produce a **warning and a successful exit**, never a rewrite and never a hard
failure. Losing someone's uncommitted work is worse than any convenience this
tool offers.

**The gate reads `--untracked-files=no`, and that is deliberate.** It used to be
`--untracked-files=all`, which stopped working the moment the ignored-file copy
became the default (I9b): `.gitignore` is tracked, so it differs per branch, and
a file the clone ignores lands in a worktree whose branch predates that rule as
an ordinary untracked file. gwqpull thus dirtied the tree itself and then refused
to follow the PR head for the rest of that worktree's life — under a `✓`.

Untracked files are not at risk from the relaxation, which was verified against
git rather than assumed: `merge --ff-only` refuses on its own, and leaves the
file alone, when the merge would overwrite an untracked file; an unrelated
untracked file does not block it. Tracked modifications still do.

The test for this needs a **tracked** `.gitignore` difference between the clone's
checkout and the worktree's branch. `.git/info/exclude` cannot express it: it
lives in the common git dir, so every worktree of the repository shares it — the
first version of that test passed against the bug for exactly this reason.

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

All three fetch `refs/pull/N/head` into the stable internal ref
`refs/gwqpull/pull/N/head`. The worktree is fast-forwarded from that ref on each
normal invocation, so an existing review follows new commits pushed to the PR.
Fallback branches also record an internal association in
`refs/gwqpull/pull/N/branch`; an unrelated pre-existing `pr-N` branch is rejected
instead of being advanced silently.
The fork case must warn that no upstream is set. Collapsing these into "just
use headRefName" breaks two of the three.

### I9b. Ignored files are copied by default, and cannot fail the run

A worktree gets what git tracks and nothing else, so it starts with no `.env`,
no credentials and no local config — unable to run the project it is a checkout
of. `seedIgnoredFiles()` enumerates ignored, untracked paths using the GHQ
clone's Git rules and copies them into the worktree. It is **on by default**;
`--no-copy-ignored-files` turns it off and `--copy-ignored-files` is accepted so
a script can be explicit. Both together is `E_VALIDATION`. Ordinary untracked
files are deliberately excluded, and the copy is independent of `--no-fetch` and
never prompts.

It shipped opt-in in 0.1.7 and that was the wrong default: the user who asked
for the feature hit the same empty worktree again on the next repository,
because the fix was a flag they had to remember. 0.2.0 flipped it.

Four properties, all required, all tested:

- **Missing-only, never destructive.** A path the destination already has is
  counted as kept and left alone, so a review-specific `.env` survives and
  re-running is a no-op. Nothing is overwritten or deleted.
- **The write cannot leave the destination.** The list comes from the
  filesystem, so every entry is checked lexically (`isWithin`) *and* against
  symlinked parents (`hasSymlinkInPath`) before mkdir and again after — mkdir
  can follow a link that appeared in between. A rejected entry is skipped.
- **It never blocks.** Every failure — unreadable source, a symlinked parent, a
  full disk — warns and carries on. A worktree without its `.env` is worse than
  one with it, but a worktree that was never reported is worse than both. This
  replaced the `die('E_WORKTREE', …)` the opt-in version used: a copy that the
  user explicitly asked for may fail loudly, one that happens on every run may
  not.
- **It reports its own trouble.** `ignoredFiles` carries `failed` and `error`
  for exactly that reason — see I11. Without them `{copied:0,kept:0,skipped:0}`
  is both "no ignored files" and "the listing died", and `warn()` is silent in
  `--json`.

**A fork PR is the one place the default flips.** `isCrossRepository` means the
worktree is a checkout of third-party code, and the review procedure *is*
`npm install && npm test` — so the copy would put `.env`, `.npmrc` and
service-account keys in front of whatever a postinstall script decides to do.
Nothing is copied there unless `--copy-ignored-files` says so explicitly, and
the warning names the flag. On by default is right for your own repositories and
wrong for someone else's code; SKILL.md tells agents not to pass that flag on
the user's behalf.

`cpSync` runs with `verbatimSymlinks: true`. Its default resolves a symlink
before copying, which turns `node_modules/.bin/tsc -> ../typescript/bin/tsc`
into an absolute path back into the clone — a worktree quietly wired to another
checkout.

### I9c. Dependency and build directories are excluded by name

The first draft copied **everything** ignored, on the principle that guessing
which ignored files matter is not our business. Two measurements killed it: in
the reporter's monorepo 394 of 514 ignored paths were under `node_modules`, and
filling in only what is missing in a worktree that has its own install
interleaves two dependency trees — worse than an empty one. A `.next` cache
carries absolute paths and is wrong the moment it moves.

So `REGENERABLE_DIRS` excludes a path whose **parent components** contain one of
46 names, at any depth. Only parents count: a file called `dist` is a file.

**This repository's own worktrees are excluded too, and that one is not a
guess.** With gwq's basedir inside the clone, every worktree is an ignored
directory of the repository, and git reports a wholly-ignored directory as one
indivisible entry — so worktrees copy each other, a level deeper on every run
(measured in gwqadd: 4 → 12 → 28 files, nesting 15 components deep, stopped only
by cpSync's own "cannot copy to a subdirectory of self"). `ownWorktrees()` reads
`git worktree list --porcelain`.

There is no honest signal to use instead, and this was checked:

- `git ls-files --others --ignored --exclude-standard --directory` collapses
  wholly-ignored directories, but `.secrets/` — which holds the credential the
  reporter needed — collapses exactly like `node_modules/`.
- A size or entry-count budget answers differently depending on whether anyone
  has run `npm install` lately, so the same repository behaves two ways.

That leaves the name, which is a denylist, which is incomplete by construction.
Two things keep it honest and both are tested: the list is reproduced verbatim
in `--help`, and every run reports `skipped N in <dirs>`. An exclusion nobody
can see is a silent surprise the first time a project keeps something real in
`dist/`.

The list is sorted, unique, and parsed out of the source by the test — the
regression test for a hand-edit that adds a name without documenting it. Keep
`REGENERABLE_DIRS` a plain array for that reason; the `Set` beside it is what
the lookup uses.

Deliberately **not** excluded: `.bundle`, `.idea`, `.vscode`. They are ignored
config, not build output, and a project that needs `.bundle/config` needs it in
every worktree.

The pruning happens before any filesystem call, because git lists every single
file inside `node_modules` and there can be hundreds of thousands of them.

`gwqadd` carries the same list (its I25b), by copy rather than by dependency.

`gwqadd` carries the same behaviour (its I25), sharing the implementation by
copy rather than by dependency (I13 — zero runtime dependencies).

### I9d. The listing must never be truncated

`spawnSync`'s default `maxBuffer` is 1 MiB, and `git ls-files --others --ignored
--exclude-standard -z` is bounded by the **total length of the path names**, so
any clone that has had `npm install` run in it goes past it. Measured:

| ignored entries | `-z` bytes | before the fix |
| --- | --- | --- |
| 3,002 | 876 KB | `.env` lands |
| 8,002 | 2.3 MB | `status:null signal:SIGTERM error:ENOBUFS`, **nothing copied** |

A bare Next.js app (`next react react-dom typescript eslint vitest`) measured
21,420 entries / 1.26 MB, so it was already over. Truncation surfaced as
`status !== 0`, which fell into the "could not list" warning — silent in
`--json`, so the whole feature disappeared without a trace, `.env` included, and
0.1.7's `die` had at least been loud about it. `git()` therefore passes
`maxBuffer: 512 * 1024 * 1024` for every call.

**I9c does not save this.** Pruning happens after git returns, so the listing
dies first; excluding `node_modules` by name makes the failure *quieter*, not
less likely.

The test builds a fixture whose listing exceeds 1 MiB on purpose and asserts the
config file still arrives. The harness's own `git()` helper needed the same
`maxBuffer` to measure that fixture, which is how loudly this fails.

The listing failure now names its reason (`ENOBUFS`, a signal, or the exit
code); "could not list" alone was indistinguishable from an empty result.

### I10. Collisions are moved, never deleted

gwq v0.1.1 does not forward `-f` to `git worktree add`, so a colliding directory
has to be cleared here. With `-f` it is **renamed** to `<path>.bak-<timestamp>`.
Without `-f` it is left alone and the error names it, says how many entries it
holds, and points at `-f`. Never `rm` a collision — it may be someone's work.

The destination path is recovered from gwq's error text. Prefer git's quoted
`fatal: '<path>' already exists`; the command echo is the fallback. The parser
understands both argument orders (`add -b <branch> <path>` and
`add <path> <branch>`) because gwq versions can report either form.

Two ways this has already been got wrong: a pattern that stopped at the first
space read the path-first form correctly *by accident* and silently broke `-f`
for anyone whose gwq basedir sits under a directory with a space in it; a
pattern that ran to the colon then swallowed the branch name along with the
path. Both orders, with and without spaces, are now tested.

### I10b. Roll back only the branch this run created

The CLI creates a new branch at `origin/<default>` before invoking `gwq add` so
the base is explicit. If `gwq add` then dies on an occupied destination, the
branch can be left with no worktree. The next run would fail with "branch
already exists" and the tool would stop being idempotent.

This is easy to trigger by accident because gwq sanitises `/` to `-`: asking for
`feat-template-rate-limit` targets the directory `feat/template-rate-limit`
already occupies. It was found exactly that way, by fat-fingering a branch name
during a smoke test.

`rollbackBranch()` deletes it — but only when this invocation created the branch
(`createdByUs`), and only when no worktree materialised after all. A branch the
user already had may hold their work and is never touched. Both halves are
tested; `gwqadd` carries the same rule and the same pair of tests.

The `-f` retry reuses the already-created local branch; it does not try to create
the branch a second time.

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
  "ignoredFiles":  { "copied": <n>, "kept": <n>, "skipped": <n>,
                     "failed": <n>, "error": "<message>" | null },
  "cd":            true | false
}
```

`ignoredFiles` is the only report the copy gets: it never touches the exit code,
and `warn()` is silent in `--json`. The copy did its job iff `error` is null and
`failed` is 0. `{copied:0,kept:0,skipped:0}` on its own says nothing — it is
equally a repository with no ignored files and a listing that died (I9d).

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
The suite also covers new branches starting from `origin/HEAD` when the main
clone is on another branch, PR worktree refresh after a new head commit, and
default-on ignored-file seeding — missing-only preservation, the `--no-copy-
ignored-files` opt-out, the flag contradiction, and a symlinked destination
parent being skipped rather than followed or fatal.

The symlink test creates its worktree with `--no-copy-ignored-files` on purpose:
now that the copy is the default, the first run would otherwise fill in the very
directory the test needs to replace with a symlink.

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
| New branch base | check out another branch in the clone, then request a new branch | starts from `origin/HEAD` |
| Same-repo PR | `gwqpull <url>/pull/<n>` | head ref checked out |
| PR re-run | push another commit to the PR, run the same command | existing worktree fast-forwards when clean |
| Fork PR | `gwqpull <fork-pr-url>` | `pr-N` branch, "no upstream" warning |
| Deleted head PR | `gwqpull <merged-pr-url>` | `pr-N` fallback with a note |
| Ignored files | `gwqpull <repo> <branch>` | ignored config files copied without asking; ordinary untracked files excluded |
| Ignored copy, big tree | a clone with `node_modules` installed | `node_modules` is skipped and named in the summary |
| Ignored files off | `gwqpull --no-copy-ignored-files <repo> <branch>` | nothing copied |
| Ignored copy, huge listing | a clone with `npm install` run in it | the config files still arrive; `ignoredFiles.error` is null (I9d) |
| Fork PR copy | `gwqpull <fork-pr-url>` | nothing copied, and the warning names `--copy-ignored-files` |
| Fork PR copy, forced | add `--copy-ignored-files` | copied |
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
