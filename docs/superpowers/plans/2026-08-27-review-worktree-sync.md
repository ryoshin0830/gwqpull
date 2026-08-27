# Review Worktree Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `gwqpull` create new branches from the remote default branch, refresh review worktrees from the latest pull-request head, and optionally seed missing Git-ignored environment files from the GHQ clone.

**Architecture:** Keep the single-file CLI architecture and add three focused helpers: default-branch resolution, PR-head cache/update, and ignored-file seeding. Continue delegating worktree naming and collision handling to `gwq`; pre-create only a new local branch at an explicit `origin/<default>` ref so `gwq add <branch>` preserves its configured path template. Use `git merge --ff-only` for every refresh so local review work is never reset.

**Tech Stack:** Node.js >=20.12, built-in `node:child_process` and `node:fs`, Git, ghq, gwq, and the existing Node test runner.

## Global Constraints

- Keep runtime dependencies at zero.
- Preserve stdout/stderr discipline, JSON schema version 1, exit codes, collision handling, submodule initialization, and shell integration.
- `--no-fetch` skips normal remote refresh and fast-forward attempts; `--copy-ignored-files` remains independently executable.
- Never reset, force-update, delete, or overwrite an existing review worktree file.
- Use `origin/HEAD` as the default branch; do not hard-code `main`.
- Use `refs/gwqpull/pull/<number>/head` as the internal PR-head cache ref.

---

### Task 1: Add failing integration coverage for default-branch creation

**Files:**
- Modify: `test/cli.test.mjs:8-124, 277-326`

**Interfaces:**
- The fixture will expose a default `main` commit that differs from `base/other` and `feat/login`.
- The CLI behavior under test is `gwqpull --json -n --no-fetch alice/api <new-branch>`.

- [x] **Step 1: Extend the real Git fixture before the initial seed commit**

Add `.gitignore` with `*.env` and `ignored-dir/`, create `base/other` and `feat/login` from the initial commit, then add `main-only.txt` on `main`. Create two commits on a temporary `pr/source` branch and record their SHAs in module variables. After making the bare origin, delete `refs/heads/pr/source` and set `refs/pull/42/head` to the first PR SHA so the PR exists only through the pull ref.

- [x] **Step 2: Add a test proving a new branch starts at the default branch**

Add a test that creates the clone, checks out `base/other` in the main clone, then requests `brand/from-default`. Assert that the resulting worktree commit equals `origin/main` and contains `main-only.txt`. This must fail against the current implementation because it creates the branch from the main clone's `HEAD`.

- [x] **Step 3: Run the targeted test and confirm the expected failure**

Run:

```sh
node --test test/cli.test.mjs --test-name-pattern "new branch starts from the default branch"
```

Expected: one failing assertion showing the new worktree is based on `base/other`, not `origin/main`.

### Task 2: Implement default-branch resolution and explicit new-branch bases

**Files:**
- Modify: `bin/gwqpull.mjs:1-16, 499-572, 891-986`
- Test: `test/cli.test.mjs` from Task 1

**Interfaces:**
- Add `defaultBranch(dir): string`, which returns the branch behind `refs/remotes/origin/HEAD` or resolves the remote symbolic `HEAD` using `git ls-remote --symref origin HEAD`.
- Update `ensureWorktree(dir, branch, sourceRef = '')` so a branch absent from both local and remote refs is first created with `git branch <branch> refs/remotes/origin/<default>` and then passed to `gwq add <branch>`.

- [x] **Step 1: Implement `defaultBranch` with an origin/HEAD fast path**

Read `git symbolic-ref --quiet --short refs/remotes/origin/HEAD`, strip the `origin/` prefix, and verify that `refs/remotes/origin/<branch>` exists. If the symbolic ref is absent, run `git ls-remote --symref origin HEAD`, parse `ref: refs/heads/<branch> HEAD`, create the local symbolic ref `refs/remotes/origin/HEAD`, and fetch the identified branch into `refs/remotes/origin/<branch>` when normal fetching is enabled. If no branch can be resolved, call `die('E_BRANCH', ...)` with a message explaining that the default branch could not be determined.

- [x] **Step 2: Replace `gwq add -b` for brand-new branches**

In `ensureWorktree`, retain the existing/local-or-remote branch path. For a missing branch, call `defaultBranch(dir)`, create the new local branch from `refs/remotes/origin/<default>`, pass `[branch]` to `gwq add`, and keep a boolean identifying that this invocation created the branch so collision rollback deletes only that branch.

- [x] **Step 3: Run the targeted test and the existing worktree suite**

Run:

```sh
node --test test/cli.test.mjs --test-name-pattern "default branch|branch that exists nowhere|origin-only branch|re-running is idempotent"
```

Expected: the new default-base test and all selected existing tests pass. The new branch test must no longer require the `-b` argument because the CLI creates the branch at the correct base before invoking gwq.

### Task 3: Add failing integration coverage for pull-request refresh

**Files:**
- Modify: `test/cli.test.mjs:19-24, 58-124, 277-326`

**Interfaces:**
- Add a `gh` shim that returns PR metadata for `gh pr view` and a version for dependency detection.
- The fixture exposes `refs/pull/42/head` at two commits so a second CLI invocation can simulate a new push to the PR.

- [x] **Step 1: Add the `gh` shim and PR commit fixture**

Return JSON with `headRefName: "pr/source"`, `isCrossRepository: false`, `state: "OPEN"`, and a test title. Keep `pr/source` absent from origin heads so the implementation must use the pull ref and the `pr-42` fallback.

- [x] **Step 2: Add a test that refreshes an existing PR worktree**

Run the PR URL once and record its worktree path and first commit. Move the bare origin's `refs/pull/42/head` to the second recorded commit, run the same command again, and assert that the path is unchanged, `created` is false, and the worktree `HEAD` equals the second commit. This must fail against the current implementation because it only updates `FETCH_HEAD` and does not advance the existing `pr-42` branch.

- [x] **Step 3: Run the targeted PR test and confirm the expected failure**

Run:

```sh
node --test test/cli.test.mjs --test-name-pattern "existing PR worktree"
```

Expected: the second invocation remains at the first PR commit.

### Task 4: Implement stable PR-head fetching and fast-forward refresh

**Files:**
- Modify: `bin/gwqpull.mjs:785-845, 891-986, 988-1020`
- Test: `test/cli.test.mjs` from Task 3

**Interfaces:**
- Add `hasRef(dir, ref): boolean` and `prHeadRef(number): string`.
- Change `resolvePrBranch` to return `{ branch: string, sourceRef: string }`.
- Add `pullFastForwardRef(worktree, branch, sourceRef): void`; retain `pullFastForward` as the `origin/<branch>` adapter.

- [x] **Step 1: Fetch every PR head into a stable internal ref**

For a fetched PR, run:

```sh
git -C <clone> fetch origin +refs/pull/<number>/head:refs/gwqpull/pull/<number>/head
```

Use the cache ref for same-repository PRs, fork PRs, and deleted-head fallbacks. Materialize a missing local `pr-<number>` branch from the cache ref, never from `FETCH_HEAD`. When `--no-fetch` is active, use an existing cache ref if present and report an `E_PR` error if a required PR head is unavailable.

- [x] **Step 2: Fast-forward from the PR cache after finding or creating the worktree**

Pass `sourceRef` into `ensureWorktree`. Existing worktrees and the main clone use `pullFastForwardRef` when `sourceRef` is present. Newly created worktrees also receive the same ff-only update after `gwq add`; non-PR worktrees continue to use `origin/<branch>`. A failed merge emits the existing warning and leaves the worktree unchanged.

- [x] **Step 3: Run the targeted PR test and the full existing suite**

Run:

```sh
node --test test/cli.test.mjs --test-name-pattern "existing PR worktree"
npm test
```

Expected: the PR test passes; the complete suite has zero failures.

### Task 5: Add failing integration coverage for ignored-file seeding

**Files:**
- Modify: `test/cli.test.mjs:8-13, 277-326`

**Interfaces:**
- The new CLI flag is `--copy-ignored-files`.
- The copy source is the GHQ clone; the destination is the returned worktree path.

- [x] **Step 1: Add ignored and ordinary untracked files to the source clone**

After creating the main clone, write `.env` and `ignored-dir/nested.txt` into it, plus an ordinary untracked `notes.txt`.

- [x] **Step 2: Add a test for opt-in copy and non-overwrite behavior**

Run the CLI with `--copy-ignored-files --no-fetch`, assert that `.env` and the nested ignored file exist in the worktree, and assert that `notes.txt` does not. Change the destination `.env`, run the command again with the option, and assert that the destination value is preserved. This must fail against the current implementation because the flag is unknown and no copy occurs.

- [x] **Step 3: Run the targeted test and confirm the expected failure**

Run:

```sh
node --test test/cli.test.mjs --test-name-pattern "copy-ignored-files"
```

Expected: the current argument parser rejects the new option.

### Task 6: Implement safe ignored-file copying

**Files:**
- Modify: `bin/gwqpull.mjs:1-6, 24-35, 366-384, 499-572, 988-1025`
- Test: `test/cli.test.mjs` from Task 5

**Interfaces:**
- Add `seedIgnoredFiles(sourceDir, destinationDir): void`.
- Add the boolean parser entry `'copy-ignored-files'` and invoke `seedIgnoredFiles(dir, wt.path)` after worktree creation and before submodule initialization when the flag is set.

- [x] **Step 1: Enumerate only ignored untracked paths**

Run `git ls-files --others --ignored --exclude-standard -z` in the source clone, split the NUL-delimited UTF-8 output, and treat an empty result as a successful no-op. This excludes ordinary untracked files and Git metadata.

- [x] **Step 2: Copy only missing destination paths**

Resolve each relative path under both source and destination, reject paths that escape either root, create missing parent directories with `mkdirSync`, and copy files/directories/symlinks with `cpSync`. Use `lstatSync` to detect an existing destination, skip it without overwriting, and never delete destination-only files. If source and destination are the same path, return without copying.

- [x] **Step 3: Add help text and run the targeted copy test**

Document `--copy-ignored-files` as an opt-in missing-file seed. Run:

```sh
node --test test/cli.test.mjs --test-name-pattern "copy-ignored-files"
```

Expected: ignored files are copied, ordinary untracked files are absent, and destination edits survive the second invocation.

### Task 7: Update user and maintainer documentation

**Files:**
- Modify: `README.md:70-120, 130-160`
- Modify: `CLAUDE.md:15-30, 120-146, 320-370`
- Test: `test/cli.test.mjs` help assertions

**Interfaces:**
- Public option documentation must use the exact name `--copy-ignored-files`.
- Documentation must state that new branches start from `origin/HEAD`, PR worktrees refresh from the PR head, and ignored files are copied only when explicitly requested and only when missing.

- [x] **Step 1: Update README workflow and option descriptions**

Add the default-branch and PR refresh behavior to “What it does”, add the option to the usage table, and include an example explaining that ignored environment files are seeded without copying ordinary untracked files.

- [x] **Step 2: Update maintainer invariants and test matrix**

Replace the old “new branch from current HEAD” implication, document the stable PR cache ref and missing-only copy policy, and add the new scenarios to the maintainer test matrix.

- [x] **Step 3: Add a help-output assertion**

Assert that `gwqpull --help` contains `--copy-ignored-files` and the default-branch wording.

### Task 8: Final verification and commits

**Files:**
- Modify: `bin/gwqpull.mjs`, `test/cli.test.mjs`, `README.md`, `CLAUDE.md`
- Create: `docs/superpowers/specs/2026-08-27-review-worktree-sync-design.md`
- Create: `docs/superpowers/plans/2026-08-27-review-worktree-sync.md`

- [x] **Step 1: Run the complete test suite**

Run:

```sh
npm test
```

Expected: zero failures; fish-only tests may remain skipped when fish is not installed.

- [x] **Step 2: Run syntax and diff checks**

Run:

```sh
node --check bin/gwqpull.mjs
git diff --check
git status --short
```

Expected: syntax check and whitespace check exit 0; only intended files are modified.

- [x] **Step 3: Commit implementation and documentation**

Create focused commits for the implementation/tests and documentation, then record their SHAs for the code review range. Do not amend the already committed design spec unless a self-review finds an actual contradiction.
