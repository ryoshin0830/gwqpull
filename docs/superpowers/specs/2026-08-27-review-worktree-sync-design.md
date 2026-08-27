# Review Worktree Sync Design

## Goal

Make `gwqpull` reliable for repeated code review: new local branches start at the repository's default branch, pull-request worktrees follow the latest PR head, and an explicit option can seed missing Git-ignored environment files from the existing GHQ clone.

## Requirements

1. When a requested branch does not already exist locally or on `origin`, create it from the branch pointed to by `origin/HEAD`, not from the GHQ clone's current checkout.
2. When a requested branch already exists, keep using that branch's own history; do not replace it with the default branch.
3. For a pull-request URL, fetch the PR head into a local, stable ref and use that ref as the source of truth for the review worktree. Re-running after new commits are pushed must fast-forward the worktree when possible.
4. Preserve the existing safety rule: dirty or diverged worktrees are not reset or force-updated. Emit a warning and continue with the existing checkout when a fast-forward is impossible.
5. Add `--copy-ignored-files`. It is opt-in, never prompts, copies files ignored by the original GHQ clone's Git rules into the destination worktree, creates missing parent directories, and does not overwrite or delete destination files.
6. The copy option must copy ignored files only; ordinary untracked files must remain excluded.
7. A fallback `pr-<number>` branch is refreshed only when it is associated with that PR by `gwqpull`; an unrelated pre-existing branch must not be changed.
8. Preserve existing output streams, JSON schema, exit codes, collision handling, submodule initialization, and `--no-fetch` behavior. `--no-fetch` skips remote refresh and the associated fast-forward attempts; the ignored-file copy remains controlled by its own explicit option.
9. Update help, README, and maintainer guidance with the new branch-base, PR-refresh, and ignored-file semantics.

## Design

### Default branch resolution

After the clone is located and the normal fetch completes, resolve the default branch from the symbolic ref `refs/remotes/origin/HEAD`. If it is absent, query the remote's symbolic `HEAD` with `git ls-remote --symref origin HEAD`, create/update the local `origin/HEAD` symbolic ref when the response identifies a branch, and use that branch. If no default branch can be identified, fail with an actionable branch error rather than silently using the current checkout.

For a completely new requested branch, create a local branch at `origin/<default>` before invoking `gwq add <branch>`. This preserves gwq's configured naming template while ensuring the branch's start point is explicit. Existing local or remote branches continue through the existing-branch path and are never rebased onto the default branch.

### Pull-request refresh

For PR URL inputs, fetch `refs/pull/<number>/head` into `refs/gwqpull/pull/<number>/head`. The ref is an internal cache of the latest reviewable commit. Same-repository PRs retain their head branch name when that branch exists; fork PRs and deleted-head cases retain the existing `pr-<number>` local branch convention. Fallback branches are associated through `refs/gwqpull/pull/<number>/branch`; a pre-existing unassociated `pr-<number>` is rejected rather than advanced.

After the worktree is found or created, fast-forward it from the PR cache ref. This handles both an existing worktree and a newly created worktree whose local branch was stale. A failed fast-forward is reported as a warning and never rewritten. For non-PR inputs, the existing `origin/<branch>` fast-forward behavior remains.

### Ignored-file seeding

When `--copy-ignored-files` is present, enumerate the original clone's ignored untracked paths using `git ls-files --others --ignored --exclude-standard -z`. Copy each source path to the same relative path under the destination worktree with native Node filesystem operations. Existing destination paths are skipped, so the operation is safe to repeat and cannot overwrite review-specific environment settings. Destination paths are checked for symlinked parents before writing. Source and destination resolving to the same path is a no-op.

Copy failures are surfaced as a worktree error with the affected path. The operation never deletes destination-only files and never copies ordinary untracked files.

### Data flow

```text
locate clone
  -> fetch origin (unless --no-fetch)
  -> resolve requested branch / PR cache ref
  -> resolve default branch only when creating a brand-new branch
  -> reuse or create worktree
  -> ff-only from PR cache ref or origin/<branch>
  -> optionally copy ignored files
  -> initialize submodules
  -> emit existing output contract
```

### Testing

Extend the real-Git shim suite to cover:

- a clone whose current checkout is a non-default branch, proving a new branch starts at `origin/HEAD`;
- an existing branch remaining based on its own tip;
- an existing PR worktree moving to a newly published PR head on a second invocation;
- `--copy-ignored-files` copying ignored files, excluding ordinary untracked files, and preserving an existing destination file;
- the new option's validation/help and unchanged `--no-fetch` behavior.

## Alternatives considered

- Calling `git worktree add` directly with an explicit path would give full start-point control but would duplicate gwq's path template and collision behavior.
- Resetting the review branch to the fetched PR commit would guarantee freshness but could destroy local review notes or edits.
- Overwriting all ignored destination files would synchronize environment changes but could destroy locally customized secrets. Missing-only copy is safer and matches the opt-in seeding use case.
