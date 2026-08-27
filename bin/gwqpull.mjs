#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { Buffer } from 'node:buffer';
import {
  readFileSync, existsSync, readdirSync, renameSync, realpathSync,
  cpSync, lstatSync, mkdirSync,
} from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Read from package.json rather than a hand-maintained constant: `npm version`
// only bumps the manifest, so a literal here silently drifts and `--version`
// then reports a build the user isn't running.
const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
const SCHEMA_VERSION = 1;
const PKG = 'gwqpull';
const SELF = fileURLToPath(import.meta.url);

const HELP = `${PKG} ${VERSION} — clone with ghq, add a gwq worktree, and cd into it.

USAGE
  ${PKG} [options] <repo|URL|PR-URL> [branch]
  eval "$(command ${PKG} --init zsh)"   # then \`${PKG}\` moves the shell itself

OPTIONS
  --init <shell>     print shell integration for zsh | bash | fish, then exit
  --cmd <name>       function name emitted by --init (default: ${PKG})
  --no-fetch         skip \`git fetch\` and the ff-only catch-up
  --no-submodules    skip \`git submodule update --init --recursive\`
  --copy-ignored-files  copy missing Git-ignored files from the GHQ clone
  -f, --force        move a colliding worktree directory aside instead of failing
  -n, --no-cd        do the work and report the path, but do not move the shell
  --json             stdout = 1-line JSON
  --quiet            stdout = path only (this is what the shell function uses)
  --no-color         disable ANSI colors (also respects NO_COLOR env)
  -h, --help         show this help
  -V, --version      show version

REPOSITORY SPEC
  https://github.com/o/r            full URL
  git@github.com:o/r.git            scp form (normalised to https)
  github.com/o/r                    host/owner/repo
  o/r                               owner/repo — host inferred from an existing
                                    clone via \`ghq list -e\`, else github.com
  https://github.com/o/r/tree/feat  branch taken from the URL
  https://github.com/o/r/pull/42    branch taken from the PR's head ref

  Omit the branch and fzf offers every local and origin branch.

EXAMPLES
  ${PKG} https://github.com/cli/cli                fzf over the branches
  ${PKG} cli/cli trunk                             straight to a branch
  ${PKG} cli/cli feat/new-thing                    creates the branch if it is new
  ${PKG} https://github.com/cli/cli/pull/42        resolves the PR head
  ${PKG} -n --json cli/cli trunk                   machine-readable, shell stays put

WHAT IT DOES
  1. clone (\`ghq get\`) if the repository is not on disk, else \`git fetch --prune\`
  2. resolve the branch — from the argument, the URL, the PR head, or fzf
  3. create a new branch from the repository default (\`origin/HEAD\`) when needed
     and refresh PR worktrees from the latest PR head
  4. reuse the existing worktree if there is one (fast-forwarding it), else \`gwq add\`
  5. copy missing ignored files only when \`--copy-ignored-files\` is requested
  6. \`git submodule update --init --recursive\` when the tree has submodules
  7. hand the path back so the shell can cd there

  Re-running is safe: every step lands in the same place whether or not the
  clone, the branch and the worktree already existed.

OUTPUT
  Progress goes to stderr. stdout carries only the machine-readable result:
  the path in --quiet, one line of JSON in --json, nothing in pretty mode.

  --json:
    {"schemaVersion":1,"path":"…","branch":"…","clone":"…","repo":{…},
     "pr":null,"created":true,"isMainClone":false,"cd":true}

  On error in --json mode, stdout is empty and stderr gets:
    {"schemaVersion":1,"error":{"code":"E_CLONE","message":"…"},"exitCode":1}

EXIT CODES
  0    success
  1    validation / spec / clone / PR / branch / worktree failure
  127  git, ghq, gwq, fzf or gh not installed (E_DEPS)
  130  interrupted — Esc or Ctrl-C (E_INTERRUPTED)
`;

// ── arg parsing ──────────────────────────────────────────────────────────────

// Detect --json early so even parseArgs / uncaughtException failures can
// produce a schema-compliant JSON error on stderr.
const rawJson = process.argv.slice(2).includes('--json');

function emitEarlyError(message, code = 'E_VALIDATION', exitCode = 1) {
  if (rawJson) {
    process.stderr.write(JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      error: { code, message },
      exitCode,
    }) + '\n');
  } else {
    process.stderr.write(`${PKG}: ${message}\n`);
    process.stderr.write(`run \`${PKG} --help\` for usage.\n`);
  }
  process.exit(exitCode);
}

let values, positionals;
try {
  ({ values, positionals } = parseArgs({
    options: {
      init: { type: 'string' },
      cmd: { type: 'string' },
      'no-fetch': { type: 'boolean' },
      'no-submodules': { type: 'boolean' },
      'copy-ignored-files': { type: 'boolean' },
      force: { type: 'boolean', short: 'f' },
      'no-cd': { type: 'boolean', short: 'n' },
      json: { type: 'boolean' },
      quiet: { type: 'boolean' },
      'no-color': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'V' },
    },
    allowPositionals: true,
  }));
} catch (err) {
  emitEarlyError(err.message);
}

if (values.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (values.version) {
  process.stdout.write(`${PKG} ${VERSION}\n`);
  process.exit(0);
}

// ── color helpers ────────────────────────────────────────────────────────────

const noColorEnv =
  process.env.NO_COLOR != null && process.env.NO_COLOR !== '';
const useColor =
  !noColorEnv && !values['no-color'] && process.stderr.isTTY;
const ansi = (code) =>
  useColor ? (s) => `\x1b[${code}m${s}\x1b[0m` : (s) => String(s);
const dim = ansi(2);
const cyan = ansi(36);
const green = ansi(32);
const yellow = ansi(33);
const red = ansi(31);
const bold = ansi(1);

// ── output helpers ───────────────────────────────────────────────────────────

const isJson = !!values.json;
const isQuiet = !!values.quiet;

const stderr = process.stderr;
// Unlike the sibling pickers, --quiet here still narrates. Cloning a large
// repository takes a while, and the shell function runs in --quiet mode — a
// silent minute would read as a hang. Only --json, whose contract is one line,
// goes quiet. Everything below writes to stderr, never stdout (I1).
const log = (s) => {
  if (isJson) return;
  stderr.write(s + '\n');
};
const warn = (s) => {
  if (isJson) return;
  stderr.write(`${yellow(`${PKG}:`)} ${s}\n`);
};

// ── error reporting ──────────────────────────────────────────────────────────

const EXIT = {
  E_VALIDATION: 1,
  E_SPEC: 1,
  E_CLONE: 1,
  E_PR: 1,
  E_BRANCH: 1,
  E_WORKTREE: 1,
  E_DEPS: 127,
  E_INTERRUPTED: 130,
};

function die(code, message, extra = []) {
  const exitCode = EXIT[code] ?? 1;
  if (isJson) {
    stderr.write(JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      error: { code, message },
      exitCode,
    }) + '\n');
  } else if (code !== 'E_INTERRUPTED') {
    stderr.write(`${red(`${PKG}:`)} ${message}\n`);
    for (const line of extra) stderr.write(`    ${line}\n`);
  }
  process.exit(exitCode);
}

// ── shell integration (--init) ───────────────────────────────────────────────

const SHELLS = ['zsh', 'bash', 'fish'];

// Single-quote for POSIX shells: close, escape, reopen.
const shq = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`;
// fish single-quotes only treat \ and ' as special.
const fishq = (s) => `'${String(s).replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;

// The emitted function resolves the binary in three steps, in this order:
//
//   1. `${PKG}` on PATH — a global install (`npm i -g ${PKG}`). Fastest, and
//      the only one that picks up upgrades.
//   2. the absolute path of the script that generated this snippet. Covers
//      `eval "$(npx -y ${PKG} --init zsh)"` for as long as that file survives.
//   3. `npx -y ${PKG}@<version>` — always correct, ~1s per call.
//
// Step 2 matters because npx caches under ~/.npm/_npx/<hash>/ and npm may
// garbage-collect it; step 3 is what keeps the shell working when it does.
// The lookup is PATH-only (`whence -p` / `type -P` / `command -s`) — the
// function usually shares its name with the binary, so a function-aware
// lookup would find the function and recurse forever.
function shellInit(shell, fnName) {
  const desc = 'Clone with ghq, add a gwq worktree, and cd into it';
  const v = `${PKG}@${VERSION}`;
  const slug = fnName.replaceAll(/[^A-Za-z0-9_]/g, '_');

  if (shell === 'zsh') {
    return `# ${PKG} ${VERSION} — zsh integration
# Add to ~/.zshrc:  eval "$(command ${PKG} --init zsh)"

__${slug}_fallback=${shq(SELF)}

__${slug}_exec() {
  local __bin
  __bin=$(whence -p ${PKG} 2>/dev/null)
  if [[ -n $__bin ]]; then
    "$__bin" "$@"
  elif [[ -x $__${slug}_fallback ]]; then
    "$__${slug}_fallback" "$@"
  else
    npx -y ${shq(v)} "$@"
  fi
}

# ${desc}.
${fnName}() {
  emulate -L zsh
  # These print to stdout for the caller — help text, a list, JSON — and one of
  # them, --json, would collide with the --quiet added below. Capturing that and
  # handing it to cd produced "file name too long" on --help. Pass them through.
  local __a
  for __a in "$@"; do
    case $__a in
      -h|--help|-V|--version|--init|--init=*|--json)
        __${slug}_exec "$@"
        return $?
        ;;
    esac
  done
  local __dir
  __dir=$(__${slug}_exec --quiet "$@") || return $?
  # Empty is not a failure: --no-cd, --help and --version all succeed without
  # naming a destination.
  [[ -n $__dir ]] || return 0
  builtin cd -- "$__dir"
}
`;
  }

  if (shell === 'bash') {
    return `# ${PKG} ${VERSION} — bash integration
# Add to ~/.bashrc:  eval "$(command ${PKG} --init bash)"

__${slug}_fallback=${shq(SELF)}

__${slug}_exec() {
  local __bin
  __bin=$(type -P ${PKG} 2>/dev/null)
  if [ -n "$__bin" ]; then
    "$__bin" "$@"
  elif [ -x "$__${slug}_fallback" ]; then
    "$__${slug}_fallback" "$@"
  else
    npx -y ${shq(v)} "$@"
  fi
}

# ${desc}.
${fnName}() {
  # These print to stdout for the caller — help text, a list, JSON — and one of
  # them, --json, would collide with the --quiet added below. Capturing that and
  # handing it to cd produced "file name too long" on --help. Pass them through.
  local __a
  for __a in "$@"; do
    case "$__a" in
      -h|--help|-V|--version|--init|--init=*|--json)
        __${slug}_exec "$@"
        return $?
        ;;
    esac
  done
  local __dir
  __dir=$(__${slug}_exec --quiet "$@") || return $?
  [ -n "$__dir" ] || return 0
  cd -- "$__dir"
}
`;
  }

  if (shell === 'fish') {
    return `# ${PKG} ${VERSION} — fish integration
# Add to ~/.config/fish/config.fish:  command ${PKG} --init fish | source

set -g __${slug}_fallback ${fishq(SELF)}

function __${slug}_exec
    set -l __bin (command -s ${PKG})
    if test -n "$__bin"
        $__bin $argv
    else if test -x "$__${slug}_fallback"
        $__${slug}_fallback $argv
    else
        npx -y ${fishq(v)} $argv
    end
end

function ${fnName} --description ${fishq(desc)}
    # Help text, a list or JSON goes to the caller, not to cd. --json would also
    # collide with the --quiet added below.
    for __a in $argv
        switch $__a
            case -h --help -V --version --init '--init=*' --json
                __${slug}_exec $argv
                return $status
        end
    end
    set -l __dir (__${slug}_exec --quiet $argv)
    # \`set\` reports the command substitution's status, but not every fish
    # release agrees on that. Capturing it keeps a failed run from cd'ing,
    # and the empty-string guard below is correct either way.
    set -l __st $status
    if test $__st -ne 0
        return $__st
    end
    if test -z "$__dir"
        return 0
    end
    cd -- $__dir
end
`;
  }

  return null;
}

if (values.init != null) {
  const shell = values.init;
  if (!SHELLS.includes(shell)) {
    emitEarlyError(`--init expects one of ${SHELLS.join(' | ')}, got '${shell}'`);
  }
  const fnName = values.cmd ?? PKG;
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(fnName)) {
    emitEarlyError(`--cmd must be a valid shell function name, got '${fnName}'`);
  }
  process.stdout.write(shellInit(shell, fnName));
  process.exit(0);
}

// ── argument validation ──────────────────────────────────────────────────────

if (values.json && values.quiet) {
  die('E_VALIDATION', '--json and --quiet are mutually exclusive');
}
if (values.cmd != null) {
  die('E_VALIDATION', '--cmd is only meaningful together with --init');
}
if (positionals.length === 0) {
  die('E_VALIDATION', 'a repository is required — a URL, owner/repo, or a PR URL');
}
if (positionals.length > 2) {
  die('E_VALIDATION', `unexpected extra arguments: ${positionals.slice(2).join(' ')}`);
}

const doFetch = !values['no-fetch'];
const doSubmodules = !values['no-submodules'];
const copyIgnored = !!values['copy-ignored-files'];
const force = !!values.force;
const stayOut = !!values['no-cd'];

// ── interactivity ────────────────────────────────────────────────────────────

const stdinTTY = !!process.stdin.isTTY;
const stderrTTY = !!process.stderr.isTTY;
// fzf draws its UI on /dev/tty, so a piped stdout (which is the normal case —
// the shell function captures it) does not stop it. What does stop it is
// having no terminal at all, and --json, whose contract is one line and no UI.
const anyTTY = stdinTTY || stderrTTY || !!process.stdout.isTTY;
const isNonInteractive = isJson || !anyTTY;

// Children inherit stderr and have their stdout folded onto ours — which is
// stderr, never stdout. `ghq get` and `git fetch` print progress that must not
// end up inside the path the shell function is about to cd into.
const childStdio = isJson
  ? ['inherit', 'ignore', 'ignore']
  : ['inherit', 2, 'inherit'];

// ── tool checks ──────────────────────────────────────────────────────────────

function commandExists(cmd) {
  const r = spawnSync(cmd, ['--version'], { stdio: 'ignore' });
  return !(r.error && r.error.code === 'ENOENT');
}

const INSTALL = {
  git: { brew: 'git', url: 'https://git-scm.com/downloads' },
  ghq: { brew: 'ghq', url: 'https://github.com/x-motemen/ghq#installation' },
  gwq: { brew: 'd-kuro/tap/gwq', url: 'https://github.com/d-kuro/gwq#installation' },
  fzf: { brew: 'fzf', url: 'https://github.com/junegunn/fzf#installation' },
  gh: { brew: 'gh', url: 'https://cli.github.com/manual/installation' },
};

function brewAvailable() {
  return spawnSync('brew', ['--version'], { stdio: 'ignore' }).status === 0;
}

async function ensureTool(cmd) {
  if (commandExists(cmd)) return;
  const { brew, url } = INSTALL[cmd];
  if (isNonInteractive || !stdinTTY || !stderrTTY) {
    die('E_DEPS', `'${cmd}' not found in PATH. Install it with \`brew install ${brew}\` — ${url}`);
  }
  const ok = await confirmYesNo(`'${cmd}' not found. Install via 'brew install ${brew}'?`);
  if (!ok) die('E_DEPS', `Aborted. See ${url}`);
  if (!brewAvailable()) die('E_DEPS', `Homebrew unavailable. See ${url}`);
  const r = spawnSync('brew', ['install', brew], { stdio: ['inherit', 2, 'inherit'] });
  if (r.status !== 0) die('E_DEPS', `brew install ${brew} failed`);
}

// ── raw-mode keypress (no dependency on a prompt library) ────────────────────

let rawModeEngaged = false;
function disengageRawMode() {
  if (rawModeEngaged && process.stdin.isTTY) {
    try { process.stdin.setRawMode(false); } catch { /* ignore */ }
  }
  rawModeEngaged = false;
}
function restoreCursor() {
  if (process.stderr.isTTY) {
    try { process.stderr.write('\x1b[?25h'); } catch { /* ignore */ }
  }
}

process.on('exit', () => { disengageRawMode(); restoreCursor(); });
for (const sig of ['SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { disengageRawMode(); restoreCursor(); process.exit(130); });
}
process.on('uncaughtException', (err) => {
  disengageRawMode(); restoreCursor();
  if (rawJson) {
    stderr.write(JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      error: { code: 'E_VALIDATION', message: String(err?.message ?? err) },
      exitCode: 1,
    }) + '\n');
  } else {
    stderr.write(`${red(`${PKG}:`)} ${err?.stack ?? err}\n`);
  }
  process.exit(1);
});

async function waitForKey() {
  process.stdin.removeAllListeners('data');
  process.stdin.removeAllListeners('keypress');
  try {
    process.stdin.setRawMode(true);
    rawModeEngaged = true;
  } catch { /* setRawMode throws on non-TTY; let the keypress fall through */ }
  process.stdin.resume();
  try {
    return await new Promise((resolve) => {
      const handler = (buf) => {
        process.stdin.removeListener('data', handler);
        resolve(buf);
      };
      process.stdin.on('data', handler);
    });
  } finally {
    disengageRawMode();
    process.stdin.pause();
  }
}

async function confirmYesNo(question) {
  stderr.write(`${question} ${dim('[Y/n]')} `);
  const buf = await waitForKey();
  stderr.write('\n');
  if (buf.includes(0x03)) process.exit(130);
  const c = buf[0];
  return c === 0x0d || c === 0x0a || c === 0x79 || c === 0x59; // Enter, y, Y
}

// ── git helpers ──────────────────────────────────────────────────────────────

const git = (dir, args, opts = {}) =>
  spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', ...opts });

const gitOut = (dir, args) => {
  const r = git(dir, args);
  return r.status === 0 ? (r.stdout ?? '').trim() : '';
};

const isRepo = (dir) =>
  git(dir, ['rev-parse', '--git-dir'], { stdio: 'ignore' }).status === 0;

const hasLocalBranch = (dir, br) =>
  git(dir, ['show-ref', '--verify', '--quiet', `refs/heads/${br}`], { stdio: 'ignore' }).status === 0;

const hasRemoteBranch = (dir, br) =>
  git(dir, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${br}`], { stdio: 'ignore' }).status === 0;

const hasRef = (dir, ref) =>
  git(dir, ['show-ref', '--verify', '--quiet', ref], { stdio: 'ignore' }).status === 0;

// git reports resolved paths in `worktree list`, so a plain string compare
// against a path we assembled ourselves can miss (/var vs /private/var on
// macOS, or any symlinked ghq root).
function samePath(a, b) {
  if (a === b) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

// The worktree path for a branch, or '' — read from git rather than
// reimplementing gwq's naming template, which we do not control.
function worktreePath(dir, branch) {
  const out = gitOut(dir, ['worktree', 'list', '--porcelain']);
  let current = '';
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length);
    else if (line === `branch refs/heads/${branch}`) return current;
  }
  return '';
}

// Bring an existing checkout up to origin/<branch>, the way `git pull` would.
// The fetch already happened in step 1, so this is merge-only.
//
// --ff-only is the whole point: a divergence or a dirty tree must warn and
// carry on, never rewrite work the user has in progress.
function pullFastForward(wt, branch) {
  if (!hasRemoteBranch(wt, branch)) return; // pr-N and friends have no origin ref
  pullFastForwardRef(wt, branch, `origin/${branch}`);
}

function pullFastForwardRef(wt, branch, sourceRef) {
  if (!hasRef(wt, sourceRef)) return;
  const status = git(wt, ['status', '--porcelain', '--untracked-files=all']);
  if (status.status !== 0 || (status.stdout ?? '').trim()) {
    warn(`could not fast-forward ${branch} to ${sourceRef} — the tree is dirty. Pull by hand.`);
    return;
  }
  const r = git(wt, ['merge', '--ff-only', sourceRef]);
  if (r.status === 0) {
    if (!(r.stdout ?? '').includes('Already up to date')) {
      log(`${dim('│')} ${green('✓')} fast-forwarded ${branch} to ${sourceRef}`);
    }
    return;
  }
  warn(`could not fast-forward ${branch} to ${sourceRef} — diverged, or the tree is dirty. Pull by hand.`);
}

// The path ghq already has for this slug, or '' if it has none.
function existingClone(slug) {
  const r = spawnSync('ghq', ['list', '-e', '-p', slug], { encoding: 'utf8' });
  if (r.status !== 0) return '';
  return (r.stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean)[0] ?? '';
}

// Where `ghq get` will put a new clone: the first root ghq reports.
function primaryRoot() {
  const r = spawnSync('ghq', ['root'], { encoding: 'utf8' });
  const root = r.status === 0 ? (r.stdout ?? '').trim().split('\n')[0] : '';
  if (!root) die('E_CLONE', '`ghq root` returned nothing — is ghq configured?');
  return root;
}

function defaultBranch(dir) {
  let branch = gitOut(dir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (branch.startsWith('origin/')) branch = branch.slice('origin/'.length);

  if (!branch) {
    const r = git(dir, ['ls-remote', '--symref', 'origin', 'HEAD']);
    const line = (r.stdout ?? '').split('\n').find((entry) => entry.startsWith('ref: refs/heads/'));
    branch = line?.match(/^ref: refs\/heads\/(.+)\s+HEAD$/)?.[1] ?? '';
    if (branch) {
      git(dir, [
        'symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${branch}`,
      ], { stdio: 'ignore' });
    }
  }

  if (!branch) {
    die('E_BRANCH', 'could not determine the repository default branch from origin/HEAD');
  }

  if (!hasRemoteBranch(dir, branch)) {
    if (!doFetch) {
      die('E_BRANCH', `the default branch origin/${branch} is not available; re-run without --no-fetch`);
    }
    const r = git(dir, [
      'fetch', '--quiet', 'origin', `refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ], { stdio: childStdio });
    if (r.status !== 0 || !hasRemoteBranch(dir, branch)) {
      die('E_BRANCH', `could not fetch the repository default branch origin/${branch}`);
    }
  }
  return branch;
}

function pathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function isWithin(root, candidate) {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}${sep}`);
}

// Lexical containment does not protect a write through a symlinked parent.
// Check every existing component before mkdir/copy; the destination root is
// realpathed by seedIgnoredFiles so the root itself cannot redirect the write.
function hasSymlinkInPath(root, candidate) {
  const rootPath = resolve(root);
  let current = resolve(candidate);
  if (!isWithin(rootPath, current)) return true;
  while (current !== rootPath) {
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch (err) {
      if (err.code !== 'ENOENT') return true;
    }
    const parent = dirname(current);
    if (parent === current) return true;
    current = parent;
  }
  return false;
}

function seedIgnoredFiles(sourceDir, destinationDir) {
  if (samePath(sourceDir, destinationDir)) return;
  let destinationRoot;
  try {
    destinationRoot = realpathSync(destinationDir);
  } catch (err) {
    die('E_WORKTREE', `could not resolve worktree path ${destinationDir}: ${err.message}`);
  }

  const r = git(sourceDir, [
    'ls-files', '--others', '--ignored', '--exclude-standard', '-z',
  ]);
  if (r.status !== 0) {
    die('E_WORKTREE', `could not list ignored files in ${sourceDir}`);
  }

  const entries = (r.stdout ?? '').split('\0').filter(Boolean);
  let copied = 0;
  let skipped = 0;
  for (const entry of entries) {
    const sourcePath = resolve(sourceDir, entry);
    const destinationPath = resolve(destinationRoot, entry);
    if (!isWithin(sourceDir, sourcePath) || !isWithin(destinationRoot, destinationPath)) {
      die('E_WORKTREE', `ignored file path escapes the worktree: ${entry}`);
    }
    if (!pathExists(sourcePath)) continue;
    if (pathExists(destinationPath)) {
      skipped++;
      continue;
    }
    if (hasSymlinkInPath(destinationRoot, destinationPath)) {
      die('E_WORKTREE', `ignored file path crosses a symlink in the worktree: ${entry}`);
    }
    try {
      mkdirSync(dirname(destinationPath), { recursive: true });
      if (hasSymlinkInPath(destinationRoot, destinationPath)) {
        die('E_WORKTREE', `ignored file path crosses a symlink in the worktree: ${entry}`);
      }
      cpSync(sourcePath, destinationPath, { recursive: true, force: false });
      copied++;
    } catch (err) {
      die('E_WORKTREE', `could not copy ignored file ${entry}: ${err.message}`);
    }
  }

  if (copied || skipped) {
    log(`${dim('│')} copied ${copied} ignored file(s)` +
      (skipped ? `, kept ${skipped} existing file(s)` : ''));
  }
}

// ── repository spec parsing ──────────────────────────────────────────────────

// Accepts full URLs, scp-style git@host:owner/repo.git, host/owner/repo, and
// bare owner/repo. Returns { host, owner, repo, pr, hint }, where `pr` is a
// pull-request number and `hint` a branch taken from a /tree/<branch> URL.
function parseSpec(spec) {
  let s = spec;
  s = s.split('#')[0];
  s = s.split('?')[0];

  // scp form (git@host:owner/repo.git). GitHub over SSH is refused by
  // publickey on some setups, so normalise everything onto https.
  if (!s.includes('://') && s.includes(':') && s.indexOf('/') > s.indexOf(':')) {
    const afterUser = s.includes('@') ? s.slice(s.indexOf('@') + 1) : s;
    const host = afterUser.split(':')[0];
    s = `https://${host}/${s.slice(s.indexOf(':') + 1)}`;
  }

  const scheme = s.indexOf('://');
  if (scheme !== -1) s = s.slice(scheme + 3);
  const firstSeg = s.split('/')[0];
  if (firstSeg.includes('@')) s = s.slice(s.indexOf('@') + 1); // userinfo
  s = s.replace(/\/+$/, '');

  const parts = s.split('/').filter(Boolean);
  let host, owner, repo, rest;

  if (parts[0] && (parts[0].includes('.') || parts[0] === 'localhost')) {
    if (parts.length < 3) {
      die('E_SPEC', `could not identify a repository in '${spec}'`);
    }
    [host, owner, repo] = parts;
    rest = parts.slice(3);
  } else {
    if (parts.length < 2) {
      die('E_SPEC', `expected owner/repo form, got '${spec}'`);
    }
    [owner, repo] = parts;
    rest = parts.slice(2);
    // A bare owner/repo is ambiguous across hosts. An existing clone settles
    // it, which is what lets an internal GHE be reached by shorthand.
    const known = spawnSync('ghq', ['list', '-e', `${owner}/${repo}`], { encoding: 'utf8' });
    const firstHit = known.status === 0
      ? (known.stdout ?? '').trim().split('\n')[0]
      : '';
    host = firstHit ? firstHit.split('/')[0] : 'github.com';
  }

  repo = repo.replace(/\.git$/, '');

  let pr = '';
  let hint = '';
  if (rest[0] === 'pull' || rest[0] === 'pulls') {
    if (/^\d+$/.test(rest[1] ?? '')) pr = rest[1];
  } else if (rest[0] === 'tree' && rest.length >= 2) {
    hint = rest.slice(1).join('/');
  }

  return { host, owner, repo, pr, hint };
}

// ── fzf branch picker ────────────────────────────────────────────────────────

function pickBranch(dir) {
  const out = gitOut(dir, [
    'for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes/origin',
  ]);
  const seen = new Set();
  const branches = out.split('\n')
    .map((b) => b.trim())
    .filter(Boolean)
    .map((b) => (b.startsWith('origin/') ? b.slice('origin/'.length) : b))
    .filter((b) => b !== 'HEAD')
    .filter((b) => (seen.has(b) ? false : (seen.add(b), true)));

  if (branches.length === 0) die('E_BRANCH', 'the repository has no branches to choose from');

  if (isNonInteractive) {
    die('E_BRANCH',
      'no terminal for the fzf branch picker. Name the branch as the second ' +
      `argument — one of: ${branches.slice(0, 8).join(', ')}${branches.length > 8 ? ', …' : ''}`);
  }

  const r = spawnSync('fzf', [
    '--height=40%', '--layout=reverse', '--border', '--prompt=branch> ',
  ], {
    input: branches.join('\n') + '\n',
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  if (r.error) die('E_BRANCH', `could not run fzf: ${r.error.message}`);
  if (r.status === 130 || r.signal === 'SIGINT') die('E_INTERRUPTED', 'cancelled');
  if (r.status !== 0) die('E_INTERRUPTED', 'cancelled');
  const sel = (r.stdout ?? '').trim();
  if (!sel) die('E_INTERRUPTED', 'cancelled');
  return sel;
}

// ── width / box ──────────────────────────────────────────────────────────────

// Rough East Asian Width: 全角 CJK + 全角ラテン + half-symbols treated as wide.
// Good enough for box layouts; bail to one-line fallback when uncertain.
function charWidth(ch) {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return 0;
  if (cp < 0x20) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115F) ||
    (cp >= 0x2E80 && cp <= 0x303E) ||
    (cp >= 0x3041 && cp <= 0x33FF) ||
    (cp >= 0x3400 && cp <= 0x4DBF) ||
    (cp >= 0x4E00 && cp <= 0x9FFF) ||
    (cp >= 0xA000 && cp <= 0xA4CF) ||
    (cp >= 0xAC00 && cp <= 0xD7A3) ||
    (cp >= 0xF900 && cp <= 0xFAFF) ||
    (cp >= 0xFE30 && cp <= 0xFE4F) ||
    (cp >= 0xFF00 && cp <= 0xFF60) ||
    (cp >= 0xFFE0 && cp <= 0xFFE6) ||
    (cp >= 0x1F300 && cp <= 0x1FAFF)
  ) return 2;
  return 1;
}
function strWidth(s) {
  let w = 0;
  for (const ch of s) w += charWidth(ch);
  return w;
}

function renderBox(cdCommand) {
  const cols = process.stdout.columns || process.stderr.columns || 80;
  const inner = strWidth(cdCommand) + 4;
  if (inner + 2 > cols - 2) return `${dim('next:')} ${cyan(cdCommand)}`;
  const titleRaw = ' next ';
  const titleW = strWidth(titleRaw);
  const top = `╭─${titleRaw}${'─'.repeat(Math.max(0, inner - titleW - 1))}╮`;
  const empty = `│${' '.repeat(inner)}│`;
  const bot = `╰${'─'.repeat(inner)}╯`;
  const pad = ' '.repeat(Math.max(0, inner - strWidth(cdCommand) - 2));
  return [
    dim(top), dim(empty),
    dim('│  ') + cyan(cdCommand) + dim(pad + '│'),
    dim(empty), dim(bot),
  ].join('\n');
}

// ── clipboard ────────────────────────────────────────────────────────────────

function hasCmd(c) {
  return spawnSync(c, ['--version'], { stdio: 'ignore' }).error?.code !== 'ENOENT'
    || spawnSync('which', [c], { stdio: 'ignore' }).status === 0;
}
function clipboardCommand() {
  if (process.platform === 'darwin') return { bin: 'pbcopy', args: [] };
  if (process.env.WAYLAND_DISPLAY && hasCmd('wl-copy')) return { bin: 'wl-copy', args: [] };
  if (process.env.DISPLAY && hasCmd('xclip')) {
    return { bin: 'xclip', args: ['-selection', 'clipboard'] };
  }
  return null;
}
function copyToClipboard(text) {
  if (process.env.SSH_CONNECTION || process.env.TMUX) {
    try {
      stderr.write(`\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`);
    } catch { /* ignore */ }
  }
  const cmd = clipboardCommand();
  if (!cmd) {
    stderr.write(dim('clipboard tool not found, copy manually\n'));
    return false;
  }
  const r = spawnSync(cmd.bin, cmd.args, { input: text });
  if (r.status !== 0) {
    stderr.write(dim(`${cmd.bin} failed, copy manually\n`));
    return false;
  }
  return true;
}

// ── steps ────────────────────────────────────────────────────────────────────

// Step 1. Get the main clone on disk and its refs current.
//
// `ghq get -u` is deliberately not used on an existing clone: it runs
// `git pull --ff-only` internally, which fails when the main clone is dirty or
// has diverged. `git fetch --prune` never touches the working tree, so it is
// safe to run over whatever state the user left behind.
// Returns the directory the clone actually occupies, which is not necessarily
// the one guessed before it existed: with several roots configured, which one
// `ghq get` picks is ghq's business, not ours. So ask ghq again afterwards and
// only fall back to the guess if it has nothing to say.
function ensureClone(dir, url, slug) {
  if (dir && isRepo(dir)) {
    log(`${dim('│')} clone exists  ${dim(dir)}`);
    if (doFetch) {
      const r = git(dir, ['fetch', '--prune', '--quiet', 'origin'], { stdio: childStdio });
      if (r.status !== 0) warn('fetch failed — carrying on with the local refs');
      else if (git(dir, ['remote', 'set-head', 'origin', '--auto'], { stdio: 'ignore' }).status !== 0) {
        warn('could not refresh origin/HEAD — using the existing default branch');
      }
    }
    return dir;
  }
  log(`${dim('│')} cloning  ${cyan(url)}`);
  const r = spawnSync('ghq', ['get', url], { stdio: childStdio });
  if (r.signal === 'SIGINT') process.exit(130);
  if (r.status !== 0) die('E_CLONE', `ghq get failed for ${url}`);

  const landed = existingClone(slug) || dir;
  if (!landed || !isRepo(landed)) {
    die('E_CLONE', `ghq get reported success but no clone of ${slug} can be found`);
  }
  return landed;
}

// Step 2. Turn a PR number into a branch that exists locally.
//
// Three shapes have to work: a same-repo PR (use its head ref), a fork PR (the
// head is not on origin at all), and a merged PR whose head branch has since
// been deleted. The last two both resolve through refs/pull/N/head into a
// local pr-N branch.
const prHeadRef = (prNumber) => `refs/gwqpull/pull/${prNumber}/head`;
const prBranchRef = (prNumber) => `refs/gwqpull/pull/${prNumber}/branch`;

function isManagedPrBranch(dir, branch, associationRef) {
  const associatedTip = gitOut(dir, ['rev-parse', associationRef]);
  if (!associatedTip) return false;
  return git(dir, [
    'merge-base', '--is-ancestor', associatedTip, `refs/heads/${branch}`,
  ], { stdio: 'ignore' }).status === 0;
}

function rememberPrBranch(dir, associationRef, sourceRef) {
  return git(dir, ['update-ref', associationRef, sourceRef], { stdio: 'ignore' }).status === 0;
}

async function resolvePrBranch(dir, url, prNumber, host) {
  await ensureTool('gh');
  const r = spawnSync('gh', [
    'pr', 'view', `${url}/pull/${prNumber}`,
    '--json', 'headRefName,isCrossRepository,state,title',
  ], { encoding: 'utf8' });

  if (r.status !== 0) {
    die('E_PR', `could not resolve PR #${prNumber}`, [
      `check that \`gh auth login --hostname ${host}\` has been run`,
      ...((r.stderr ?? '').trim().split('\n').filter(Boolean).slice(0, 3)),
    ]);
  }

  let pr;
  try {
    pr = JSON.parse(r.stdout ?? '');
  } catch (err) {
    die('E_PR', `could not parse \`gh pr view\` output: ${err.message}`);
  }

  log(`${dim('│')} PR #${prNumber} ${dim(`[${pr.state}]`)} ${pr.title}`);

  const sourceRef = prHeadRef(prNumber);
  const associationRef = prBranchRef(prNumber);
  let cachedRef = hasRef(dir, sourceRef) ? sourceRef : '';

  // Keep a stable local ref for the latest reviewable commit. A force update is
  // safe here because this is an internal cache, never a user's branch.
  if (doFetch) {
    const fetched = git(dir, [
      'fetch', '--quiet', 'origin',
      `+refs/pull/${prNumber}/head:${sourceRef}`,
    ], { stdio: 'ignore' });
    if (fetched.status === 0) cachedRef = sourceRef;
    else warn(`could not refresh PR #${prNumber}; using its existing local refs`);
  }

  const materialisePrBranch = (branch, failure) => {
    if (hasLocalBranch(dir, branch)) return isManagedPrBranch(dir, branch, associationRef);
    const made = cachedRef
      ? git(dir, ['branch', '--quiet', branch, cachedRef], { stdio: 'ignore' })
      : { status: 1 };
    if (made.status !== 0) die('E_PR', failure);
    if (!rememberPrBranch(dir, associationRef, cachedRef)) {
      die('E_PR', `could not record local branch ${branch} for PR #${prNumber}`);
    }
    return true;
  };

  if (pr.isCrossRepository === true) {
    const branch = `pr-${prNumber}`;
    const managed = materialisePrBranch(branch,
      `could not fetch refs/pull/${prNumber}/head (remove --no-fetch to refresh it)`);
    if (!managed) {
      die('E_PR', `local branch ${branch} already exists and is not associated with PR #${prNumber}`);
    }
    warn(`fork PR — no upstream is set. Pushing needs the fork added as a remote.`);
    return { branch, sourceRef: cachedRef, associationRef };
  }

  if (hasLocalBranch(dir, pr.headRefName) || hasRemoteBranch(dir, pr.headRefName)) {
    return { branch: pr.headRefName, sourceRef: cachedRef };
  }

  const branch = `pr-${prNumber}`;
  const managed = materialisePrBranch(branch,
    `neither ${pr.headRefName} nor refs/pull/${prNumber}/head could be found (remove --no-fetch to refresh it)`);
  if (!managed) {
    die('E_PR', `local branch ${branch} already exists and is not associated with PR #${prNumber}`);
  }
  warn(`${pr.headRefName} is gone from the remote — fetched it as ${branch} instead`);
  return { branch, sourceRef: cachedRef, associationRef };
}

// A collision's destination has to be recovered from gwq's error text. Two
// sources, in order of reliability:
//
//   fatal: '<path>' already exists            <- git, quoted, unambiguous
//   ...: git worktree add [-b <branch>] <path>: ...
//
// The quoted form is preferred because the command echo is not parseable in
// general: `-b` swaps the argument order (`add -b <branch> <path>` versus
// `add <path> <branch>`), and a path containing a space silently truncated the
// old pattern — a gwq basedir under a directory with a space made `-f` do
// nothing at all, without saying so.
const COLLISION_QUOTED = /fatal: '([^']+)' already exists/;

// The command echo needs to know which form was used, because `-b` swaps the
// argument order and both a path and a branch can follow `add`:
//
//   gwq add -b <branch>      ->  git worktree add -b <branch> <path>: …
//   gwq add <branch>         ->  git worktree add <path> <branch>: …
//
// Guessing cost real time once already: a pattern that stopped at the first
// space read the path-first form correctly by accident, and a pattern that ran
// to the colon swallowed the branch with it.
const collisionFromCmd = (out, withB) => (withB
  ? out.match(/git worktree add -b \S+ (.+?): /)
  : out.match(/git worktree add (.+?) \S+: /))?.[1];

function collisionPath(out, withB) {
  const quoted = out.match(COLLISION_QUOTED)?.[1];
  return (quoted ?? collisionFromCmd(out, withB) ?? '').trim();
}

function timestamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const runGwqAdd = (dir, addArgs) => {
  const r = spawnSync('gwq', ['add', ...addArgs], { cwd: dir, encoding: 'utf8' });
  if (r.error) die('E_WORKTREE', `could not run gwq: ${r.error.message}`);
  return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim(), status: r.status };
};

// Step 3. Land on a worktree for the branch, creating one only when needed.
//
// An existing worktree is never handed to `gwq add` — that is where in-progress
// work lives. It gets fast-forwarded and returned as-is.
function ensureWorktree(dir, branch, sourceRef = '') {
  git(dir, ['worktree', 'prune'], { stdio: 'ignore' }); // clear hand-deleted leftovers

  const refresh = (path) => {
    if (!doFetch) return;
    if (sourceRef) pullFastForwardRef(path, branch, sourceRef);
    else pullFastForward(path, branch);
  };

  const existing = worktreePath(dir, branch);
  if (existing && existsSync(existing)) {
    // `git worktree list` enumerates the main working tree too, so this hit
    // covers both a linked worktree and the main clone having the branch out.
    // Compare through realpath: git reports resolved paths, and on macOS the
    // clone dir can arrive with /var where git says /private/var.
    const isMain = samePath(existing, dir);
    log(isMain
      ? `${dim('│')} the main clone already has ${cyan(branch)} checked out`
      : `${dim('│')} worktree exists  ${dim(existing)}`);
    refresh(existing);
    return { path: existing, created: false, isMainClone: isMain };
  }

  // Reachable when the main clone is on the branch but git did not report it
  // above — a detached-HEAD-adjacent state, or an older git's porcelain output.
  if (gitOut(dir, ['rev-parse', '--abbrev-ref', 'HEAD']) === branch) {
    log(`${dim('│')} the main clone already has ${cyan(branch)} checked out`);
    refresh(dir);
    return { path: dir, created: false, isMainClone: true };
  }

  const known = hasLocalBranch(dir, branch) || hasRemoteBranch(dir, branch);
  let createdByUs = false;
  const addArgs = [branch];
  if (!known) {
    const base = defaultBranch(dir);
    const made = git(dir, [
      'branch', '--quiet', '--no-track', branch, `refs/remotes/origin/${base}`,
    ], { stdio: 'ignore' });
    if (made.status !== 0) {
      die('E_BRANCH', `could not create ${branch} from the default branch origin/${base}`);
    }
    createdByUs = true;
    log(`${dim('│')} creating a new branch  ${cyan(branch)} from ${cyan(`origin/${base}`)}`);
  }

  let { out, status } = runGwqAdd(dir, addArgs);

  // The branch is created explicitly above before gwq is invoked. If gwq fails
  // on the destination, a failed run can leave that branch with no worktree;
  // left alone it turns the next attempt into "branch already exists". The
  // collision is easy to hit without noticing because gwq sanitises `/` to `-`:
  // asking for `feat-template-rate-limit` lands on the directory
  // `feat/template-rate-limit` already occupies. Only ever undo a branch this
  // run created.
  const rollbackBranch = () => {
    if (!createdByUs) return; // the user's branch, not ours to delete
    if (!hasLocalBranch(dir, branch)) return;
    if (worktreePath(dir, branch)) return; // it did get a worktree after all
    if (git(dir, ['branch', '-D', branch], { stdio: 'ignore' }).status === 0) {
      warn(`rolled back the half-created branch ${branch}`);
    }
  };

  if (status !== 0) {
    const collide = collisionPath(out, false);
    // gwq v0.1.1 does not forward -f to `git worktree add`, so a collision has
    // to be cleared here or not at all.
    if (collide && existsSync(collide) && force) {
      const aside = `${collide}.bak-${timestamp()}`;
      warn(`${collide} already exists — moving it to ${aside}`);
      try {
        renameSync(collide, aside);
      } catch (err) {
        rollbackBranch();
        die('E_WORKTREE', `could not move ${collide} aside: ${err.message}`);
      }
      ({ out, status } = runGwqAdd(dir, addArgs));
    }

    if (status !== 0) {
      // A racing run may have created it already; that is a success, not a failure.
      const late = worktreePath(dir, branch);
      if (!late || !existsSync(late)) {
        const detail = out.split('\n').filter((l) => /^(Error:|fatal:)/.test(l));
        if (collide && existsSync(collide)) {
          let count = '?';
          try { count = String(readdirSync(collide).length); } catch { /* ignore */ }
          detail.push(`${collide} still holds ${count} entries`);
          detail.push(`inspect and remove it, or re-run with -f to move it aside`);
        }
        rollbackBranch();
        die('E_WORKTREE', `could not create a worktree for ${branch}`, detail);
      }
      return { path: late, created: true, isMainClone: false };
    }
  }

  if (out) log(out.split('\n').map((l) => `${dim('│')} ${l}`).join('\n'));

  const created = worktreePath(dir, branch);
  if (!created || !existsSync(created)) {
    rollbackBranch();
    die('E_WORKTREE', `gwq add reported success but the worktree path could not be found for ${branch}`);
  }
  refresh(created);
  return { path: created, created: true, isMainClone: false };
}

// ── main flow ────────────────────────────────────────────────────────────────

async function main() {
  await ensureTool('git');
  await ensureTool('ghq');
  await ensureTool('gwq');

  const spec = parseSpec(positionals[0]);
  const slug = `${spec.host}/${spec.owner}/${spec.repo}`;
  const url = `https://${slug}`;

  // Where the clone actually is, not where the primary root says it should be.
  // ghq supports several roots (`ghq.root` repeated, or a colon-separated
  // GHQ_ROOT), and `ghq root` prints only the first. Assembling the path from it
  // made every repository under a secondary root unreachable: `ghq get` saw the
  // clone it already had and did nothing, then this failed with "clone did not
  // land where expected". Ask ghq where the repository is; only fall back to
  // constructing a path for one that does not exist yet.
  let dir = existingClone(slug) || `${primaryRoot()}/${slug}`;

  log(`${dim('┌')} ${bold(PKG)} ${dim(slug)}`);

  dir = ensureClone(dir, url, slug);

  let branch = positionals[1] ?? spec.hint;
  let sourceRef = '';
  let associationRef = '';
  if (spec.pr) {
    const resolved = await resolvePrBranch(dir, url, spec.pr, spec.host);
    branch = resolved.branch;
    sourceRef = resolved.sourceRef;
    associationRef = resolved.associationRef ?? '';
  }
  if (!branch) {
    await ensureTool('fzf');
    branch = pickBranch(dir);
  }

  const wt = ensureWorktree(dir, branch, sourceRef);

  if (associationRef && sourceRef && git(dir, [
    'merge-base', '--is-ancestor', sourceRef, `refs/heads/${branch}`,
  ], { stdio: 'ignore' }).status === 0) {
    if (!rememberPrBranch(dir, associationRef, sourceRef)) {
      die('E_PR', `could not record the refreshed branch ${branch} for PR #${spec.pr}`);
    }
  }

  if (copyIgnored) seedIgnoredFiles(dir, wt.path);

  if (doSubmodules && existsSync(`${wt.path}/.gitmodules`)) {
    log(`${dim('│')} initialising submodules`);
    const r = git(wt.path, ['submodule', 'update', '--init', '--recursive'], { stdio: childStdio });
    if (r.status !== 0) warn('submodule initialisation failed');
  }

  log(`${dim('└')} ${green('✓')} ${cyan(branch)} ${dim('→')} ${wt.path}`);

  // ── output ────────────────────────────────────────────────────────────────
  if (isJson) {
    process.stdout.write(JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      path: wt.path,
      branch,
      clone: dir,
      repo: { host: spec.host, owner: spec.owner, name: spec.repo, slug, url },
      pr: spec.pr ? Number(spec.pr) : null,
      created: wt.created,
      isMainClone: wt.isMainClone,
      cd: !stayOut,
    }) + '\n');
    return;
  }

  if (isQuiet) {
    // The shell function cds to whatever lands here, so --no-cd must print
    // nothing at all rather than a path the wrapper would then follow.
    if (!stayOut) process.stdout.write(wt.path + '\n');
    return;
  }

  if (stayOut) return;

  // Pretty mode is the `npx ${PKG}` path: no shell function is in play, so the
  // best we can do is hand over a cd command the user can paste or copy.
  const cdCommand = `cd "${wt.path}"`;
  stderr.write('\n');
  stderr.write(renderBox(cdCommand) + '\n');
  stderr.write(
    `   ${dim('tip:')} ${dim(`eval "$(command ${PKG} --init zsh)"`)} ${dim('lets')} ` +
    `${bold(PKG)} ${dim('cd for you')}\n`,
  );

  if (!stdinTTY || !stderrTTY) return;
  stderr.write(`   ${dim('press')} ${bold('c')} ${dim('to copy')} ${dim('·')} ${dim('any other key to exit')}\n`);
  const buf = await waitForKey();
  if (buf.includes(0x03)) process.exit(130);
  if (buf[0] === 99 || buf[0] === 67) {
    if (copyToClipboard(cdCommand)) stderr.write(`   ${green('✓')} ${dim('copied')}\n`);
  }
}

main().catch((err) => {
  disengageRawMode();
  restoreCursor();
  if (isJson) {
    stderr.write(JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      error: { code: 'E_VALIDATION', message: String(err?.message ?? err) },
      exitCode: 1,
    }) + '\n');
  } else {
    stderr.write(`${red(`${PKG}:`)} ${err?.stack ?? err}\n`);
  }
  process.exit(1);
});
