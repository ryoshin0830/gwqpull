// Exercises the CLI against a **real** git repository with `ghq`, `gwq` and
// `fzf` shims on PATH. git is not shimmed: worktree creation, branch existence
// and fast-forwarding are the logic under test, and faking them would only test
// the fakes. No network, no TTY.
//
// The interactive fzf branch picker is covered by the manual matrix in
// CLAUDE.md — everything reachable without a terminal lives here.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync, mkdirSync, existsSync, readdirSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'gwqpull.mjs');
const SLUG = 'github.com/alice/api';

let sandbox, ghqRoot, wtBase, originDir, shimDir, seedDir, prCommit1, prCommit2;

const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return (r.stdout ?? '').trim();
};

before(() => {
  // realpath the sandbox: on macOS $TMPDIR is /var/... which is a symlink to
  // /private/var/..., and `git worktree list --porcelain` reports the resolved
  // form. Expectations built from an unresolved root would never match.
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'gwqpull-')));
  ghqRoot = join(sandbox, 'ghq');
  wtBase = join(sandbox, 'worktrees');
  originDir = join(sandbox, 'origin.git');
  mkdirSync(ghqRoot, { recursive: true });
  mkdirSync(wtBase, { recursive: true });

  // An origin with two branches: main, and feat/login — whose slash is the
  // reason a worktree directory name can never be trusted as a branch name.
  seedDir = join(sandbox, 'seed');
  mkdirSync(seedDir);
  git(seedDir, 'init', '-q', '-b', 'main');
  git(seedDir, 'config', 'user.email', 'test@example.com');
  git(seedDir, 'config', 'user.name', 'Test');
  writeFileSync(join(seedDir, 'README.md'), '# api\n');
  writeFileSync(join(seedDir, '.gitignore'), '*.env\nignored-dir/\n');
  git(seedDir, 'add', '-A');
  git(seedDir, 'commit', '-qm', 'init');
  git(seedDir, 'branch', 'feat/login');
  git(seedDir, 'branch', 'base/other');

  writeFileSync(join(seedDir, 'main-only.txt'), 'default branch\n');
  git(seedDir, 'add', '-A');
  git(seedDir, 'commit', '-qm', 'main update');

  git(seedDir, 'checkout', '-qb', 'pr/source');
  writeFileSync(join(seedDir, 'PR.md'), 'review commit 1\n');
  git(seedDir, 'add', '-A');
  git(seedDir, 'commit', '-qm', 'pr commit 1');
  prCommit1 = git(seedDir, 'rev-parse', 'HEAD');
  writeFileSync(join(seedDir, 'PR.md'), 'review commit 2\n');
  git(seedDir, 'add', '-A');
  git(seedDir, 'commit', '-qm', 'pr commit 2');
  prCommit2 = git(seedDir, 'rev-parse', 'HEAD');
  git(seedDir, 'checkout', '-q', 'main');

  git(sandbox, 'clone', '-q', '--bare', seedDir, originDir);
  git(originDir, 'update-ref', '-d', 'refs/heads/pr/source');
  git(originDir, 'update-ref', 'refs/pull/42/head', prCommit1);

  shimDir = mkdtempSync(join(tmpdir(), 'gwqpull-shims-'));
  const write = (name, body) => {
    const p = join(shimDir, name);
    writeFileSync(p, body);
    chmodSync(p, 0o755);
  };

  // `ghq get <url>` clones from the local origin instead of the network, and
  // lands it where `ghq root`/<slug> says it will.
  write('ghq', `#!/bin/sh
case "$1" in
  --version) echo "ghq version 1.6.1"; exit 0 ;;
  root)      echo "${ghqRoot}"; exit 0 ;;
  list)
    # Two callers, and they want different things:
    #   \`list -e <owner/repo>\`     -> the slug, for host inference
    #   \`list -e -p <slug>\`        -> the path, for locating the clone
    # Real ghq answers both; a shim that only answered the first made every
    # clone path come back as a bare slug.
    want_path=0
    for a in "$@"; do [ "$a" = "-p" ] && want_path=1; done
    if [ -d "${ghqRoot}/${SLUG}" ] && [ "\${GWQGET_TEST_KNOWN:-1}" = "1" ]; then
      if [ "$want_path" = "1" ]; then echo "${ghqRoot}/${SLUG}"; else echo "${SLUG}"; fi
    fi
    exit 0 ;;
  get)
    dest="${ghqRoot}/${SLUG}"
    mkdir -p "$(dirname "$dest")"
    git clone -q "${originDir}" "$dest" || exit 1
    exit 0 ;;
esac
exit 0
`);

  write('gh', `#!/bin/sh
case "$1" in
  --version) echo "gh version 2.50.0"; exit 0 ;;
  pr)
    [ "$2" = "view" ] || exit 1
    printf '%s\\n' '{"headRefName":"pr/source","isCrossRepository":false,"state":"OPEN","title":"Review PR"}'
    exit 0 ;;
esac
exit 1
`);

  // gwq's real naming template is its own business; the shim only has to put
  // the worktree somewhere and report the git command it ran, which is how the
  // CLI recovers a collision path from the error text.
  write('gwq', `#!/bin/sh
[ "$1" = "--version" ] && { echo "gwq version v0.1.1"; exit 0; }
[ "$1" = "add" ] || exit 0
shift
if [ "$1" = "-b" ]; then newbranch=1; branch="$2"; else newbranch=0; branch="$1"; fi
slug=$(printf '%s' "$branch" | tr '/' '-')
wt="${wtBase}/$slug"
if [ -e "$wt" ] && [ -n "$(ls -A "$wt" 2>/dev/null)" ]; then
  # gwq's real wording, including git's quoted fatal line — that is the line
  # the CLI prefers, so a shim that omitted it tested the wrong branch.
  if [ "$newbranch" = "1" ]; then
    echo "Error: failed to add worktree: git worktree add -b $branch $wt: Preparing worktree" >&2
  else
    echo "Error: failed to add worktree: git worktree add $wt $branch: Preparing worktree" >&2
  fi
  echo "fatal: '$wt' already exists" >&2
  exit 1
fi
if [ "$newbranch" = "1" ]; then
  # Keep the legacy -b path available for the collision parser coverage. The
  # CLI now pre-creates missing branches explicitly, so its normal path uses
  # the branch-only form below.
  git branch "$branch" HEAD >/dev/null 2>&1
  git worktree add "$wt" "$branch" >/dev/null 2>&1 || exit 1
else
  git worktree add "$wt" "$branch" >/dev/null 2>&1 || exit 1
fi
echo "Created worktree at $wt"
exit 0
`);

  write('fzf', `#!/bin/sh
[ "$1" = "--version" ] && { echo "0.74.1"; exit 0; }
# No TTY in tests, so the interactive picker must never be reached.
echo "fzf: interactive UI invoked in a test" >&2
exit 2
`);
});

after(() => {
  for (const d of [sandbox, shimDir]) {
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function run(args, { env = {} } = {}) {
  const childEnv = {
    ...process.env, PATH: `${shimDir}:${process.env.PATH}`, NO_COLOR: '1', ...env,
  };
  // We force NO_COLOR; node itself warns to stderr when FORCE_COLOR is also
  // set, so a developer who exports it would otherwise see phantom failures.
  delete childEnv.FORCE_COLOR;
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: childEnv });
}

// stderr is shared, not ours alone: node emits its own warnings there. Strip
// them before asserting the program itself stayed silent.
const ourStderr = (s) =>
  s.split('\n')
    .filter((l) => l && !/^\(node:\d+\)/.test(l) && !/^\(Use `node --trace-warnings/.test(l))
    .join('\n');

// git that is allowed to fail — for asserting a ref is absent.
const gitTry = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });

const out = (r) => {
  assert.equal(r.status, 0, `exit ${r.status}\n${r.stderr}`);
  return JSON.parse(r.stdout);
};
const jsonLine = (s) => JSON.parse(s.split('\n').find((l) => l.startsWith('{')));

const resetClone = () => {
  rmSync(join(ghqRoot, SLUG), { recursive: true, force: true });
  rmSync(wtBase, { recursive: true, force: true });
  mkdirSync(wtBase, { recursive: true });
};

// ── --init ───────────────────────────────────────────────────────────────────

for (const shell of ['zsh', 'bash', 'fish']) {
  test(`--init ${shell} emits a function and the three-step resolver`, () => {
    const r = run(['--init', shell]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /gwqpull/);
    assert.match(r.stdout, /--quiet/);
    assert.match(r.stdout, /npx -y/);
    assert.ok(r.stdout.includes(BIN));
    assert.equal(ourStderr(r.stderr), '');
  });
}

for (const checker of ['zsh', 'bash']) {
  test(`--init ${checker} output parses under ${checker} -n`, (t) => {
    if (spawnSync(checker, ['-c', 'true'], { stdio: 'ignore' }).error) {
      return t.skip(`${checker} not installed`);
    }
    const r = spawnSync(checker, ['-n'], { input: run(['--init', checker]).stdout, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  });
}

test('--init fish output parses under fish -n', (t) => {
  if (spawnSync('fish', ['-c', 'true'], { stdio: 'ignore' }).error) return t.skip('fish not installed');
  // fish wants a script *file*. `fish -n /dev/stdin` reads the pipe spawnSync
  // hands it on macOS but not on Linux, where it exits 127 with "Error reading
  // script file" — which is how this passed for a year and failed the first
  // time the suite ran on CI. zsh and bash take the snippet on stdin happily.
  const script = mkdtempSync(join(tmpdir(), 'gwqadd-fish-'));
  writeFileSync(join(script, 'init.fish'), run(['--init', 'fish']).stdout);
  const r = spawnSync('fish', ['-n', join(script, 'init.fish')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  rmSync(script, { recursive: true, force: true });
});

test('--cmd renames the emitted function', () => {
  assert.match(run(['--init', 'zsh', '--cmd', 'gw']).stdout, /^gw\(\) \{/m);
});

// ── validation ───────────────────────────────────────────────────────────────

test('no repository argument is a validation error', () => {
  const r = run([]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /a repository is required/);
});

test('a third positional is rejected', () => {
  const r = run(['a/b', 'main', 'extra']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unexpected extra arguments: extra/);
});

test('--json and --quiet are mutually exclusive', () => {
  const r = run(['--json', '--quiet', 'a/b']);
  assert.equal(r.status, 1);
  assert.equal(jsonLine(r.stderr).error.code, 'E_VALIDATION');
});

test('an unparseable spec exits with E_SPEC', () => {
  const r = run(['--json', 'justaword']);
  assert.equal(r.status, 1);
  assert.equal(jsonLine(r.stderr).error.code, 'E_SPEC');
});

// ── spec parsing ─────────────────────────────────────────────────────────────

const specCases = [
  ['owner/repo, host inferred from an existing clone', 'alice/api', SLUG],
  ['host/owner/repo', 'github.com/alice/api', SLUG],
  ['full https URL', 'https://github.com/alice/api', SLUG],
  ['URL with a .git suffix', 'https://github.com/alice/api.git', SLUG],
  ['URL with a trailing slash', 'https://github.com/alice/api/', SLUG],
  ['scp form', 'git@github.com:alice/api.git', SLUG],
  ['ssh:// URL with userinfo', 'ssh://git@github.com/alice/api', SLUG],
  ['query string stripped', 'https://github.com/alice/api?tab=readme', SLUG],
  ['fragment stripped', 'https://github.com/alice/api#readme', SLUG],
];

for (const [name, spec, expected] of specCases) {
  test(`spec: ${name}`, () => {
    const j = out(run(['--json', '-n', '--no-fetch', spec, 'main']));
    assert.equal(j.repo.slug, expected);
  });
}

test('spec: /tree/<branch> supplies the branch', () => {
  const j = out(run(['--json', '-n', '--no-fetch', 'https://github.com/alice/api/tree/feat/login']));
  assert.equal(j.branch, 'feat/login', 'a slashed branch must survive the URL tail');
});

test('spec: an explicit branch argument beats the /tree/ hint', () => {
  const j = out(run(['--json', '-n', '--no-fetch', 'https://github.com/alice/api/tree/feat/login', 'main']));
  assert.equal(j.branch, 'main');
});

test('spec: an unknown owner/repo falls back to github.com', () => {
  const r = run(['--json', '-n', '--no-fetch', 'nobody/nothing', 'main'], {
    env: { GWQGET_TEST_KNOWN: '0' },
  });
  // The clone will fail (the shim only serves one slug), but the host decision
  // is already visible in the error path's spec — assert via a successful slug
  // instead: `alice/api` with inference disabled still resolves to github.com.
  assert.equal(r.status, 1);
  const j2 = out(run(['--json', '-n', '--no-fetch', 'alice/api', 'main'], {
    env: { GWQGET_TEST_KNOWN: '0' },
  }));
  assert.equal(j2.repo.host, 'github.com');
});

// ── the main flow ────────────────────────────────────────────────────────────

test('a missing clone is cloned, then a worktree is created', () => {
  resetClone();
  assert.ok(!existsSync(join(ghqRoot, SLUG)));
  const j = out(run(['--json', '-n', '--no-fetch', 'alice/api', 'feat/login']));
  assert.equal(j.created, true);
  assert.equal(j.branch, 'feat/login');
  assert.equal(j.isMainClone, false);
  assert.ok(existsSync(join(j.path, 'README.md')), 'the worktree must be checked out');
  assert.equal(git(j.path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feat/login');
});

test('re-running is idempotent — same path, created:false', () => {
  const first = out(run(['--json', '-n', '--no-fetch', 'alice/api', 'feat/login']));
  const second = out(run(['--json', '-n', '--no-fetch', 'alice/api', 'feat/login']));
  assert.equal(second.path, first.path);
  assert.equal(second.created, false);
});

test('the main clone holding the branch is reported as isMainClone', () => {
  const j = out(run(['--json', '-n', '--no-fetch', 'alice/api', 'main']));
  assert.equal(j.isMainClone, true, 'git worktree list includes the main working tree');
  assert.equal(j.path, j.clone);
  assert.equal(j.created, false);
});

test('a branch that exists nowhere is created from the default branch', () => {
  resetClone();
  const j = out(run(['--json', '-n', '--no-fetch', 'alice/api', 'brand/new']));
  assert.equal(j.created, true);
  assert.equal(j.branch, 'brand/new');
  assert.equal(git(j.path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'brand/new');
});

test('an existing branch keeps its own history', () => {
  resetClone();
  const j = out(run(['--json', '-n', '--no-fetch', 'alice/api', 'feat/login']));
  const clone = join(ghqRoot, SLUG);
  assert.equal(git(j.path, 'rev-parse', 'HEAD'), git(clone, 'rev-parse', 'origin/feat/login'));
  assert.ok(!existsSync(join(j.path, 'main-only.txt')), 'existing branches must not be rebased onto default');
});

test('help documents default-branch and ignored-file behavior', () => {
  const r = run(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /origin\/HEAD/);
  assert.match(r.stdout, /--copy-ignored-files/);
  assert.match(r.stdout, /--no-copy-ignored-files/);
});

test('a new branch starts from the default branch, not main clone HEAD', () => {
  resetClone();
  out(run(['--json', '-n', '--no-fetch', 'alice/api', 'main']));
  const clone = join(ghqRoot, SLUG);
  git(clone, 'checkout', '-q', '-b', 'base/other', 'origin/base/other');

  const j = out(run(['--json', '-n', '--no-fetch', 'alice/api', 'brand/from-default']));
  assert.equal(j.created, true);
  assert.equal(git(j.path, 'rev-parse', 'HEAD'), git(clone, 'rev-parse', 'origin/main'));
  assert.ok(existsSync(join(j.path, 'main-only.txt')), 'the default branch commit must be present');
});

test('a newly-created branch does not track the default branch', () => {
  resetClone();
  const j = out(run(['--json', '-n', '--no-fetch', 'alice/api', 'brand/no-upstream']));
  assert.equal(
    gitTry(j.path, 'config', '--get', 'branch.brand/no-upstream.remote').status,
    1,
    'a branch created from origin/HEAD must not track the default branch',
  );
  assert.equal(
    gitTry(j.path, 'config', '--get', 'branch.brand/no-upstream.merge').status,
    1,
    'a branch created from origin/HEAD must not have an upstream merge ref',
  );
});

test('an existing PR worktree refreshes to the latest PR head', () => {
  resetClone();
  const first = out(run(['--json', '-n', 'https://github.com/alice/api/pull/42']));
  assert.equal(first.branch, 'pr-42');
  assert.equal(git(first.path, 'rev-parse', 'HEAD'), prCommit1);

  git(originDir, 'update-ref', 'refs/pull/42/head', prCommit2);
  const second = out(run(['--json', '-n', 'https://github.com/alice/api/pull/42']));
  assert.equal(second.path, first.path);
  assert.equal(second.created, false);
  assert.equal(git(second.path, 'rev-parse', 'HEAD'), prCommit2);
});

test('a dirty PR worktree is not fast-forwarded', () => {
  resetClone();
  git(originDir, 'update-ref', 'refs/pull/42/head', prCommit1);
  const first = out(run(['--json', '-n', 'https://github.com/alice/api/pull/42']));
  writeFileSync(join(first.path, 'review-notes.txt'), 'keep this note\n');

  git(originDir, 'update-ref', 'refs/pull/42/head', prCommit2);
  const second = out(run(['--json', '-n', 'https://github.com/alice/api/pull/42']));
  assert.equal(git(second.path, 'rev-parse', 'HEAD'), prCommit1);
  assert.equal(readFileSync(join(second.path, 'review-notes.txt'), 'utf8'), 'keep this note\n');
});

test('an unrelated existing pr-N branch is not changed by a PR URL', () => {
  resetClone();
  git(originDir, 'update-ref', 'refs/pull/42/head', prCommit1);
  out(run(['--json', '-n', '--no-fetch', 'alice/api', 'main']));
  const clone = join(ghqRoot, SLUG);
  git(clone, 'branch', 'pr-42', 'origin/main');

  const r = run(['--json', '-n', 'https://github.com/alice/api/pull/42']);
  assert.equal(r.status, 1);
  assert.equal(jsonLine(r.stderr).error.code, 'E_PR');
  assert.equal(git(clone, 'rev-parse', 'refs/heads/pr-42'), git(clone, 'rev-parse', 'origin/main'));
  assert.ok(!existsSync(join(wtBase, 'pr-42')), 'an unrelated PR branch must not get a review worktree');
});

test('ignored files are seeded by default, without overwriting', () => {
  resetClone();
  out(run(['--json', '-n', '--no-fetch', 'alice/api', 'main']));
  const clone = join(ghqRoot, SLUG);
  writeFileSync(join(clone, '.env'), 'API_URL=https://local.example\n');
  mkdirSync(join(clone, 'ignored-dir'), { recursive: true });
  writeFileSync(join(clone, 'ignored-dir', 'nested.txt'), 'nested ignored\n');
  writeFileSync(join(clone, 'notes.txt'), 'ordinary untracked\n');

  const j = out(run(['--json', '-n', '--no-fetch', 'alice/api', 'feat/login']));
  assert.equal(readFileSync(join(j.path, '.env'), 'utf8'), 'API_URL=https://local.example\n');
  assert.equal(readFileSync(join(j.path, 'ignored-dir', 'nested.txt'), 'utf8'), 'nested ignored\n');
  assert.ok(!existsSync(join(j.path, 'notes.txt')), 'ordinary untracked files must stay out');

  writeFileSync(join(j.path, '.env'), 'API_URL=https://review.example\n');
  const again = out(run(['--json', '-n', '--no-fetch', 'alice/api', 'feat/login']));
  assert.equal(readFileSync(join(j.path, '.env'), 'utf8'), 'API_URL=https://review.example\n');
  assert.deepEqual(again.ignoredFiles, { copied: 0, kept: 2 });
});

test('--no-copy-ignored-files leaves the worktree without them', () => {
  resetClone();
  out(run(['--json', '-n', '--no-fetch', 'alice/api', 'main']));
  const clone = join(ghqRoot, SLUG);
  writeFileSync(join(clone, '.env'), 'API_URL=https://local.example\n');

  const j = out(run([
    '--json', '-n', '--no-fetch', '--no-copy-ignored-files', 'alice/api', 'feat/login',
  ]));
  assert.ok(!existsSync(join(j.path, '.env')), '--no-copy-ignored-files must copy nothing');
});

test('--copy-ignored-files and --no-copy-ignored-files together is a contradiction', () => {
  const r = run([
    '--json', '-n', '--copy-ignored-files', '--no-copy-ignored-files', 'alice/api',
  ]);
  assert.equal(r.status, 1);
  const err = jsonLine(r.stderr).error;
  assert.equal(err.code, 'E_VALIDATION');
  // Not parseArgs rejecting an unknown flag: both spellings must be known.
  assert.match(err.message, /--copy-ignored-files/);
  assert.match(err.message, /--no-copy-ignored-files/);
});

test('--json reports what the copy did', () => {
  resetClone();
  out(run(['--json', '-n', '--no-fetch', 'alice/api', 'main']));
  const clone = join(ghqRoot, SLUG);
  writeFileSync(join(clone, '.env'), 'API_URL=https://local.example\n');

  const j = out(run(['--json', '-n', '--no-fetch', 'alice/api', 'feat/login']));
  assert.deepEqual(j.ignoredFiles, { copied: 1, kept: 0 });
});

test('a symlinked destination parent is skipped, not followed or fatal', () => {
  resetClone();
  out(run(['--json', '-n', '--no-fetch', 'alice/api', 'main']));
  const clone = join(ghqRoot, SLUG);
  mkdirSync(join(clone, 'ignored-dir'), { recursive: true });
  writeFileSync(join(clone, 'ignored-dir', 'nested.txt'), 'must stay inside\n');

  // Create the worktree with the copy off, so the symlink can take the place
  // the copy would otherwise have filled in on this very first run.
  const j = out(run([
    '--json', '-n', '--no-fetch', '--no-copy-ignored-files', 'alice/api', 'feat/login',
  ]));
  const outside = join(sandbox, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, join(j.path, 'ignored-dir'));

  const again = out(run(['--json', '-n', '--no-fetch', 'alice/api', 'feat/login']));
  assert.equal(again.path, j.path, 'the worktree is still reported, not an error');
  assert.deepEqual(again.ignoredFiles, { copied: 0, kept: 0 }, 'the entry is skipped, not copied');
  assert.ok(!existsSync(join(outside, 'nested.txt')), 'copy must not follow a destination symlink');
});

test('an origin-only branch is checked out without -b', () => {
  resetClone();
  // feat/login exists on origin but not locally in a fresh clone.
  const clone = join(ghqRoot, SLUG);
  out(run(['--json', '-n', '--no-fetch', 'alice/api', 'main']));
  assert.equal(
    spawnSync('git', ['-C', clone, 'show-ref', '--verify', '--quiet', 'refs/heads/feat/login']).status,
    1, 'precondition: feat/login is not a local branch yet',
  );
  const j = out(run(['--json', '-n', '--no-fetch', 'alice/api', 'feat/login']));
  assert.equal(j.created, true);
  // Checked out from origin, so it tracks — not an orphan created by -b.
  assert.equal(git(j.path, 'rev-parse', 'HEAD'), git(clone, 'rev-parse', 'origin/feat/login'));
});

// ── collisions ───────────────────────────────────────────────────────────────

test('a colliding directory fails with actionable advice', () => {
  resetClone();
  out(run(['--json', '-n', '--no-fetch', 'alice/api', 'main']));
  const collide = join(wtBase, 'feat-login');
  mkdirSync(collide, { recursive: true });
  writeFileSync(join(collide, 'stray.txt'), 'in the way\n');

  const r = run(['--json', '-n', '--no-fetch', 'alice/api', 'feat/login']);
  assert.equal(r.status, 1);
  assert.equal(jsonLine(r.stderr).error.code, 'E_WORKTREE');
  assert.ok(existsSync(join(collide, 'stray.txt')), 'the collision must be left untouched without -f');
});

test('-f moves the colliding directory aside and succeeds', () => {
  const collide = join(wtBase, 'feat-login');
  assert.ok(existsSync(collide), 'precondition: the previous test left the collision in place');

  const j = out(run(['--json', '-n', '--no-fetch', '-f', 'alice/api', 'feat/login']));
  assert.equal(j.created, true);
  assert.equal(j.path, collide);
  assert.ok(existsSync(join(collide, 'README.md')), 'the worktree replaced the stray directory');

  const backups = readdirSync(wtBase).filter((n) => n.startsWith('feat-login.bak-'));
  assert.equal(backups.length, 1, 'exactly one timestamped backup');
  assert.ok(
    existsSync(join(wtBase, backups[0], 'stray.txt')),
    'the stray file must survive inside the backup — -f moves, never deletes',
  );
});

// ── output contract ──────────────────────────────────────────────────────────

test('--quiet prints the path and nothing else on stdout', () => {
  const r = run(['--quiet', '--no-fetch', 'alice/api', 'main']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), join(ghqRoot, SLUG));
  assert.match(r.stderr, /gwqpull/, 'progress still narrates on stderr in --quiet');
});

test('--no-cd prints nothing on stdout so the shell function stays put', () => {
  const r = run(['--quiet', '--no-fetch', '-n', 'alice/api', 'main']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '', 'a path here would make the wrapper cd anyway');
});

test('progress never contaminates stdout', () => {
  const r = run(['--quiet', '--no-fetch', 'alice/api', 'feat/login']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.split('\n').filter(Boolean).length, 1,
    'stdout must be exactly one line: the path');
  assert.ok(r.stdout.startsWith('/'));
});

// ── dependencies ─────────────────────────────────────────────────────────────

test('a missing gwq exits 127 with the brew command', () => {
  const bare = mkdtempSync(join(tmpdir(), 'gwqpull-noshim-'));
  for (const n of ['git', 'ghq']) {
    writeFileSync(join(bare, n), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bare, n), 0o755);
  }
  const r = spawnSync(process.execPath, [BIN, '--json', 'a/b'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: bare, NO_COLOR: '1' },
  });
  rmSync(bare, { recursive: true, force: true });
  assert.equal(r.status, 127);
  assert.equal(jsonLine(r.stderr).error.code, 'E_DEPS');
  assert.match(jsonLine(r.stderr).error.message, /brew install d-kuro\/tap\/gwq/);
});

test('no branch and no TTY names the candidates instead of hanging', () => {
  resetClone();
  out(run(['--json', '-n', '--no-fetch', 'alice/api', 'main']));
  const r = run(['--json', '-n', '--no-fetch', 'alice/api']);
  assert.equal(r.status, 1);
  const err = jsonLine(r.stderr);
  assert.equal(err.error.code, 'E_BRANCH');
  assert.match(err.error.message, /main/, 'the message must list real branches');
});

test('collision paths parse in both argument orders, spaces and all', () => {
  // `-b` swaps the order, and a gwq basedir under a directory with a space
  // silently broke `-f` entirely: the pattern stopped at the first space, so
  // the path it produced did not exist and the move-aside was skipped without
  // a word. Both forms, with and without spaces, plus git's quoted line.
  const parse = (out, withB) => {
    const quoted = out.match(/fatal: '([^']+)' already exists/)?.[1];
    const cmd = (withB
      ? out.match(/git worktree add -b \S+ (.+?): /)
      : out.match(/git worktree add (.+?) \S+: /))?.[1];
    return (quoted ?? cmd ?? '').trim();
  };
  assert.equal(parse('x: git worktree add -b feat/x /wt/feat-x: Preparing', true), '/wt/feat-x');
  assert.equal(parse('x: git worktree add /wt/feat-x feat/x: Preparing', false), '/wt/feat-x');
  assert.equal(parse('x: git worktree add -b feat/x /a b/feat-x: Preparing', true), '/a b/feat-x');
  assert.equal(parse('x: git worktree add /a b/feat-x feat/x: Preparing', false), '/a b/feat-x');
  assert.equal(parse("fatal: '/a b/feat-x' already exists", false), '/a b/feat-x');
  // The old pattern is what this guards against.
  assert.equal('x: git worktree add -b feat/x /a b/feat-x: p'
    .match(/git worktree add (?:-b [^ ]* )?(\/[^ :]*)/)?.[1], '/a',
    'the superseded pattern truncated at the space');
});

// ── the emitted function, actually run ───────────────────────────────────────
//
// A syntax check never caught this: with the function installed, every flag
// whose output goes to stdout was captured and handed to `cd`. `--version`
// became "no such file or directory: gwqpull x.y.z" and `--help` became
// "file name too long". Run the function for real.

function shellRun(shell, args) {
  const init = run(['--init', shell]).stdout;
  const script = shell === 'fish'
    ? `${init}\ngwqpull ${args.join(' ')}`
    : `${init}\ngwqpull ${args.join(' ')}`;
  return spawnSync(shell, ['-c', script], { encoding: 'utf8' });
}

for (const shell of ['zsh', 'bash', 'fish']) {
  test(`the ${shell} function passes --version through instead of cd'ing into it`, (t) => {
    if (spawnSync(shell, ['-c', 'true'], { stdio: 'ignore' }).error) return t.skip(`${shell} missing`);
    const r = shellRun(shell, ['--version']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^gwqpull \d+\.\d+\.\d+/m);
    assert.doesNotMatch(r.stderr, /cd:|no such file|not a directory/);
  });

  test(`the ${shell} function passes --help through`, (t) => {
    if (spawnSync(shell, ['-c', 'true'], { stdio: 'ignore' }).error) return t.skip(`${shell} missing`);
    const r = shellRun(shell, ['--help']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /USAGE/);
    assert.doesNotMatch(r.stderr, /file name too long|cd:/);
  });
}

// ── the half-created branch ──────────────────────────────────────────────────

test('a blocked worktree rolls the half-created branch back', () => {
  // gwq sanitises `/` to `-`, so asking for `feat-login` lands on the very
  // directory `feat/login` already occupies — an easy collision to hit without
  // meaning to. A failed worktree creation can leave the just-created branch
  // behind, and leaving it turns the next run into "already exists".
  resetClone();
  out(run(['--json', '-n', '--no-fetch', 'alice/api', 'main']));
  const collide = join(wtBase, 'feat-blocked');
  mkdirSync(collide, { recursive: true });
  writeFileSync(join(collide, 'stray.txt'), 'in the way\n');

  const r = run(['--json', '-n', '--no-fetch', 'alice/api', 'feat/blocked']);
  assert.equal(r.status, 1);
  assert.equal(jsonLine(r.stderr).error.code, 'E_WORKTREE');
  assert.equal(
    gitTry(join(ghqRoot, SLUG), 'show-ref', '--verify', '--quiet', 'refs/heads/feat/blocked').status,
    1, 'the branch must not survive the failure',
  );
  assert.ok(existsSync(join(collide, 'stray.txt')), 'the collision is left untouched without -f');
});

test('a branch that already existed is never rolled back', () => {
  // We undo only what we made. A branch the user had may hold their work.
  resetClone();
  out(run(['--json', '-n', '--no-fetch', 'alice/api', 'main']));
  const clone = join(ghqRoot, SLUG);
  git(clone, 'branch', 'feat/mine');
  const collide = join(wtBase, 'feat-mine');
  mkdirSync(collide, { recursive: true });
  writeFileSync(join(collide, 'stray.txt'), 'in the way\n');

  const r = run(['--json', '-n', '--no-fetch', 'alice/api', 'feat/mine']);
  assert.equal(r.status, 1);
  assert.equal(
    gitTry(clone, 'show-ref', '--verify', '--quiet', 'refs/heads/feat/mine').status,
    0, 'never delete a branch we did not create',
  );
});

test('the emitted snippet tells people to use `command`', () => {
  // `eval "$(<pkg> --init zsh)"` in ~/.zshrc resolves to the *function* on every
  // re-source after the first, and a stale function captures this very output
  // and hands it to cd. `command` skips functions. The header comment is the
  // line people copy, so it has to be the correct one.
  for (const shell of ['zsh', 'bash']) {
    const out = run(['--init', shell]).stdout;
    assert.match(out, /eval "\$\(command gwqpull --init (zsh|bash)\)"/,
      `${shell} header must recommend the command form`);
  }
  assert.match(run(['--init', 'fish']).stdout, /command gwqpull --init fish \| source/);
});

test('re-sourcing is idempotent even with a stale function defined', (t) => {
  if (spawnSync('zsh', ['-c', 'true'], { stdio: 'ignore' }).error) return t.skip('zsh missing');
  const init = run(['--init', 'zsh']).stdout;
  // A pre-`command` function: captures stdout and cds into it, whatever it is.
  const stale = `gwqpull() { local d; d=$(echo stale) || return $?; builtin cd -- "$d"; }`;
  const script = [stale, init, 'gwqpull --version'].join('\n');
  const r = spawnSync('zsh', ['-c', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^gwqpull \d+\.\d+\.\d+/m, 'the new function must have replaced the stale one');
  assert.doesNotMatch(r.stderr, /cd:|no such file/);
});

test('new branches follow a renamed remote default branch', () => {
  resetClone();
  out(run(['--json', '-n', '--no-fetch', 'alice/api', 'main']));
  const clone = join(ghqRoot, SLUG);
  git(clone, 'config', 'remote.origin.followRemoteHead', 'never');
  const mainTip = git(originDir, 'rev-parse', 'refs/heads/main');
  git(originDir, 'update-ref', 'refs/heads/trunk', mainTip);
  git(originDir, 'update-ref', '-d', 'refs/heads/main');
  git(originDir, 'symbolic-ref', 'HEAD', 'refs/heads/trunk');

  const j = out(run(['--json', '-n', 'alice/api', 'brand/after-rename']));
  assert.equal(git(j.path, 'rev-parse', 'HEAD'), git(clone, 'rev-parse', 'origin/trunk'));
});
