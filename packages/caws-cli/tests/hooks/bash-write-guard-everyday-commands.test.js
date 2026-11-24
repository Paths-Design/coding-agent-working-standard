'use strict';

/**
 * CAWS-GUARD-ADMIT-PROGRAMS-001: the write guard holds on unproved write
 * targets, not on programs or read options it has no argument profile for.
 *
 * The admitted corpus is taken from commands the installed guard refused in
 * agent sessions between 2026-11-22 and 2026-11-24, plus the neighbouring
 * spellings of each. The refused corpus pairs every admitted family with a
 * write into another session's worktree or a different repository, so a change
 * that admits the family by dropping the check fails here.
 *
 * Every case spawns the real guard over the compiled CLI and reads its exit
 * code and stderr. Submitted commands are never executed.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../..');
const SHARED = path.join(ROOT, 'templates/hook-packs/shared');
const YAML_MODULES = path.dirname(
  path.dirname(require.resolve('js-yaml/package.json', { paths: [ROOT] }))
);
const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
const SESSION = 'everyday-fixture-session';
let fx;

function git(args, cwd = fx.project) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

beforeAll(() => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-everyday-')));
  const project = path.join(root, 'project');
  const sibling = path.join(root, 'sibling');
  const hooks = path.join(root, 'copied-hooks');
  const own = path.join(project, '.caws/worktrees/own');
  const foreign = path.join(project, '.caws/worktrees/foreign');
  fx = { root, project, sibling, hooks, own, foreign };
  for (const directory of [project, sibling]) {
    fs.mkdirSync(directory);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: directory });
  }
  for (const directory of ['.caws/specs', 'scripts', 'docs', 'src', 'tmp', '.venv/bin'])
    fs.mkdirSync(path.join(project, directory), { recursive: true });
  // Local excludes keep generated trees out of the fixture's own history.
  fs.writeFileSync(path.join(project, '.git/info/exclude'), '.caws/\ntmp/\n.venv/\n');
  fs.writeFileSync(path.join(project, 'scripts/run_gates.sh'), '#!/bin/bash\necho gates\n', {
    mode: 0o755,
  });
  fs.writeFileSync(
    path.join(project, 'scripts/lint_docs.py'),
    'from pathlib import Path\nPath("tmp/report.json").write_text("{}")\n'
  );
  // A committed project script that mentions another repository and writes is
  // the project's own reviewed code, like a Makefile target.
  fs.writeFileSync(
    path.join(project, 'scripts/tracked_sync.py'),
    `open("${sibling}/published.md", "w").write("x")\n`
  );
  fs.writeFileSync(
    path.join(project, 'scripts/edited_sync.py'),
    `open("${sibling}/published.md", "w").write("x")\n`
  );
  fs.writeFileSync(path.join(project, 'scripts/retargeted.py'), 'print("report")\n');
  fs.writeFileSync(path.join(project, 'scripts/task.mjs'), "console.log('task')\n");
  fs.writeFileSync(path.join(project, 'docs/guide.md'), '# Guide\n');
  fs.writeFileSync(path.join(project, 'src/app.txt'), 'app\n');
  git(['add', '-A']);
  git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-q',
    '-m',
    'fixture',
  ]);
  git(['worktree', 'add', '-q', '-b', 'fixture-own', own]);
  git(['worktree', 'add', '-q', '-b', 'fixture-foreign', foreign]);
  fs.writeFileSync(
    path.join(project, '.caws/worktrees.json'),
    JSON.stringify({
      own: {
        name: 'own',
        spec_id: 'OWN',
        path: own,
        owner: { session_id: SESSION },
        baseBranch: 'main',
      },
      foreign: {
        name: 'foreign',
        spec_id: 'CLAIM',
        path: foreign,
        owner: { session_id: 'foreign-fixture-session' },
        baseBranch: 'main',
      },
    })
  );
  fs.writeFileSync(
    path.join(project, '.caws/specs/CLAIM.yaml'),
    'id: CLAIM\nlifecycle_state: active\nscope:\n  in:\n    - src/claimed.txt\n  out: []\n'
  );
  fs.cpSync(SHARED, hooks, { recursive: true });
  // Untracked scratch programs: evidence in their source is adjudicated.
  fs.writeFileSync(path.join(project, 'tmp/analyze.py'), 'print(open("docs/guide.md").read())\n');
  fs.writeFileSync(
    path.join(project, 'tmp/read_sibling.py'),
    `print(open("${sibling}/README.md").read())\n`
  );
  fs.writeFileSync(
    path.join(project, 'tmp/write_sibling.py'),
    `from pathlib import Path\nPath("${sibling}/x.md").write_text("x")\n`
  );
  fs.writeFileSync(
    path.join(project, 'tmp/write_sibling.mjs'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync('${sibling}/x.md', 'x');\n`
  );
  fs.writeFileSync(
    path.join(root, 'outside_write.py'),
    `open("${sibling}/x.md", "w").write("x")\n`
  );
  // Only what is committed was reviewed. An edit adds what it adds.
  fs.appendFileSync(path.join(project, 'scripts/edited_sync.py'), 'print("done")\n');
  fs.writeFileSync(
    path.join(project, 'scripts/retargeted.py'),
    `open("${sibling}/x.md", "w").write("x")\n`
  );
  fs.writeFileSync(
    path.join(project, 'scripts/staged_sync.py'),
    `open("${sibling}/x.md", "w").write("x")\n`
  );
  git(['add', '--', 'scripts/staged_sync.py']);
  fx.before = [project, own, foreign].map((cwd) => git(['status', '--porcelain'], cwd));
  const cli = path.join(root, 'caws');
  fs.writeFileSync(
    cli,
    '#!/bin/sh\nexec ' +
      quote(process.execPath) +
      ' ' +
      quote(path.join(ROOT, 'dist/index.js')) +
      ' "$@"\n',
    { mode: 0o755 }
  );
  fx.cli = cli;
});
afterAll(() => {
  if (fx) fs.rmSync(fx.root, { recursive: true, force: true });
});

function guard(command, { cwd = fx.project, mode = 'bypassPermissions', env = {} } = {}) {
  return spawnSync('/bin/bash', [path.join(fx.hooks, 'bash-write-guard.sh')], {
    cwd: fx.project,
    encoding: 'utf8',
    input: JSON.stringify({
      tool_name: 'Bash',
      cwd,
      session_id: SESSION,
      permission_mode: mode,
      tool_input: { command },
    }),
    timeout: 20000,
    env: {
      ...process.env,
      HOME: fx.root,
      NODE_PATH: YAML_MODULES,
      HOOK_TOOL_NAME: 'Bash',
      HOOK_COMMAND: command,
      HOOK_CWD: cwd,
      HOOK_SESSION_ID: SESSION,
      HOOK_PERMISSION_MODE: mode,
      CAWS_PROJECT_DIR: fx.project,
      CAWS_HOOKS_DIR: fx.hooks,
      CAWS_AGENT_SURFACE: 'claude-code',
      CAWS_BIN: fx.cli,
      ...env,
    },
  });
}
const expand = (value) =>
  value.replace(/\{\{([A-Z]+)\}\}/g, (_, key) =>
    key === 'PROJECT'
      ? fx.project
      : key === 'SIBLING'
        ? fx.sibling
        : key === 'FOREIGN'
          ? fx.foreign
          : key === 'OWN'
            ? fx.own
            : fx.root
  );

const PROGRAMS = [
  'bash scripts/run_gates.sh --quick',
  'sh scripts/run_gates.sh --quick',
  'scripts/run_gates.sh --quick',
  './scripts/run_gates.sh --quick',
  '{{PROJECT}}/scripts/run_gates.sh --quick',
  '{{OWN}}/scripts/run_gates.sh --quick',
  'bash -x scripts/run_gates.sh',
  'bash -n scripts/run_gates.sh',
  'bash -euo pipefail scripts/run_gates.sh',
  'mkdir -p {{PROJECT}}/tmp/x && cd {{PROJECT}} && scripts/run_gates.sh --quick > tmp/x/main-quick.log 2>&1; echo "exit $?"',
  'bash scripts/run_gates.sh --quick > {{PROJECT}}/tmp/main-quick.log 2>&1',
  'python3 scripts/lint_docs.py',
  '.venv/bin/python scripts/lint_docs.py 2>&1 | tail -30',
  '.venv/bin/python scripts/lint_docs.py 2>&1 | tail -15; .venv/bin/python scripts/tracked_sync.py 2>&1 | tail -4',
  'python3 scripts/tracked_sync.py',
  'python3 scripts/edited_sync.py',
  'python3 -m pytest -q tests',
  'python3 -W ignore -X utf8 scripts/lint_docs.py',
  'python3 --version',
  'node -v && node --version && python3 -V',
  'node scripts/task.mjs --flag',
  'node --test tests/',
  'node --check scripts/task.mjs',
  'node --max-old-space-size=4096 scripts/task.mjs',
  'node --import tsx scripts/task.mjs',
  './node_modules/.bin/tsc --noEmit',
  'NODE_ENV=test npx jest --runInBand',
  'NODE_OPTIONS=--experimental-vm-modules npx jest',
  'PYTHONPATH=. python3 scripts/lint_docs.py',
  'npm test > tmp/test.log 2>&1',
  'P=.venv/bin/python; for s in lint_docs tracked_sync; do $P scripts/$s.py > tmp/$s.log 2>&1; echo "$s exit $?"; done',
  'python3 tmp/analyze.py',
  'python3 tmp/read_sibling.py',
  'source .venv/bin/activate && pytest -q',
  '"$PWD/scripts/run_gates.sh" --quick',
  'B=/Applications/Tool.app/Contents/MacOS/Tool; $B --background "$PWD/tmp/x.blend" --python tmp/analyze.py > tmp/render.log 2>&1',
];

const READS = [
  'git log --oneline -8',
  "git log -1 --format='%h %ad %s' --date=iso",
  'git log --oneline -8 --grep=inherited -i',
  'git log -n 1 --format=%cs HEAD',
  'git log -S needle --follow -p -- src/app.txt',
  'git merge-base --is-ancestor 1e7d78b74 main',
  'git merge-tree --write-tree main fixture-own',
  'git branch --list fixture-own',
  'git branch --show-current',
  'git diff --cached',
  'git diff -M --stat main...HEAD',
  'git rev-list --left-right --count origin/main...HEAD',
  'git worktree list',
  'git remote -v',
  'git config --get user.name',
  'git describe --tags --always',
  'git blame -L 1,1 src/app.txt',
  'git stash list',
  'git show HEAD:src/app.txt',
  'git status --porcelain=v2 --branch',
  'git -c color.ui=false -c core.quotepath=off log -1',
  'git -C {{FOREIGN}} status --short',
  'git -C {{SIBLING}} log --oneline -3',
  'GIT_PAGER=cat git log -3',
  'grep -n -A 24 "^## Documentation" docs/guide.md',
  'grep -h "TIRE-HEX" .caws/events.jsonl | cut -c 1-420 | tail -14',
  `grep -rlE '"lod": 0,[^{}]*"source": 19008' src --include=kit-manifest.json`,
  'grep -rn x . --exclude-dir=node_modules',
  'grep -o -m 1 -C 3 x docs/guide.md',
  "rg -n --glob '!dist' -A3 needle src",
  'rg --json needle src',
  "tr -d ' ' < docs/guide.md | sed 's/.*\\[//; s/\\]//' | tr ',' '\\n'",
  "sed -n '/start/,/end/p' docs/guide.md",
  "sed -E 's/(a)(b)/\\2\\1/g' docs/guide.md | sort -t, -k2,2n | uniq -c",
  "sed -e '1d' -e 's/w/e/' docs/guide.md",
  'git status --short; command -v caws; command -v jq; type git',
  "ls -la tmp/*.log 2>/dev/null | awk '{print $6,$7,$8,$9}'",
  'cat docs/*.md | head -c 200 | wc -l',
  'for h in "## A" "## B"; do grep -n "${h#\\#\\# }" docs/guide.md; done',
  'while read -r f; do jq -c . "$f"; done < docs/guide.md',
  'while IFS= read -r line; do echo "$line"; done < <(git ls-files)',
  'cat < "$f"; wc -l < "$(ls docs)"',
  'for f in $(git ls-files); do wc -l "$f"; done',
  'for i in {1..3}; do echo "$i"; done',
  'i=0; until [ $i -ge 3 ]; do i=$((i + 1)); done; echo $i',
  'if [[ -f docs/guide.md && ! -d x ]]; then cat docs/guide.md; fi',
  'case "$(uname)" in Darwin) echo mac ;; *) echo other ;; esac',
  'diff <(sort docs/guide.md) <(sort src/app.txt)',
  'echo "${VAR:-default} $((1 + 2)) $HOME"; ls ~',
  'root=$(git rev-parse --show-toplevel 2>/dev/null); echo "$root"',
  'here=$(cd docs && pwd); echo "$here"',
  'cd .. && ls',
  'cd "$(git rev-parse --show-toplevel)" && git status --short',
  'set -euo pipefail; ls; exit 0',
  'export FOO=bar; env | grep FOO',
  'time ls; ! grep -q zzz docs/guide.md',
  'sleep 0 & wait',
  'show() { echo "== $1"; cat "$1"; }; show docs/guide.md',
  'arr=(a b c); arr+=(d); echo "${arr[@]}"',
  "cat <<'EOF'\n$(not run) > /etc/never\nEOF",
];

const WRITES = [
  'echo hi > tmp/note.log',
  "cat > src/new.txt <<'EOF'\nbody\nEOF",
  'echo x > ~/scratch.txt',
  'cd {{OWN}} && echo x > src/own.txt',
  'cd {{OWN}} || exit 1; touch src/own.txt',
  "sed -i '' 's/app/application/' src/app.txt",
  'touch src/a.txt && git add src/a.txt',
  'npm test && git add src/app.txt && git commit -q -m "test: pin behavior"',
  'printf x > src/new.txt; git add src/new.txt; git commit -m "feat: x" -- src/new.txt',
  'git commit -m "$(cat <<\'EOF\'\nfeat: subject\n\nbody line\nEOF\n)"',
  'f=src/app.txt; git add "$f"',
  'git add "$(git rev-parse --show-prefix)"',
  'git add -A && git commit -q -m "chore: x" 2>&1 | tail -3',
  'git fetch origin main 2>&1 | tail -2',
  'git push origin main',
  'git checkout -b feature',
  'git -C {{OWN}} merge main',
  'cd {{OWN}} && git rebase --abort',
  'git tag v1 && git stash push -m wip',
  'D=tmp/out; mkdir -p "$D"; echo x > "$D/log.txt"',
  'source .venv/bin/activate && python scripts/lint_docs.py > tmp/lint.log 2>&1',
  'cd {{OWN}} && . {{PROJECT}}/.venv/bin/activate; pytest -q 2>&1 | tee test.log',
  'source .venv/bin/activate && pytest -q && git add -A && git commit -q -m "test: x"',
  'mapfile -t files < <(git ls-files); printf "%s\\n" "${files[@]}" > tmp/files.txt',
  '(cd docs && ls; exit 0); git add -A',
  'npm test > >(tee tmp/test.log) 2>&1',
  'printf "%d%%\\n" 50; env FOO=1 git add -A',
];

const INLINE = [
  'python3 -c "print(1 + 1)"',
  'python3 -c "import json; print(json.load(open(\'docs/guide.md\')))"',
  "python3 - <<'EOF'\nfrom pathlib import Path\np = Path('src/app.txt')\np.write_text(p.read_text().replace('a', 'b'))\nEOF",
  ".venv/bin/python - <<'EOF'\nrows: dict[str, int] = {}\nopen('out.json', 'w').write('x')\nEOF",
  "python3 - <<'EOF'\ntext = open('{{SIBLING}}/README.md').read()\nopen('tmp/copy.md', 'w').write(text)\nEOF",
  "python3 -c \"open('/tmp/everyday-scratch.md','w').write('x')\"",
  "node -e 'console.log(process.version)'",
  'node -p "require(\'./package.json\').version"',
  "node -e \"const fs = require('fs'); console.log(fs.readdirSync('.').filter(f => f.endsWith('.md')))\"",
  "node - <<'EOF'\nconst fs = require('fs');\nfor (const f of fs.readdirSync('docs')) console.log(f.length);\nEOF",
  'node -e "unknownCall()"',
  'node -e "process.stdout.write(String(1 + 1))"',
  "node -e \"console.log(require('child_process').execSync('git status --short').toString())\"",
  'python3 -c "import sys; sys.stdout.write(\'x\')"',
  "python3 -c \"import subprocess; print(subprocess.check_output(['git', 'status']))\"",
  "python3 -c \"open('Makefile', 'w').write('x')\"",
  "python3 -c \"from pathlib import Path; Path('LICENSE').write_text('x')\"",
  'cd "$SOMEWHERE" && python3 -c "print(1)"',
  'cd "$SOMEWHERE" && python3 -c "open(\'/tmp/everyday.txt\', \'w\')"',
  "python3 - <<'EOF'\npaths = [" +
    Array.from({ length: 300 }, (_, i) => `'docs/part${i}/page.md'`).join(', ') +
    "]\nfor p in paths:\n    open(p, 'w').write('x')\nEOF",
  'bash -c \'for f in a b; do echo "$f"; done\'',
  "bash -lc 'git log --oneline -3'",
];

describe('everyday commands run without a refusal', () => {
  test.each([...PROGRAMS, ...READS, ...WRITES, ...INLINE])('admits: %s', (source) => {
    const command = expand(source);
    const result = guard(command);
    expect(result.error).toBeUndefined();
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      status: 0,
      stdout: '',
      stderr: '',
    });
  });
});

const FOREIGN_WRITES = [
  // Recognized targets behind constructs the guard used to refuse on sight.
  'while read -r f; do echo x > {{SIBLING}}/out; done < docs/guide.md',
  'until false; do touch {{FOREIGN}}/out; done',
  'for i in $(ls); do touch {{SIBLING}}/out; done',
  'for i in {1..3}; do touch {{FOREIGN}}/out; done',
  'case x in x) touch {{SIBLING}}/out ;; esac',
  'case x in x) : ;& y) touch {{FOREIGN}}/out ;; esac',
  'write() { touch {{SIBLING}}/out; }; write',
  'outer() { inner; }; inner() { touch {{FOREIGN}}/out; }; outer',
  'if [[ -n "$(touch {{SIBLING}}/out)" ]]; then :; fi',
  'echo $(( $(touch {{FOREIGN}}/out; echo 1) + 1 ))',
  'echo "${missing:-$(touch {{SIBLING}}/out)}"',
  'arr=($(touch {{FOREIGN}}/out))',
  'export X=$(touch {{SIBLING}}/out)',
  'diff <(touch {{FOREIGN}}/out) docs/guide.md',
  'npm test > >(tee {{SIBLING}}/out) 2>&1',
  'cat <<< "$(touch {{SIBLING}}/out)"',
  'x=$(echo y 2>/dev/null; touch {{FOREIGN}}/out)',
  'sleep 0 & touch {{SIBLING}}/out',
  '! touch {{FOREIGN}}/out',
  'time touch {{SIBLING}}/out',
  'scripts/run_gates.sh && touch {{FOREIGN}}/out',
  'bash scripts/run_gates.sh; echo x > {{SIBLING}}/out',
  'python3 scripts/lint_docs.py > {{FOREIGN}}/out',
  'set -e; touch {{SIBLING}}/out',
  'exit 0 > /nonexistent/x; touch {{FOREIGN}}/out',
  'cd {{FOREIGN}} && echo x > src/app.txt',
  'cd {{FOREIGN}} && source .venv/bin/activate && echo x > out',
  'cd {{OWN}}/../foreign && touch out',
  'cd {{OWN}} || touch {{FOREIGN}}/out',
  'cd {{OWN}} && cd ../foreign && touch out',
  'export D={{SIBLING}}; touch "$D/out"',
  'D={{PROJECT}}/tmp; export D={{SIBLING}}; touch "$D/out"',
  'set_dir() { D={{SIBLING}}; }; D=tmp; set_dir; touch "$D/out"',
  'D=tmp; while read -r x; do D={{FOREIGN}}; done < docs/guide.md; touch "$D/out"',
  'echo x > ~/sibling/out',
  'touch "$HOME/sibling/out"',
  'bash -lc "touch {{SIBLING}}/out"',
  'bash -euo pipefail -c "touch {{FOREIGN}}/out"',
  "sed -i '' 's/a/b/' {{SIBLING}}/README.md",
  // Git operations in metadata owned elsewhere.
  'git -C {{FOREIGN}} commit -m x',
  'git -C {{FOREIGN}} merge main',
  'git -C {{FOREIGN}} checkout -b other',
  'git -C {{FOREIGN}} stash',
  'git -C {{SIBLING}} fetch',
  'git -C {{SIBLING}} branch new',
  'cd {{FOREIGN}} && git add -A && git commit -m x',
  'npm test; git -C {{FOREIGN}} add src/app.txt',
  // Interpreter source whose write evidence names another repository.
  'python3 tmp/write_sibling.py',
  'node tmp/write_sibling.mjs',
  'python3 {{ROOT}}/outside_write.py',
  '.venv/bin/python -u tmp/write_sibling.py',
  'cd tmp && python3 write_sibling.py',
  'python3 scripts/staged_sync.py',
  'python3 scripts/retargeted.py',
  "python3 -c \"open('{{SIBLING}}/x.md','w').write('x')\"",
  'python3 -c "import shutil; shutil.rmtree(\'{{SIBLING}}/x\')"',
  'python3 -c "import os; os.system(\'touch {{SIBLING}}/x\')"',
  "python3 -c \"import subprocess; subprocess.run(['touch', '{{SIBLING}}/x'])\"",
  'python3 -c "from pathlib import Path; Path(\'{{SIBLING}}/x\').unlink()"',
  'python3 -c "from pathlib import Path; Path(\'{{FOREIGN}}/x\').touch()"',
  "python3 -c \"import shutil; open('a.txt','w'); shutil.rmtree('{{SIBLING}}/x')\"",
  "cd {{SIBLING}} && python3 -c \"open('x.md','w').write('x')\"",
  "python3 - <<'EOF'\nfrom pathlib import Path\nPath('{{SIBLING}}/y.md').write_text('x')\nEOF",
  "python3 - <<'EOF'\nfrom pathlib import Path\nPath('{{FOREIGN}}/src/app.txt').write_text('x')\nEOF",
  "node -e \"require('fs').writeFileSync('{{SIBLING}}/x.md','x')\"",
  "node -e \"const fs = require('fs'); for (const f of ['a']) fs.writeFileSync('{{SIBLING}}/' + f, 'x')\"",
  "node -e \"const write = require('fs').writeFileSync; write('{{SIBLING}}/x','x')\"",
];

const UNPROVED = [
  // Options that write a file or run a program, including abbreviations.
  ['git diff --output={{SIBLING}}/x', 'git-option'],
  ['git log -1 --outp={{SIBLING}}/x', 'git-option'],
  ['git diff --ext-diff', 'git-execution'],
  ['git show --textc HEAD', 'git-execution'],
  ['git grep -nOvim needle', 'git-execution'],
  ['git fetch --upload-pack=evil origin', 'git-execution'],
  ['git -c core.pager=evil log', 'git-global-option'],
  ['git -c alias.x=!evil x', 'git-global-option'],
  ['git archive -o {{SIBLING}}/x.tar HEAD', 'git-option'],
  ['sort -o {{SIBLING}}/x docs/guide.md', 'reader-option'],
  ['sort -uo {{SIBLING}}/x docs/guide.md', 'reader-option'],
  ['sort --outp={{SIBLING}}/x docs/guide.md', 'reader-option'],
  ['sort --compress-program=evil docs/guide.md', 'reader-execution'],
  ['rg --pre evil needle', 'reader-execution'],
  ['uniq docs/guide.md {{SIBLING}}/x', 'reader-output'],
  ["sed 'w {{SIBLING}}/x' docs/guide.md", 'sed-script-unsupported'],
  ["sed 's/a/b/w {{SIBLING}}/x' docs/guide.md", 'sed-script-unsupported'],
  ["sed -n '/a/{p;w {{SIBLING}}/x\n}' docs/guide.md", 'sed-script-unsupported'],
  ["sed '1e touch x' docs/guide.md", 'sed-execution'],
  ["sed 's/a/b/ge' docs/guide.md", 'sed-execution'],
  ["sed -Ei 's/a/b/' {{SIBLING}}/README.md", 'sed-option'],
  // Source the projection cannot read literally.
  ['eval "touch {{SIBLING}}/out"', 'mutation-shell-builtin'],
  ["trap 'touch {{FOREIGN}}/out' EXIT", 'mutation-shell-builtin'],
  ['bash -c "$CODE"', 'mutation-code-source'],
  ['cat docs/guide.md | bash', 'mutation-shell-source'],
  ['"$PROGRAM" x', 'mutation-executable-unknown'],
  ["sh -c 'touch {{SIBLING}}/out'", 'mutation-shell-dialect'],
  ['python3 -c "$CODE"', 'mutation-code-source'],
  ["python3 - <<EOF\nopen('$TARGET', 'w')\nEOF", 'mutation-code-expanded'],
  ["node -e \"require('fs').writeFileSync(process.env.DEST,'x')\"", 'mutation-interpreter-effects'],
  ['python3 -c "import sys; open(sys.argv[1], \'w\')"', 'mutation-interpreter-effects'],
  ["NODE_OPTIONS='--require /tmp/preload.cjs' node -e '1'", 'mutation-interpreter-effects'],
  // Unknown coordinates still hold a recognized write that depends on them.
  ['cd "$SOMEWHERE" && echo x > relative', 'cwd-unresolved'],
  ['cd "$SOMEWHERE" && python3 -c "open(\'a/rel.txt\', \'w\')"', 'cwd-unresolved'],
  ['cd "$SOMEWHERE" && python3 -c "open(\'rel.txt\', \'w\')"', 'cwd-unresolved'],
  ['source scripts/run_gates.sh; touch relative', 'cwd-unresolved'],
  ['pushd docs; popd; touch relative', 'cwd-unresolved'],
  ['source ./activate; touch relative', 'cwd-unresolved'],
  ['pushd {{FOREIGN}}; touch "$PWD/out"', 'ask_dynamic_unconfined'],
  ['D=tmp; read -r "$NAME" < docs/guide.md; touch "$D/out"', 'ask_dynamic_unconfined'],
  ['HOME={{FOREIGN}} cd; touch out', 'environment-change'],
  ['mapfile -C evil -c 1 lines < docs/guide.md', 'mutation-shell-builtin'],
  // An exit ends its own subshell; what that subshell did has still happened.
  ['(ln -sfn elsewhere .git; exit 0); git add -A', 'metadata-coordinate-unresolved'],
  ['x=$(ln -sfn elsewhere .git; exit 0); git add -A', 'metadata-coordinate-unresolved'],
  ['{ ln -sfn elsewhere .git; exit 0; } | cat; git add -A', 'metadata-coordinate-unresolved'],
  ['{ ln -sfn elsewhere .git; exit 0; } & git add -A', 'metadata-coordinate-unresolved'],
  ['IFS=,; X=a,b; touch $X', 'environment-change'],
  ['sed $FLAGS s/a/b/ {{SIBLING}}/README.md', 'unknown-splitting'],
  ['cat <> "$f"', 'ask_dynamic_unconfined'],
  ['echo x > "$f"', 'ask_dynamic_unconfined'],
  ['touch $FILES', 'ask_dynamic_unconfined'],
  ['rm -f "$TARGET"', 'ask_dynamic_unconfined'],
  ['i=0; while [ $i -lt 2 ]; do i=$((i + 1)); touch "$i"; done', 'ask_dynamic_unconfined'],
];

describe('a write owned elsewhere is refused behind every admitted construct', () => {
  test.each(FOREIGN_WRITES)('refuses: %s', (source) => {
    const command = expand(source);
    const result = guard(command);
    expect(result.error).toBeUndefined();
    expect({ command, status: result.status }).toEqual({ command, status: 2 });
    expect(result.stderr).toMatch(/DIFFERENT (?:repository|session)/);
  });
  test.each(UNPROVED)('holds: %s', (source, reason) => {
    const command = expand(source);
    const result = guard(command);
    expect(result.error).toBeUndefined();
    expect({ command, status: result.status }).toEqual({ command, status: 2 });
    expect(result.stderr).toContain(reason);
  });
  test('no submitted command ran: neither foreign tree changed', () => {
    expect(fs.readdirSync(fx.sibling)).toEqual(['.git']);
    expect(
      [fx.project, fx.own, fx.foreign].map((cwd) => git(['status', '--porcelain'], cwd))
    ).toEqual(fx.before);
  });
});

describe('a held command names its remedy', () => {
  test('a human decision is requested only where one is available', () => {
    const command = expand('cd "$SOMEWHERE" && echo x > relative');
    const asked = guard(command, { mode: 'default' });
    expect(asked.status).toBe(0);
    const output = JSON.parse(asked.stdout).hookSpecificOutput;
    expect(output.permissionDecision).toBe('ask');
    expect(output.permissionDecisionReason).toContain('cwd-unresolved');
    const blocked = guard(command);
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toContain('literal');
  });
});
