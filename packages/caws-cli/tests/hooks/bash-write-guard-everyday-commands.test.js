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
  // A committed script that hands another repository to a program is the
  // project's own reviewed code, like a Makefile target. One that names a write
  // there is refused whoever committed it.
  const synchronize = `import subprocess\nsubprocess.run(["rsync", "tmp/", "${sibling}/pub"])\n`;
  fs.writeFileSync(path.join(project, 'scripts/tracked_sync.py'), synchronize);
  fs.writeFileSync(path.join(project, 'scripts/edited_sync.py'), synchronize);
  fs.writeFileSync(path.join(project, 'scripts/widened_sync.py'), 'import subprocess\n');
  fs.writeFileSync(
    path.join(project, 'scripts/publish.py'),
    `open("${sibling}/published.md", "w").write("x")\n`
  );
  fs.writeFileSync(
    path.join(project, 'scripts/publish.mjs'),
    `import fs from 'node:fs';\nconst out = '${sibling}/published.md';\nfs.writeFileSync(out, 'x');\n`
  );
  fs.writeFileSync(
    path.join(project, 'scripts/compare.mjs'),
    `import fs from 'node:fs';\nconst from = '${sibling}/package.json';\n` +
      "fs.writeFileSync('tmp/report.json', fs.readFileSync(from));\n"
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
  // A link in this project to a file in another repository.
  fs.symlinkSync(path.join(sibling, 'linked.md'), path.join(project, 'tmp/linked.md'));
  // A repository whose name under HOME matches one of this project's directories.
  execFileSync('git', ['init', '-q', path.join(root, 'scripts')]);
  // Only what is committed was reviewed. An edit adds what it adds.
  fs.appendFileSync(path.join(project, 'scripts/edited_sync.py'), 'print("done")\n');
  fs.appendFileSync(
    path.join(project, 'scripts/widened_sync.py'),
    `subprocess.run(["rsync", "tmp/", "${sibling}/pub"])\n`
  );
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
  'node scripts/compare.mjs',
  'for f in scripts/*.py; do python3 "$f"; done',
  'for f in scripts/*.sh; do bash "$f" --quick || exit 1; done',
  'bash -n scripts/*.sh',
  'bash -n scripts/*.sh .githooks/*',
  'export OUT=tmp/out 2>/dev/null; echo x > "$OUT"',
  'python3 -m py_compile scripts/*.py && python3 scripts/lint_*.py',
  'unset GIT_EDITOR PAGER; git status --short; node scripts/task.mjs',
  'find scripts -name "*.sh" | while read -r f; do bash -n "$f"; done',
  "cat > tmp/report.py <<'EOF'\ntext = open('{{SIBLING}}/README.md').read()\nopen('tmp/copy.md', 'w').write(text)\nEOF\npython3 tmp/report.py",
  "cat > tmp/check.sh <<'EOF'\nset -e\ngrep -c x docs/guide.md > tmp/count\nEOF\nbash tmp/check.sh && ./tmp/check.sh",
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
  'grep -n -A3 "remote \\"origin\\"" .git/config; sed -n 60,140p .husky/pre-push',
  "grep -rlE 'inherited|red on main' .caws/specs --include='*.yaml' | xargs ls -t | head -12",
  'git log --oneline -n 8 main && git merge-base HEAD main && caws message inbox 2>&1 | tail -20',
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
  'GIT_SSH_COMMAND="ssh -o ServerAliveInterval=15 -o ServerAliveCountMax=120" git push origin main',
  'git fetch --dry-run . main 2>&1 | head -2; git log --oneline -n 12 main',
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
  'mkdir -p tmp/scratch && cd tmp/scratch && echo x > note.txt',
  '{ npm test; echo "exit $?"; } > tmp/test.log 2>&1; touch tmp/done',
  'git rm -q --cached src/app.txt; git mv src/app.txt src/renamed.txt',
  'git rm docs/guide.md && git commit -q -m "docs: drop the guide"',
  'git clone -q . tmp/copy && ls tmp/copy',
  'files=(src/app.txt docs/guide.md); git add "${files[@]}"; wc -l "${files[@]}"',
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
  // Reading another repository is legal however the source spells it.
  "python3 -c \"import subprocess; print(subprocess.run(['git', '-C', '{{SIBLING}}', 'log']))\"",
  'python3 -c "import os; os.system(\'git -C {{SIBLING}} status --short\')"',
  "python3 - <<'EOF'\nimport json\nfor src, out in [('{{SIBLING}}/a.json', 'tmp/a.json')]:\n    json.dump(json.load(open(src)), open(out, 'w'))\nEOF",
  "python3 - <<'EOF'\nimport os\nfor root, _, names in os.walk('{{SIBLING}}'):\n    for name in names:\n        print(open(os.path.join(root, name)).read())\nopen('tmp/out', 'w').write('x')\nEOF",
  "python3 - <<'EOF'\nimport tempfile, os\nd = tempfile.mkdtemp()\nopen(os.path.join(d, 'x'), 'w').write('y')\nEOF",
  "python3 - <<'EOF'\nimport re\np = 'src/app.txt'\ns = open(p).read()\ns = re.sub('{{SIBLING}}/x', 'y', s)\nopen(p, 'w').write(s)\nEOF",
  "python3 -c \"import glob; [open(f, 'a') for f in glob.glob('src/*.txt')]\"",
  "python3 -c \"open('scripts/x.txt', 'w')\"",
  "node -e \"const w = require('fs').writeFileSync; w('scripts/x.txt', 'x')\"",
  "node -e \"const f = '{{SIBLING}}/package.json'; process.stdout.write(require('fs').readFileSync(f, 'utf8'))\"",
  "node -e \"console.log(require('child_process').execSync('git -C {{SIBLING}} log -1').toString())\"",
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
  // A committed script that names the write, and an edit that adds a mention.
  'python3 scripts/publish.py',
  'node scripts/publish.mjs',
  'python3 scripts/publ*.py',
  'node scripts/publ*.mjs',
  'python3 scripts/widened_sync.py',
  // A program the command writes for itself, whatever the file held before.
  "cat > tmp/new.py <<'EOF'\nopen('{{SIBLING}}/x', 'w')\nEOF\npython3 tmp/new.py",
  "cat > tmp/analyze.py <<'EOF'\nopen('{{SIBLING}}/x', 'w')\nEOF\npython3 tmp/analyze.py",
  "cat > tmp/new.py <<'EOF'\nopen('{{FOREIGN}}/x', 'w')\nEOF\npython3 tmp/new.py",
  "echo \"open('{{SIBLING}}/x','w')\" > tmp/analyze.py; python3 tmp/analyze.py",
  "cat > tmp/new.sh <<'EOF'\ntouch {{SIBLING}}/out\nEOF\nbash tmp/new.sh",
  "cat > tmp/new.sh <<'EOF'\ntouch {{SIBLING}}/out\nEOF\nbash tmp/*.sh",
  "cat > tmp/new.py <<'EOF'\nopen('{{SIBLING}}/x', 'w')\nEOF\npython3 tmp/*.py",
  'D={{SIBLING}}; readonly "D"; export D=tmp; touch "$D/out"',
  "cat > tmp/new.sh <<'EOF'\ntouch {{FOREIGN}}/out\nEOF\nchmod +x tmp/new.sh && ./tmp/new.sh",
  "tee tmp/new <<'EOF'\n#!/usr/bin/env python3\nopen('{{SIBLING}}/x', 'w')\nEOF\ntmp/new",
  // Functions: recursion, redefinition, prefix assignments and local names.
  'f() { f() { touch {{SIBLING}}/out; }; f; }; f',
  'f() { touch tmp/m; cd {{FOREIGN}} && f; }; f',
  'f() { echo x > ~/out; }; HOME={{SIBLING}} f',
  'f() { touch "$D/o"; }; D=tmp; D={{SIBLING}} f',
  'f() { git add -A; }; GIT_DIR={{SIBLING}}/.git GIT_WORK_TREE={{SIBLING}} f',
  '{ exit 0; } > /nonexistent/x; touch {{SIBLING}}/out',
  'for i in 1; do exit 0; done > /nonexistent/x; touch {{FOREIGN}}/out',
  'HOME={{FOREIGN}} cd; touch out',
  'HOME={{FOREIGN}} command cd; touch out',
  'HOME={{FOREIGN}} "cd"; touch out',
  // Source and options behind other quoting and other ways to supply them.
  "bash /dev/stdin <<'EOF'\ntouch {{SIBLING}}/out\nEOF",
  "python3 /dev/stdin <<'EOF'\nopen('{{SIBLING}}/x', 'w')\nEOF",
  "python3 --check-hash-based-pycs never -c \"open('{{SIBLING}}/x', 'w')\"",
  "node --input-type module - <<'EOF'\nimport { writeFileSync } from 'node:fs';\nwriteFileSync('{{SIBLING}}/x', 'x');\nEOF",
  "sed $'-i' '' s/a/b/ {{SIBLING}}/README.md",
  "dd if=/dev/null $'of={{SIBLING}}/x'",
  'touch {tmp/a,{{SIBLING}}/out}',
  'bash -n scripts/*.sh; touch {{SIBLING}}/out',
  // Without the variable, Git finds the repository its directory is in.
  'GIT_DIR={{PROJECT}}/.git; unset GIT_DIR; cd {{FOREIGN}} && git add -A',
  'unset GIT_DIR GIT_WORK_TREE; git -C {{SIBLING}} branch new',
  'D={{SIBLING}}; export D=tmp > /nonexistent/x; touch "$D/out"',
  // Paths Git itself writes.
  'git clone -q . {{SIBLING}}/v',
  'git worktree add {{SIBLING}}/wt',
  'git worktree remove --force {{FOREIGN}}',
  'git merge-file {{SIBLING}}/a b c',
  'git push {{SIBLING}} HEAD:refs/heads/x',
  'git mv src/app.txt {{SIBLING}}/app.txt',
  'cd {{OWN}} && git -C {{FOREIGN}} rm src/app.txt',
  'git -C {{SIBLING}} init --separate-git-dir={{SIBLING}}/g',
  'git -C {{SIBLING}} config --unset-a user.name',
  'git -C {{SIBLING}} symbolic-ref -qd refs/remotes/origin/HEAD',
  'git -C {{FOREIGN}} branch --unset-up',
  'git -C {{FOREIGN}} stash -m list',
  'git -C {{FOREIGN}} notes --ref list add -m x',
  // Python writes whatever spelling names the target.
  "python3 -c \"open('{{SIBLING}}/x.md', mode='w')\"",
  "python3 -c \"import os; open(os.path.join('{{SIBLING}}', 'out.md'), 'w')\"",
  'python3 -c "import os; os.open(\'{{SIBLING}}/x\', os.O_WRONLY | os.O_CREAT)"',
  "python3 -c \"from shutil import move; move('a', '{{SIBLING}}/a')\"",
  "python3 -c \"import os; os.chdir('{{SIBLING}}'); open('x.md', 'w')\"",
  "python3 -c \"from pathlib import Path; [p.unlink() for p in Path('{{SIBLING}}').glob('*.md')]\"",
  'python3 -c "import os; list(map(os.remove, [\'{{SIBLING}}/x\']))"',
  "python3 - <<'EOF'\nD = '{{SIBLING}}'\ndef save(name):\n    with open(f'{D}/{name}', 'w') as out:\n        out.write('x')\nsave('y')\nEOF",
  "python3 - <<'EOF'\nfor src, out in [('tmp/a.json', '{{SIBLING}}/a.json')]:\n    open(out, 'w').write(open(src).read())\nEOF",
  "python3 -c \"open('tmp/linked.md', 'w')\"",
];

const CLAIMED = [
  'touch src/claimed.txt',
  'scripts/run_gates.sh; echo x > src/claimed.txt',
  'for i in $(ls); do touch src/claimed.txt; done',
  'env cd {{OWN}} && touch src/claimed.txt',
  '/usr/bin/cd {{OWN}} && touch src/claimed.txt',
  'git rm src/claimed.txt',
  'git mv src/claimed.txt src/other.txt',
  'cd {{OWN}} && git -C {{PROJECT}} restore src/claimed.txt',
  'cd {{OWN}} && git -C {{PROJECT}} checkout main -- src/claimed.txt',
  "cat > tmp/new.sh <<'EOF'\ntouch src/claimed.txt\nEOF\nbash tmp/new.sh",
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
  ['D=tmp; printf "$O" x; touch "$D/out"', 'ask_dynamic_unconfined'],
  [
    'f() { touch "$D/out"; [ "$D" = {{SIBLING}} ] && return; D={{SIBLING}}; f; }; D=tmp; f',
    'ask_dynamic_unconfined',
  ],
  ['f() { D={{SIBLING}}; local D=tmp; }; D=tmp; f; touch "$D/out"', 'ask_dynamic_unconfined'],
  ['readonly D={{SIBLING}}\nD=tmp\ntouch "$D/out"', 'ask_dynamic_unconfined'],
  ['f() { touch m; cd "$SOMEWHERE" && f; }; f', 'cwd-unresolved'],
  ['exit() { :; }; exit 0; touch {{SIBLING}}/out', 'function-shadow'],
  ['cd() { :; }; cd {{OWN}} && touch src/claimed.txt', 'function-shadow'],
  ['X=a1{{SIBLING}}/out; ((IFS=1)); touch $X', 'environment-change'],
  [': "${CDPATH:={{SIBLING}}}"; cd docs && touch out', 'environment-change'],
  ["read 'a[$(touch {{SIBLING}}/o)]' <<< x", 'read-options'],
  ["X='a[$(touch {{SIBLING}}/o)]'; echo $((X))", 'arithmetic-source'],
  ['cd "$SOMEWHERE" && perl -0pi -e s/a/b/ README.md', 'cwd-unresolved'],
  ['cd "$SOMEWHERE" && touch -- -f', 'cwd-unresolved'],
  ["bash <(echo 'touch {{SIBLING}}/out')", 'mutation-code-source'],
  ["source <(echo 'touch {{SIBLING}}/out')", 'mutation-shell-builtin'],
  ["source /dev/stdin <<'EOF'\ntouch {{SIBLING}}/out\nEOF", 'mutation-shell-builtin'],
  ["bash -O extglob -c 'touch {{SIBLING}}/out'", 'mutation-interpreter-option'],
  ["node --import tsx - <<'EOF'\n1\nEOF", 'mutation-interpreter-option'],
  ["node -r x <<'EOF'\n1\nEOF", 'mutation-interpreter-option'],
  ['node "$FLAG" -e 1', 'mutation-code-source'],
  ["sed $'w {{SIBLING}}/x' docs/guide.md", 'sed-script-unsupported'],
  ["sort $'-o' {{SIBLING}}/x docs/guide.md", 'reader-option'],
  ['sort {-o,{{SIBLING}}/x} docs/guide.md', 'reader-option'],
  ["git diff $'--output={{SIBLING}}/x'", 'git-option'],
  ['a=(-i \'\' s/a/b/ {{SIBLING}}/f); sed "${a[@]}"', 'positional-spread'],
  ['git config -f {{SIBLING}}/.git/config a.b c', 'git-option'],
  ['git archive -vo {{SIBLING}}/x.tar HEAD', 'git-option'],
  ['git checkout-index -a --prefix {{SIBLING}}/', 'git-option'],
  ['git format-patch -no {{SIBLING}} -1', 'git-option'],
  ['git rebase -ix evil main', 'git-execution'],
  ['git init --separate-git-dir=tmp/g', 'git-execution'],
  ['git commit --no-verify -m x', 'git-hooks'],
  ['git commit -anm x', 'git-hooks'],
  ['git -c core.hooksPath=/dev/null commit -m x', 'git-global-option'],
  [
    "cd \"$SOMEWHERE\" && python3 -c \"open('/tmp/a', 'w'); open('rel.txt', 'w')\"",
    'cwd-unresolved',
  ],
  [
    "python3 -c \"import os; os.chdir(os.sep.join(x)); open('rel.txt', 'w')\"",
    'mutation-interpreter-effects',
  ],
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
    // The refusal names the owner this command crosses into, not another one.
    if (/foreign/i.test(source)) {
      expect(result.stderr).toContain("worktree 'foreign'");
      expect(result.stderr).toContain('owned by a DIFFERENT session');
    } else {
      expect(result.stderr).toContain('DIFFERENT repository');
      expect(result.stderr).toContain(fx.sibling);
    }
  });
  test.each(CLAIMED)('refuses a claimed path: %s', (source) => {
    const command = expand(source);
    const result = guard(command);
    expect(result.error).toBeUndefined();
    expect({ command, status: result.status }).toEqual({ command, status: 2 });
    expect(result.stderr).toContain(
      "mutates 'foreign:src/claimed.txt', claimed by an active worktree's scope.in"
    );
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
