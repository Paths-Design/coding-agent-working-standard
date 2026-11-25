'use strict';

/**
 * Exact facts the write projection reports for ordinary shell source: every
 * path a recognized write can name, every Git metadata row, how an interpreter
 * was launched, and every reason a command is held.
 *
 * Each row asserts the complete answer. A missing target is a write nobody
 * checks, and an extra code is a command refused for no reason, so both fail.
 * Submitted source is data; only the fixed runner executes.
 *
 * In a path, @ is the project, ^ its parent and ~ the home directory. A `?`
 * target is one the projection cannot name.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RUNNER = String(async function main() {
  if (process.argv[2]) process.env.__STRYKER_ACTIVE_MUTANT__ = process.argv[2];
  const { projectMutationView } = require(process.argv[1]);
  const output = [];
  for (const request of JSON.parse(require('node:fs').readFileSync(0, 'utf8'))) {
    const previous = { ...process.env };
    for (const [name, value] of Object.entries(request.environment)) process.env[name] = value;
    output.push(
      await projectMutationView(request.input, {
        gitContext: ({ cwd, overrides }) => ({
          directory: overrides.GIT_DIR ?? cwd + '/.git',
          common: overrides.GIT_COMMON_DIR ?? overrides.GIT_DIR ?? cwd + '/.git',
          worktree: overrides.GIT_WORK_TREE ?? cwd,
        }),
      })
    );
    for (const name of Object.keys(request.environment))
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
  }
  process.stdout.write(JSON.stringify(output));
});

const rows = [];
/** Register one case. Every omitted fact is asserted to be empty. */
function add(group, command, facts = {}) {
  rows.push({ group, command, facts, name: `${group}: ${facts.label ?? command}` });
}
/** The command runs: nothing is held, and these are its only named writes. */
const writes = (group, command, ...targets) => add(group, command, { targets });
/** The command is held for exactly this reason. */
const held = (group, code, command, ...targets) =>
  add(group, command, { codes: [].concat(code), targets });
/** The command writes exactly this repository metadata. */
const metadata = (group, command, ...git) => add(group, command, { git });
/** The command launches exactly these interpreters. */
const launches = (group, command, ...run) => add(group, command, { run });

// ── Control flow ────────────────────────────────────────────────────────────

const UNKNOWN_LOOP = 'for x in $(ls); do';
for (const [command, ...targets] of [
  ['while read -r x; do touch a; done', '@/a'],
  ['while touch a; do touch b; done', '@/a', '@/b'],
  ['until touch a; do touch b; done', '@/a', '@/b'],
  [`${UNKNOWN_LOOP} touch a; done`, '@/a'],
  [`D=@/a; ${UNKNOWN_LOOP} D=@/b; done; touch "$D/o"`, '@/a/o', '@/b/o'],
  [`${UNKNOWN_LOOP} E=@/b; done; touch "$E/o"`, '?', '@/b/o'],
  [`f=@/a; ${UNKNOWN_LOOP.replace('x', 'f')} :; done; touch "$f/o"`, '?'],
  ['while D=@/x; false; do :; done; touch "$D/o"', '@/x/o'],
  [`${UNKNOWN_LOOP} cd @/s1; done; touch o`, '@/o', '@/s1/o'],
  ['while read -r x; do cd @/s1; break; cd @/s2; done; touch o', '@/o', '@/s1/o', '@/s2/o'],
  ['while read -r x; do cd @/s1; continue; done; touch o', '@/o', '@/s1/o'],
  ['for x in 1 2; do D=@/b; break; D=@/c; done; touch "$D/o"', '@/b/o', '@/c/o'],
  ['D=@/a; for x in 1; do break; D=@/c; done; touch "$D/o"', '@/a/o', '@/c/o'],
  ['for i in a b; do touch "$i"; done; touch "$i.x"', '@/a', '@/b', '@/b.x'],
  ['for i in a b; do for j in c d; do touch "$i$j"; done; done', '@/ac', '@/ad', '@/bc', '@/bd'],
  ['for i in *.txt; do touch "$i"; done', '?'],
  ['for i in $X; do touch a; done', '@/a'],
  ['for i; do touch "$i" a; done', '?', '@/a'],
  ['for i in "$@"; do touch a; done', '@/a'],
  ['for PATH in a; do touch "$PATH"; done', '@/a'],
  ['select x in a b; do touch "$x"; break; done', '?'],
  ['for ((i = 0; i < 3; i++)); do touch "$i"; done', '?'],
  [
    'for (( $(touch a; echo 1); $(touch b; echo 0); $(touch c; echo 1) )); do touch d; done',
    '@/a',
    '@/b',
    '@/c',
    '@/d',
  ],
  ['for ((;;)); do touch a; break; done', '@/a'],
  ['D=@/a; for ((D = 1; ; )); do break; done; touch "$D/o"', '?'],
  ['D=@/a; for ((i = 0; i < 1; D++)); do :; done; touch "$D/o"', '?'],
  [
    'if touch a; then touch b; elif touch c; then touch d; else touch e; fi',
    '@/a',
    '@/b',
    '@/c',
    '@/d',
    '@/e',
  ],
  ['if x; then cd @/s1; elif y; then cd @/s2; fi; touch o', '@/o', '@/s1/o', '@/s2/o'],
  ['if x; then D=@/a; else D=@/b; fi; touch "$D/o"', '@/a/o', '@/b/o'],
  ['case $x in a) D=@/a ;; b) D=@/b ;; esac; touch "$D/o"', '?', '@/a/o', '@/b/o'],
  ['case x in a) D=@/a ;& b) touch "$D/o" ;; esac', '?', '@/a/o'],
  ['case x in a) D=@/a ;;& b) touch "$D/o" ;; esac', '?', '@/a/o'],
  ['case x in a) D=@/a ;& b) : ;& c) touch "$D/o" ;; esac', '?', '@/a/o'],
  ['case x in a) D=@/a ;; b) touch "$D/o" ;; esac', '?'],
  ['case $(touch w) in $(touch p)) touch b ;; *) ;; esac', '@/w', '@/p', '@/b'],
  ['{ touch a; touch b; }', '@/a', '@/b'],
  ['(cd @/s1; touch a); touch b', '@/b', '@/s1/a', '@/a'],
  ['touch a & touch b', '@/a', '@/b'],
  ['cd @/s1 & touch o', '@/o'],
  ['D=@/a; D=@/b & touch "$D/o"', '@/a/o'],
  ['cd @/s1 | cat; touch o', '@/o'],
  ['touch a | touch b', '@/a', '@/b'],
  ['! touch a', '@/a'],
  ['time touch a', '@/a'],
  ['coproc touch a; touch b', '@/a', '@/b'],
  ['coproc { cd @/s1; }; touch o', '@/o'],
  ['[[ -n $(touch a) ]]', '@/a'],
  ['[[ $(touch a) == $(touch b) ]]', '@/a', '@/b'],
  ['[[ -n x && ! ( $(touch c) = y ) ]]', '@/c'],
  ['(( $(touch a; echo 1) ))', '@/a'],
  ['(( 1 + $(touch a; echo 1) ? $(touch b; echo 1) : -$(touch c; echo 1) ))', '@/a', '@/b', '@/c'],
  ['(( ($(touch a; echo 1)) ))', '@/a'],
])
  writes('control flow', command, ...targets);

const manyStates = (count) =>
  Array.from({ length: count }, (_, i) => `if x; then V${i}=1; fi`).join('; ') +
  '; D=@/a; if x; then D=@/b; fi; touch "$D/o"';
writes('control flow', manyStates(4), '@/a/o', '@/b/o');
writes('control flow', manyStates(7), '@/a/o', '@/b/o');
// Alternatives are listed up to eight and then forgotten together.
const alternatives = (count) =>
  `D=@/a0; ${UNKNOWN_LOOP} case $x in ` +
  Array.from({ length: count - 1 }, (_, i) => `${i}) D=@/a${i + 1} ;;`).join(' ') +
  ' esac; done; touch "$D/o"';
writes('control flow', alternatives(8), ...Array.from({ length: 8 }, (_, i) => `@/a${i}/o`));
// The last pass still knows what it assigned.
writes(
  'control flow',
  alternatives(9),
  '?',
  ...Array.from({ length: 8 }, (_, i) => `@/a${i + 1}/o`)
);
const items = (count) => Array.from({ length: count }, (_, i) => `i${i}`);
writes(
  'control flow',
  `for i in ${items(32).join(' ')}; do touch "$i"; done`,
  ...items(32).map((item) => '@/' + item)
);
writes('control flow', `for i in ${items(33).join(' ')}; do touch "$i"; done`, '?');
// A value that grows on every pass is forgotten, along with the directory.
held(
  'control flow',
  'cwd-unresolved',
  'D=@/a; while read -r x; do D="$D/b"; done; touch "$D/o"',
  '?'
);
held('control flow', 'cwd-unresolved', `${UNKNOWN_LOOP} cd s1; done; touch o`, '@/o', '@/s1/o');
held('control flow', 'loop-input', 'for IFS in a; do touch b; done');
held('control flow', 'statement-syntax', '(( ))');
held('control flow', 'parse-error', 'touch "a');
held('control flow', 'analysis-budget', '( '.repeat(60) + 'touch a' + ' )'.repeat(60));
writes('control flow', '( '.repeat(12) + 'touch a' + ' )'.repeat(12), '@/a');

// ── Leaving and calling ─────────────────────────────────────────────────────

for (const [command, ...targets] of [
  ['exit; touch a'],
  ['exit 1; touch a'],
  ['touch a; exit 0; touch b', '@/a'],
  ['if x; then exit; fi; touch a', '@/a'],
  ['exit $CODE; touch a', '@/a'],
  ['exit 1 2; touch a', '@/a'],
  ['exit abc; touch a', '@/a'],
  ['exit 0 > log; touch a', '@/log', '@/a'],
  ['(exit 1); touch a', '@/a'],
  ['x=$(exit 1; touch a); touch b', '@/b'],
  ['exit 1 | touch a; touch b', '@/a', '@/b'],
  ['while read -r x; do exit; touch a; done; touch b', '@/b'],
  ['cd @/s1 && touch o', '@/s1/o'],
  ['cd @/s1 || touch o', '@/o'],
  ['cd @/s1; touch o', '@/o', '@/s1/o'],
  ['cd @/s1 || exit; touch o', '@/s1/o'],
  ['cd @/s1 || { echo no; exit 1; }; touch o', '@/s1/o'],
  ['cd @/s1 && cd ../s2 && touch o', '@/s2/o'],
  ['cd @/s1 && touch a || touch b', '@/s1/a', '@/s1/b', '@/b'],
  ['! cd @/s1 && touch o', '@/o', '@/s1/o'],
  ['{ cd @/s1; } && touch o', '@/o', '@/s1/o'],
  ['f() { touch a; }; f', '@/a'],
  ['function f { touch a; }; f', '@/a'],
  ['f() { touch a; }'],
  ['f() { touch a; }; f() { touch b; }; f', '@/a', '@/b'],
  ['f() { cd @/s1; }; f; touch o', '@/o', '@/s1/o'],
  ['f() { cd @/s1; return; cd @/s2; }; f; touch o', '@/o', '@/s1/o', '@/s2/o'],
  ['f() { g() { touch a; }; }; f; g', '@/a'],
  ['g() { touch a; }; f() { g; }; f; f', '@/a'],
  ['f() { touch a; }; F=f; $F', '@/a'],
  ['D=@/a; f() { D=@/b; }; f; touch "$D/o"', '@/a/o', '@/b/o'],
  ['f() (cd @/s1; touch a); f; touch b', '@/a', '@/s1/a', '@/b'],
  ['f() { exit; }; f; touch a', '@/a'],
])
  writes('leaving', command, ...targets);
held('leaving', 'cwd-unresolved', 'f() { f; }; f; touch o', '@/o');
held('leaving', 'cwd-unresolved', 'f() { g; }; g() { f; }; f; touch o', '@/o');
held('leaving', 'cwd-unresolved', 'cd @/missing; touch o', '@/o');
held('leaving', 'cwd-unresolved', 'cd @/missing && touch o', '@/o');
writes('leaving', 'cd @/missing || touch o', '@/o');
writes('leaving', 'cd @/missing && touch /abs/o', '/abs/o');

// ── Directories ─────────────────────────────────────────────────────────────

for (const [command, ...targets] of [
  ['cd s1 && touch o', '@/s1/o'],
  ['cd @/s1 && cd .. && touch o', '@/o'],
  ['cd .. && touch o', '^/o'],
  ['cd && touch o', '~/o'],
  ['cd ~ && touch o', '~/o'],
  ['cd ~/h1 && touch o', '~/h1/o'],
  ['HOME=@/s1; cd && touch o', '@/s1/o'],
  ['cd -- s1 && touch o', '@/s1/o'],
  ['cd -P s1 && touch o', '@/s1/o'],
  ['cd -L s1 && touch o', '@/s1/o'],
  ['cd -e -P s1 && touch o', '@/s1/o'],
  ['cd link && touch o', '@/real/deep/o'],
  ['cd link && cd .. && touch o', '@/o'],
  ['cd -P link && cd .. && touch o', '@/real/o'],
  ['cd link && cd -P .. && touch o', '@/real/o'],
  ['cd link/.. && touch o', '@/o'],
  ['cd -P link/.. && touch o', '@/real/o'],
  ['cd link && cd ./../s1 && touch o', '@/s1/o'],
  ['cd s1 && touch "$PWD/o"', '@/s1/o'],
  ['touch "$PWD/o"', '@/o'],
  ['cd s1 && touch "$OLDPWD/o"', '?'],
  ['D=s1; cd "$D" && touch o', '@/s1/o'],
  ['cd "$(git rev-parse --show-toplevel)" && touch /abs/o', '/abs/o'],
  ['cd "$X" && ls && touch /abs/o', '/abs/o'],
  ['cd "$X" && cd @/s1 && touch o', '@/s1/o'],
  ['pushd s1; touch /abs/o', '/abs/o'],
])
  writes('directories', command, ...targets);
for (const [command, ...targets] of [
  ['cd "$X" && touch o', '@/o'],
  ['cd "$X" && touch -- o', '@/o'],
  ['cd "$X" && rm o', '@/o'],
  ['cd "$X" && touch /abs/a rel', '/abs/a', '@/rel'],
  ['cd "$X" && echo x > o', '@/o'],
  ['cd "$X" && bash -c "touch o"', '@/o'],
  ['cd "$X" && cd s1 && touch o', '@/o'],
  ['cd "$X" && cd .. && touch o', '@/o'],
  ['cd - && touch o', '@/o'],
  ['cd a b && touch o', '@/o'],
  ['cd "" && touch o', '@/o'],
  ['cd -x s1 && touch o', '@/o'],
  ['HOME=$X; cd && touch o', '@/o'],
  ['pushd s1; touch o', '@/o'],
  ['popd; touch o', '@/o'],
])
  held('directories', 'cwd-unresolved', command, ...targets);
held('directories', 'cwd-unresolved', 'cd "$X" && touch "$Y"', '?');
held('directories', 'cwd-unresolved', 'cd "$X" && sed -i \'\' s/a/b/ o');
held('directories', 'cwd-unresolved', 'cd "$X" && perl -pi -e s/a/b/ o');
held('directories', 'cwd-unresolved', 'cd "$X" && sed --in-place s/a/b/ o');
add('directories', 'cd "$X" && sed s/a/b/ o');
add('directories', 'cd "$X" && perl -ne print o');
add('directories', 'cd "$X" && node -e \'require("fs").writeFileSync("o", "x")\'', {
  codes: ['cwd-unresolved'],
  run: ['node:inline::finite-writes anywhere'],
});
add('directories', 'cd "$X" && node -e \'require("fs").writeFileSync("/abs/o", "x")\'', {
  run: ['node:inline::finite-writes anywhere'],
});
launches('directories', 'cd "$X" && python3 x.py', 'python:program:x.py:unresolved anywhere');
launches('directories', 'cd s1 && python3 -c 1', 'python:inline::unresolved in @/s1');
// A failed pushd leaves the old directory and its name in place.
held('directories', 'cwd-unresolved', 'pushd s1; touch "$PWD/o"', '?', '@/o');
held('directories', 'cwd-unresolved', 'pushd s1 && touch "$PWD/o"', '?');
// A caller's own unknown directory is reported on every coordinate instead.
add('unknown caller', 'touch o; echo x > p', { cwd: null, targets: ['null:o', 'null:p'] });
add('unknown caller', 'touch "$PWD/o"', { cwd: null, targets: ['?'] });
add('unknown caller', 'cd @/s1 && touch o', { cwd: null, targets: ['null:o'] });
add('unknown caller', 'git add a', { cwd: null, codes: ['metadata-coordinate-unresolved'] });
// Leaving a symlinked directory follows the name the caller used for it.
add('linked caller', 'cd .. && touch o', { cwd: '^/links/project', targets: ['^/links/o'] });
add('linked caller', 'cd -P .. && touch o', { cwd: '^/links/project', targets: ['^/o'] });
add('linked caller', 'touch o "$PWD/p"', { cwd: '^/links/project', targets: ['@/o', '@/p'] });
add('linked caller', "bash -c 'cd .. && touch o'", {
  cwd: '^/links/project',
  targets: ['^/links/o'],
});

// ── Values ──────────────────────────────────────────────────────────────────

for (const [command, ...targets] of [
  ['touch ~/a', '~/a'],
  ['touch ~', '~'],
  ['touch "~/a"', '@/~/a'],
  ['touch a~/b', '@/a~/b'],
  ['touch ~nobody/a', '?'],
  ['touch ~+/a', '?'],
  ['X=~/a; touch "$X"', '~/a'],
  ['X=a:~/b; touch "$X"', '?'],
  ['touch X=~/b', '?'],
  ['HOME=@/s1; touch ~/a', '@/s1/a'],
  ['HOME=relative; touch ~/a', '?'],
  ['HOME=$X; touch ~/a', '?'],
  ['touch "$HOME/a"', '~/a'],
  ['touch "$TMPDIR/a"', '^/tmpdir/a'],
  ['touch "${HOME}/a"', '~/a'],
  ['D=@/a; touch "${D:-x}/o"', '@/a/o'],
  ['D=@/a; touch "${D:?x}/o"', '@/a/o'],
  ['D=@/a; touch "${D:+x}/o"', '?'],
  ['D=; touch "${D:-x}/o"', '?'],
  ['touch "${D:-x}/o"', '?'],
  ['D=@/a; : "${D:=x}"; touch "$D/o"', '?'],
  ['D=@/a; : "${D=x}"; touch "$D/o"', '?'],
  ['D=@/a; : "${D:-x}"; touch "$D/o"', '@/a/o'],
  ['D=@/a; touch "${!D}/o"', '?'],
  ['D=@/a; touch "${#D}"', '?'],
  ['D=@/a; touch "${D[0]}/o"', '?'],
  ['touch "${X:-$(touch a)}"', '?', '@/a'],
  ['touch "${X:=$(touch a)}"', '?', '@/a'],
  ['echo "${X#$(touch a)}"', '@/a'],
  ['echo "${X/$(touch a)/$(touch b)}"', '@/a', '@/b'],
  ['echo "${X:$(touch a; echo 1):$(touch b; echo 1)}"', '@/a', '@/b'],
  ['echo "${X^^$(touch a)}"', '@/a'],
  ['echo "${X[$(touch a; echo 1)]}"', '@/a'],
  ['echo "${X@Q} ${!X*}"'],
  ['echo "$(touch a)"', '@/a'],
  ['echo $(touch a)', '@/a'],
  ['cat <(touch a)', '@/a'],
  ['tee >(touch a) < b > c', '@/a', '@/c', '/dev/null'],
  ['ls > >(touch a)', '@/a', '/dev/null'],
  ['echo $((1 + $(touch a; echo 1)))', '@/a'],
  ['D=@/a; echo $((D = 1)); touch "$D/o"', '?'],
  ['D=@/a; echo $((D += 1)); touch "$D/o"', '?'],
  ['D=@/a; echo $((D <<= 1)); touch "$D/o"', '?'],
  ['D=@/a; echo $((D++)); touch "$D/o"', '?'],
  ['D=@/a; echo $((--D)); touch "$D/o"', '?'],
  ['D=@/a; echo $((D == 1)); touch "$D/o"', '@/a/o'],
  ['D=@/a; echo $((D <= 1)); touch "$D/o"', '@/a/o'],
  ['D=@/a; echo $((-D + 1)); touch "$D/o"', '@/a/o'],
  ['D=@/a; E=@/b; echo $((E = D)); touch "$D/o"', '@/a/o'],
  ['D=@/a; (( D++ )); touch "$D/o"', '?'],
  ["touch $'a b'", '@/a b'],
  ["touch $'a'b", '@/ab'],
  ["touch $''a", '@/a'],
  ['touch $"a"', '@/a'],
  ['touch $"a$(ls)"', '?'],
  ['echo $"$(touch a)"', '@/a'],
  ['echo {a,$(touch b)}', '@/b'],
  ['echo *$(touch a)*', '@/a'],
  ['X="a b"; touch $X', '@/a', '@/b'],
  ['X="a b"; touch "$X"', '@/a b'],
  ['X=" a"; touch b$X', '@/b', '@/a'],
  ['X=a; touch $X$X', '@/aa'],
  ['a=($(touch x)); touch y', '@/x', '@/y'],
  ['a[$(touch x; echo 1)]=1', '@/x'],
  ['D=@/a; D+=b; touch "$D"', '?'],
  ['D=@/a; D=(x); touch "$D"', '?'],
  ['D+=$(touch a)', '@/a'],
  ['D=@/a; D=@/b > log; touch "$D/o"', '@/log', '@/a/o', '@/b/o'],
  ['export D=@/b; touch "$D/o"', '@/b/o'],
  ['D=@/a; export D=@/b > log; touch "$D/o"', '@/log', '@/a/o', '@/b/o'],
  ['D=@/a; export D=@/b 2>&5; touch "$D/o"', '@/a/o', '@/b/o'],
  ['D=@/a; export D=@/b 2>&1; touch "$D/o"', '@/b/o'],
  ['export D=@/b 2>/dev/null; touch "$D/o"', '/dev/null', '@/b/o'],
  ['export D=@/b > /dev/null 2>&1; touch "$D/o"', '/dev/null', '@/b/o'],
  ['D=@/a; readonly "D"; export D=@/b; touch "$D/o"', '?'],
  ['D=@/a; command readonly D; export D=@/b; touch "$D/o"', '?'],
  ['D=@/a; declare D=@/b 2> log; touch "$D/o"', '@/log', '@/a/o', '@/b/o'],
  ['D=@/a; readonly D=@/b; touch "$D/o"', '@/b/o'],
  ['declare -x D=@/b; touch "$D/o"', '@/b/o'],
  ['D=@/a; export E=$D/x; touch "$E/o"', '@/a/x/o'],
  ['export D=$(touch a); touch "$D/o"', '@/a', '?'],
  ['D=@/a; declare D; touch "$D/o"', '?'],
  ['D=@/a; export D; touch "$D/o"', '@/a/o'],
  ['D=@/a; unset D; touch "$D/o"', '?'],
  ['D=@/a; unset -v D; touch "$D/o"', '?'],
  ['D=@/a; read -r D; touch "$D/o"', '?'],
  ['D=@/a; read -r E; touch "$D/o"', '@/a/o'],
  ['REPLY=@/a; read; touch "$REPLY/o"', '?'],
  ['D=@/a; read -r "$N"; touch "$D/o"', '?'],
  ['D=@/a; mapfile -t D; touch "$D/o"', '?'],
  ['D=@/a; mapfile -t E; touch "$D/o"', '@/a/o'],
  ['MAPFILE=@/a; readarray; touch "$MAPFILE/o"', '?'],
  ['D=@/a; printf -v D x; touch "$D/o"', '?'],
  ['D=@/a; printf -v E x; touch "$D/o"', '@/a/o'],
  ['D=@/a; source x.sh || :; touch /abs/o', '/abs/o'],
  ['VIRTUAL_ENV=@/a; source v/bin/activate; touch "$VIRTUAL_ENV/o"', '?'],
  ['D=@/a; source v/bin/activate; touch "$D/o" p', '@/a/o', '@/p'],
  ['. bin/activate && touch o', '@/o'],
  ['D=$X; touch "$D"', '?'],
])
  writes('values', command, ...targets);
held('values', 'parameter-operation', 'echo "${X@P}"');
held('values', 'cwd-unresolved', 'source x.sh; touch o', '@/o');
held('values', 'cwd-unresolved', '. ./activate; touch o', '@/o');
held('values', 'cwd-unresolved', 'D=@/a; source x.sh; touch "$D/o"', '@/a/o', '?');
const pick = `D=a; ${UNKNOWN_LOOP} D=b; done; `;
writes('values', pick + 'touch "$D$D"', '@/aa', '@/ab', '@/ba', '@/bb');
writes('values', pick + 'touch "' + '$D'.repeat(6) + '"', '?', '@/bbbbbb');
writes('values', pick + 'touch "' + '$D'.repeat(6) + '$(touch z)"', '?', '@/z');
add('values', pick + 'ls ' + '"$D" '.repeat(6));
held('values', 'argument-budget', pick + 'touch ' + '"$D" '.repeat(6), ...['@/a', '@/b', '?']);

// ── Fields ──────────────────────────────────────────────────────────────────

for (const command of [
  'ls $X',
  'ls *.log',
  'ls "$@"',
  'git log $X',
  'sed s/a/b/ $X',
  'perl -ne print $X',
  'cat {a,b}',
  'X="*.log"; ls $X',
  'grep -c x docs/*',
])
  add('fields', command);
for (const [code, command, ...targets] of [
  ['unknown-splitting', 'touch $X', '?'],
  ['unknown-splitting', 'rm -f $X', '?'],
  ['unknown-splitting', 'command touch $X', '?'],
  ['unknown-splitting', 'env A=1 touch $X', '?'],
  ['unknown-splitting', 'sed $X s/a/b/ f'],
  ['unknown-splitting', "sed -i '' s/a/b/ $X"],
  [['unknown-splitting', 'sed-option'], 'sed -n -I x s/a/b/ $X'],
  ['unknown-splitting', 'perl --in-place $X'],
  ['pathname-expansion', 'touch *.log', '?'],
  ['pathname-expansion', 'rm {a,"b"}', '?'],
  ['pathname-expansion', 'rm {01..03}', '?'],
  ['pathname-expansion', 'rm {1..65}', '?'],
  ['pathname-expansion', 'rm {a,*}', '?'],
  ['pathname-expansion', 'X="*.log"; touch $X', '?'],
  ['positional-spread', 'touch "$@"', '?'],
  ['positional-spread', 'a=(x y); touch "${a[@]}"', '?'],
  ['positional-spread', 'touch "${@}"', '?'],
  ['positional-spread', 'touch "${@:2}"', '?'],
  [['positional-spread', 'unknown-splitting'], 'touch $*', '?'],
  ['positional-spread', 'a=(-i \'\' s/a/b/ f); sed "${a[@]}"'],
  ['positional-spread', 'a=(-o x f); sort "${a[@]}"'],
  ['positional-spread', 'a=(--pre x); rg "${a[@]}" y'],
  ['positional-spread', 'a=(a x); uniq "${a[@]}"'],
  ['positional-spread', 'a=(--output=x); git diff "${a[@]}"'],
  [['redirect-target', 'unknown-splitting'], 'echo x > $X', '?'],
  ['redirect-target', 'X="a b"; echo x > $X', '@/a', '@/b'],
  [['executable-unknown', 'mutation-executable-unknown'], '$X touch'],
])
  held('fields', code, command, ...targets);

// ── Redirections ────────────────────────────────────────────────────────────

for (const [command, ...targets] of [
  ['echo x > a', '@/a'],
  ['echo x >> a', '@/a'],
  ['echo x >| a', '@/a'],
  ['echo x &> a', '@/a'],
  ['cat <> a', '@/a'],
  ['> a', '@/a'],
  ['{ echo; } > a', '@/a'],
  ['(echo) > a', '@/a'],
  ['while read -r x; do :; done > a', '@/a'],
  ['f() { echo; }; f > a', '@/a'],
  ['echo x > a 2>&1', '@/a'],
  ['exec > a', '@/a'],
  ['exec 3>&1'],
  ['cat < a'],
  ['cat < "$X"'],
  ['cat < <(touch a)', '@/a'],
  ['cat <<< "$(touch a)"', '@/a'],
  ['cat <<EOF\n$(touch a)\nEOF', '@/a'],
  ["cat <<'EOF'\n$(touch a)\nEOF"],
  ['D=@/a; echo x > "$D/o"', '@/a/o'],
])
  writes('redirections', command, ...targets);
for (const [code, command, ...targets] of [
  ['redirect-target', 'echo x > "$X"', '?'],
  ['redirect-target', 'cat <> "$X"', '?'],
  ['redirect-variable', 'exec {fd}> a'],
  ['redirect-descriptor', 'echo x >&"$X"'],
  ['repository-mapping-write', 'echo x > .git', '@/.git'],
  ['repository-mapping-write', 'echo x > .GIT', '@/.GIT'],
  ['repository-mapping-write', 'echo x > .git/HEAD', '@/.git/HEAD'],
])
  held('redirections', code, command, ...targets);

// ── Environment ─────────────────────────────────────────────────────────────

for (const command of [
  'IFS= read -r x',
  'IFS=, ls',
  'CDPATH=x ls',
  'BASH_ENV=x ls',
  'PATH=/x ls',
  'HOME=@/s1 ls',
  'LANG=C sort a',
  'LC_ALL=C grep x a',
  'NODE_ENV=test npx jest',
  'PYTHONPATH=. make',
  'DYLD_X=1 ls',
  'export PATH=/x; ls',
  'FOO=bar',
])
  add('environment', command);
for (const command of [
  'IFS=,; ls',
  'CDPATH=x; ls',
  'ENV=x; ls',
  'GLOBIGNORE=x; ls',
  'POSIXLY_CORRECT=1; ls',
  'SHELLOPTS=x; ls',
  'BASH_ENV=x; ls',
  'export IFS=,',
  'IFS=, cd s1',
  'CDPATH=x cd s1',
  'f() { :; }; IFS=, f',
  'f() { :; }; CDPATH=x f',
  'X=1; ((IFS = 1)); echo $X',
  'echo $((IFS = 1))',
  ': "${CDPATH:=x}"',
])
  held('environment', 'environment-change', command);
// Each directory change reads the HOME its own command sees.
for (const [command, ...targets] of [
  ['HOME=@/s1 cd; touch o', '@/o', '@/s1/o'],
  ['HOME=@/s1 cd && touch o', '@/s1/o'],
  ['HOME=@/s1 "cd" && touch o', '@/s1/o'],
  ['HOME=@/s1 command cd && touch o', '@/s1/o'],
  ['HOME=@/s1 env cd && touch o', '@/o'],
  ['HOME=@/s1 ls; cd && touch o', '~/o'],
])
  writes('environment', command, ...targets);
held('environment', 'cwd-unresolved', 'HOME="$X" cd && touch o', '@/o');
for (const [command, program] of [
  ['IFS=, eval x', 'mutation-shell-builtin'],
  ['IFS=, builtin x', 'mutation-shell-builtin'],
  ["IFS=, bash -c ':'", 'mutation-shell-environment'],
  ["IFS=, sh -c ':'", 'mutation-shell-dialect'],
])
  held('environment', ['environment-change', program], command);
for (const name of ['source', '.', 'command', 'env', 'exec', 'pushd', 'set', 'export', 'local'])
  held('environment', 'environment-change', `IFS=, ${name} x`);
add('environment', 'rg x', { environment: { RIPGREP_CONFIG_PATH: '/x' } });
add('environment', 'ls', { environment: { 'BASH_FUNC_unrelated%%': '() { :; }' } });
for (const [name, value] of [
  ['BASH_FUNC_git%%', '() { :; }'],
  ['BASH_ENV', '/x'],
  ['CDPATH', '/x'],
])
  add('environment', 'ls', {
    label: `ls with inherited ${name}`,
    environment: { [name]: value },
    codes: ['inherited-environment'],
  });
add('environment', 'touch ~/a "$HOME/b"', {
  environment: { HOME: 'relative' },
  targets: ['?', '?'],
});

// ── Builtins ────────────────────────────────────────────────────────────────

for (const command of [
  'set -e; set -euo pipefail; set +x; set -- a b; set -; set -o; set a',
  'set -o noclobber -o errexit',
  'set',
  'shopt -s nullglob globstar; shopt -u dotglob; shopt',
  'trap - EXIT; trap "" INT; trap; trap -p; trap -l',
  'hash -r; hash',
  'export; export -p; export A B',
  'declare -x A; declare -ra A; typeset -A B; local -r C; readonly D',
  'unset A; unset -v A B',
  'type x; wait; jobs; kill -9 1; umask 022; shift 2; times; ulimit -n',
  'mapfile; mapfile -t; readarray -t lines',
  'command -v x; command -V x; env; exec',
  'printf "%s\\n" a; printf -- "%d" 1; printf "%%n"; printf "%5.2f" 1',
  'read; read -r a b; read -p prompt x; read -a list',
  'test -f a; [ -f a ]; true; false; :; pwd; echo a',
])
  add('builtins', command);
for (const command of [
  'set -o posix',
  'set -k',
  'set -o "$X"',
  'shopt -s expand_aliases',
  'shopt "$X"',
  'trap "touch a" EXIT',
  'trap "$X" EXIT',
  'hash -p /x ls',
  'export -f f',
  'export -n A',
  'export "$X"',
  'declare -i A',
  'declare -n A',
  'declare -f',
  'declare "$X"',
  'readonly IFS',
  'unset IFS',
  'unset "$X"',
  'unset -f f',
  'unset A B-C',
  'mapfile -C cb lines',
  'mapfile "$X"',
  'source',
  'source "$X"',
  'source -p x',
  'eval ls',
  'alias x=y',
  'let x=1',
  'builtin cd s1',
  'getopts a x',
])
  held('builtins', 'mutation-shell-builtin', command);
for (const command of [
  'printf "%n" A',
  'printf "%5n" A',
  'printf -v "$X" a',
  'printf -vA a',
  'printf -v IFS a',
  'printf -v a-b x',
])
  held('builtins', 'printf-format', command);
held('builtins', 'read-options', 'read IFS');
add('builtins', 'alias x=y; touch a', { codes: ['mutation-shell-builtin'], targets: ['@/a'] });

// ── Wrappers ────────────────────────────────────────────────────────────────

writes('wrappers', 'command touch a', '@/a');
writes('wrappers', 'command -- touch a', '@/a');
writes('wrappers', 'env A=1 B=2 touch a', '@/a');
writes('wrappers', 'exec touch a', '@/a');
writes('wrappers', 'command env exec touch a', '@/a');
writes('wrappers', 'command cd s1 && touch o', '@/s1/o');
writes('wrappers', '/usr/bin/env touch a', '@/a');
metadata('wrappers', 'env A=1 git add a', 'add @');
metadata('wrappers', 'command git add a', 'add @');
for (const command of ['env -i ls', 'exec -a x ls', 'env -u A ls', 'env 9A=x ls', 'command -p ls'])
  held('wrappers', ['mutation-wrapper-option', 'wrapper-option'], command);
held('wrappers', ['mutation-executable-unknown', 'executable-unknown'], 'env A=1');
held('wrappers', 'git-environment', 'env GIT_PAGER=evil git log');
add('wrappers', 'env GIT_PAGER=cat git log');

// ── Git routing and environment ─────────────────────────────────────────────

for (const [command, ...git] of [
  ['git add a', 'add @'],
  ['git -C s1 add a', 'add @/s1'],
  ['git -Cs1 add a', 'add @/s1'],
  ['git -C s1 -C ../s2 add a', 'add @/s2'],
  ['git -C @/s1 add a', 'add @/s1'],
  ['git -C "" add a', 'add @'],
  ['cd s1 && git add a', 'add @/s1'],
  ['cd "$X" && git -C @/s1 add a', 'add @/s1'],
  ['git --git-dir=@/meta add a', 'add @ in @/meta'],
  ['git --git-dir @/meta add a', 'add @ in @/meta'],
  ['git --work-tree=@/s1 add a', 'add @/s1 in @/.git'],
  ['GIT_DIR=@/meta git add a', 'add @ in @/meta'],
  ['GIT_DIR=meta git add a', 'add @ in @/meta'],
  ['GIT_WORK_TREE=@/s1 git add a', 'add @/s1 in @/.git'],
  ['GIT_COMMON_DIR=@/meta git add a', 'add @'],
  ['GIT_AUTHOR_NAME=x GIT_TERMINAL_PROMPT=0 git commit -m a', 'commit @'],
  ['GIT_EDITOR=true git rebase --continue', 'rebase @'],
  ['GIT_SEQUENCE_EDITOR=: git rebase --continue', 'rebase @'],
  ['git --no-pager -c color.ui=false add a', 'add @'],
  ['git -ccolor.ui=false add a', 'add @'],
  ['git -P --no-advice --icase-pathspecs add a', 'add @'],
  ['git add "$X"', 'add @'],
  ['git frobnicate', 'frobnicate @'],
  ['env FOO=1 git add a', 'add @'],
  ['env GIT_DIR=@/meta git add a', 'add @ in @/meta'],
])
  metadata('git routing', command, ...git);
for (const command of [
  'git',
  'git --version',
  'git -v',
  'git --exec-path',
  'git --help commit',
  'git -C "$X" log',
  'GIT_PAGER=cat PAGER= git log',
  'GIT_OPTIONAL_LOCKS=0 git status',
])
  add('git routing', command);
for (const command of [
  'git -C "$X" add a',
  'git -C missing add a',
  'cd "$X" && git add a',
  'cd "$X" && git -C s1 add a',
  'git --git-dir "$X" add a',
  'GIT_DIR=missing git add a',
  'GIT_INDEX_FILE=@/s1 git add a',
  'GIT_COMMON_DIR=meta git add a',
  'ln -s x .git; git add a',
  'mv s1/.git s2; git add a',
  'rm -r .; git add a',
  'mv ../project s9; git add a',
  'ln -s "$X" y; git add a',
  'touch "$X"; git add a',
  'caws worktree merge x; git add a',
  'caws worktree "$X"; git add a',
  '(ln -s x .git); git add a',
  '(ln -s x .git; exit 0); git add a',
  'x=$(ln -s x .git); git add a',
  'x=$(ln -s x .git; exit); git add a',
  'ln -s x .git | cat; git add a',
  '{ ln -s x .git; exit; } | cat; git add a',
  'ln -s x .git & git add a',
  '{ ln -s x .git; exit; } & git add a',
  'coproc ln -s x .git; git add a',
  'coproc { ln -s x .git; exit; }; git add a',
  'while read -r x; do ln -s x .git; done; git add a',
  'if x; then ln -s x .git; fi; git add a',
  'f() { ln -s x .git; }; f; git add a',
  'echo "$(ln -s x .git)"; git add a',
  'A=$(ln -s x .git) ls; git add a',
  'export A=$(ln -s x .git); git add a',
])
  add('git routing', command, { codes: ['metadata-coordinate-unresolved'], only: 'codes' });
for (const command of [
  'mkdir x; git add a',
  'rm -rf s1; git add a',
  'mv s1 s9; git add a',
  'ln -s x y; git add a',
  'npm "$X"; git add a',
  'caws status; git add a',
  'caws worktree list; git add a',
  '(touch a); git add a',
  'touch .gitignore; git add a',
  'echo x > s1/.gitignore; git add a',
])
  add('git routing', command, { git: ['add @'], only: 'git' });
add('git routing', 'git add a | ln -s x .git', { codes: ['git-context-changed'], git: ['add @'] });
add('git routing', 'ln -s x .git | git add a', { codes: ['git-context-changed'], git: ['add @'] });
metadata('git routing', 'git add a | cat', 'add @');
held('git routing', 'git-unknown-argument', 'git "$X" a');
held('git routing', 'git-unknown-argument', 'git --no-pager "$X" a');
held('git routing', 'git-unknown-argument', 'git --git-dir="$X" add a');
for (const command of [
  'git -c core.pager=x log',
  'git -ccore.pager=x log',
  'git -c "$X" log',
  'git -c alias.x=y x',
  'git --config-env=a=b log',
  'git --exec-path=/x log',
  'git --namespace=x log',
])
  held('git routing', 'git-global-option', command);
for (const command of [
  'GIT_PAGER=less git log',
  'PAGER=less git log',
  'GIT_PAGER="$X" git log',
  'GIT_SSH_COMMAND=x git ls-remote',
  'GIT_SSH_COMMAND="ssh -o ProxyCommand=x" git ls-remote',
  'GIT_SSH_COMMAND="ssh -o ServerAliveInterval=15 -o ProxyCommand=x" git ls-remote',
  'GIT_SSH_COMMAND="ssh -F x" git ls-remote',
  'GIT_SSH_COMMAND="ssh -o BatchMode=yes; x" git ls-remote',
  'GIT_SSH_COMMAND="./ssh -v" git ls-remote',
  'GIT_SSH_COMMAND="$X" git ls-remote',
  'GIT_EDITOR=vi git log',
  'GIT_EXTERNAL_DIFF=x git diff',
  'GIT_DIR="$X" git log',
])
  add('git routing', command, { codes: ['git-environment'], only: 'codes' });
const KEEPALIVE = 'ssh -o ServerAliveInterval=15 -o ServerAliveCountMax=120';
metadata('git routing', `GIT_SSH_COMMAND="${KEEPALIVE}" git push origin main`, 'push @');
metadata('git routing', `git -c core.sshCommand="${KEEPALIVE}" push origin main`, 'push @');
add('git routing', 'GIT_SSH_COMMAND="ssh -4 -v -oConnectTimeout=5" git ls-remote');
held('git routing', 'git-global-option', 'git -c core.sshCommand="ssh -o ProxyCommand=x" log');
add('git routing', 'git log', {
  label: 'git log with an inherited pager',
  environment: { GIT_PAGER: 'less' },
});
add('git routing', 'GIT_PAGER=other git log', {
  environment: { GIT_PAGER: 'less' },
  codes: ['git-environment'],
});
// A variable the command unsets is absent, wherever it came from.
for (const [command, ...git] of [
  ['unset GIT_EDITOR PAGER; git status'],
  ['GIT_EXTERNAL_DIFF=x; unset GIT_EXTERNAL_DIFF; git diff'],
  ['unset -v GIT_DIR; git add a', 'add @'],
  ['GIT_DIR=^/x/.git; unset GIT_DIR; git add a', 'add @'],
  ['export GIT_DIR=^/x/.git; unset GIT_DIR GIT_WORK_TREE; git add a', 'add @'],
  ['unset GIT_DIR; GIT_DIR=@/meta git add a', 'add @ in @/meta'],
])
  metadata('git environment', command, ...git);
writes(
  'git environment',
  'GIT_EXTERNAL_DIFF=x; unset GIT_EXTERNAL_DIFF 2>/dev/null; git diff',
  '/dev/null'
);
add('git environment', 'unset GIT_DIR; git add a', {
  label: 'an inherited variable is unset',
  environment: { GIT_DIR: '/usr' },
  git: ['add @'],
});
add('git environment', 'unset GIT_CONFIG_PARAMETERS; git status', {
  environment: { GIT_CONFIG_PARAMETERS: "'a.b'='c'" },
});
add('git environment', '(unset GIT_DIR); git add a', {
  label: 'a subshell unsets its own copy',
  environment: { GIT_DIR: '/usr' },
  git: ['add @ in /usr'],
});
// It may not have been unset, or a nested shell may not have seen it.
for (const command of [
  'GIT_EXTERNAL_DIFF=x; if y; then unset GIT_EXTERNAL_DIFF; fi; git diff',
  'GIT_EXTERNAL_DIFF=x; y && unset GIT_EXTERNAL_DIFF; git diff',
  'readonly GIT_EXTERNAL_DIFF=x; unset GIT_EXTERNAL_DIFF; git diff',
  'GIT_EXTERNAL_DIFF=x; readonly GIT_EXTERNAL_DIFF; unset GIT_EXTERNAL_DIFF; git diff',
  'f() { unset GIT_EXTERNAL_DIFF; }; GIT_EXTERNAL_DIFF=x; f; git diff',
  'f() { local GIT_EXTERNAL_DIFF; unset GIT_EXTERNAL_DIFF; }; GIT_EXTERNAL_DIFF=x; f; git diff',
  'GIT_EXTERNAL_DIFF=x; while y; do unset GIT_EXTERNAL_DIFF; done; git diff',
  'GIT_EXTERNAL_DIFF=x; unset GIT_EXTERNAL_DIFF > log; git diff',
  'GIT_EXTERNAL_DIFF=x; unset GIT_EXTERNAL_DIFF 2>&5; git diff',
  // Quoting, a wrapper or an expansion names the same builtin and variable.
  'GIT_EXTERNAL_DIFF=x; readonly "GIT_EXTERNAL_DIFF"; unset GIT_EXTERNAL_DIFF; git diff',
  'GIT_EXTERNAL_DIFF=x; command readonly GIT_EXTERNAL_DIFF; unset GIT_EXTERNAL_DIFF; git diff',
  'GIT_EXTERNAL_DIFF=x; command -- readonly GIT_EXTERNAL_DIFF; unset GIT_EXTERNAL_DIFF; git diff',
  'GIT_EXTERNAL_DIFF=x; N=GIT_EXTERNAL_DIFF; readonly $N; unset GIT_EXTERNAL_DIFF; git diff',
  'GIT_EXTERNAL_DIFF=x; F=-r; declare $F GIT_EXTERNAL_DIFF; unset GIT_EXTERNAL_DIFF; git diff',
  // Bash uncovers the variable an inner scope hid.
  'GIT_EXTERNAL_DIFF=x; f() { unset GIT_EXTERNAL_DIFF; git diff; }; GIT_EXTERNAL_DIFF=y f',
  'f() { local GIT_EXTERNAL_DIFF=y; g; }; g() { unset GIT_EXTERNAL_DIFF; git diff; }; GIT_EXTERNAL_DIFF=x; f',
  'f() { (unset GIT_EXTERNAL_DIFF; git diff); }; GIT_EXTERNAL_DIFF=x; GIT_EXTERNAL_DIFF=y f',
  'GIT_EXTERNAL_DIFF=x; GIT_EXTERNAL_DIFF=y unset GIT_EXTERNAL_DIFF; git diff',
  'GIT_EXTERNAL_DIFF=x; unset GIT_EXTERNAL_DIFF; read -r GIT_EXTERNAL_DIFF; git diff',
])
  add('git environment', command, { codes: ['git-environment'], only: 'codes' });
add('git environment', "unset GIT_DIR; bash -c 'git add a'", {
  label: 'a nested shell after an inherited variable is unset',
  environment: { GIT_DIR: '/usr' },
  codes: ['mutation-shell-environment', 'metadata-coordinate-unresolved'],
  only: 'codes',
});
metadata('git environment', "unset GIT_DIR; bash -c 'git add a'", 'add @');

// ── Git configuration ───────────────────────────────────────────────────────

for (const setting of [
  'color.ui=always',
  'user.name=x',
  'user.email=x',
  'core.quotepath=off',
  'core.pager=cat',
  'core.pager=',
  'core.editor=true',
  'core.fsmonitor=false',
  'pager.log=false',
  'credential.helper=',
  'diff.renames=copies',
  'commit.gpgsign=false',
  'advice.detachedHead=false',
  'safe.directory=/x',
  'http.lowSpeedLimit=1',
  'push.default=current',
  'init.defaultBranch=main',
])
  add('git configuration', `git -c ${setting} log`);
for (const setting of [
  'core.editor=vi',
  'core.fsmonitor=/x',
  'core.hooksPath=/x',
  // Turning a repository's hooks off selects what runs as much as another path.
  'core.hooksPath=/dev/null',
  'core.hooksPath=',
  'core.sshCommand=x',
  'core.bare=true',
  'core.worktree=/x',
  'pager.log=less',
  'credential.helper=x',
  'diff.external=x',
  'diff.x.command=y',
  'gpg.program=x',
  'filter.x.clean=y',
  'url.x.insteadOf=y',
  'include.path=x',
  'submodule.x.update=!y',
  'xuser.name=x',
  'user.namex=x',
  'http.proxy=x',
])
  held('git configuration', 'git-global-option', `git -c ${setting} log`);

// ── Git effects ─────────────────────────────────────────────────────────────

for (const command of [
  'annotate f',
  'archive HEAD',
  'bisect log',
  'bisect terms',
  'blame f',
  'branch',
  'branch -a',
  'branch -vv',
  'branch --show-current',
  'branch --list x',
  'branch -l x',
  'branch --contains HEAD',
  'branch --merged',
  'branch --no-merged=main x',
  'branch --sort=-committerdate',
  'bundle verify x',
  'bundle list-heads x',
  'cat-file -p HEAD',
  'check-ignore f',
  'cherry main',
  'commit-tree HEAD',
  'config --get a.b',
  'config --get-all a.b',
  'config -l',
  'config --list',
  'config a.b',
  'config get a.b',
  'config list',
  'config --global a.b',
  'config --global --get a.b',
  'config --system --list',
  'config -f x a.b',
  'config -f x --get a.b',
  'config --file=x --list --show-origin',
  'config --type=bool --default false a.b',
  'describe --tags',
  'diff --stat',
  'diff --no-index a b',
  'for-each-ref',
  'fsck',
  'grep -n -e -O x',
  'grep -A1 O x',
  'grep -nfO x',
  'log --oneline -8',
  'log --grep --output=x',
  'log -S --output=x',
  'log --text',
  'log -- --output=x',
  'ls-files',
  'ls-remote',
  'merge-base a b',
  'merge-tree --write-tree a b',
  'notes',
  'notes list',
  'notes show',
  'reflog',
  'reflog show',
  'remote',
  'remote -v',
  'remote --verbose show origin',
  'remote show origin',
  'remote get-url origin',
  'rerere status',
  'rev-list --count HEAD',
  'rev-parse HEAD',
  'shortlog -sn',
  'show HEAD',
  'show --text',
  'sparse-checkout list',
  'stash list',
  'stash show -p',
  'status',
  'submodule',
  'submodule status',
  'symbolic-ref HEAD',
  'symbolic-ref --short HEAD',
  'tag',
  'tag -l',
  'tag -n1',
  'tag --list x',
  'tag -v x',
  'tag --contains HEAD',
  'var GIT_AUTHOR_IDENT',
  'worktree list',
  'write-tree',
])
  add('git inspections', 'git ' + command);
for (const command of [
  'add -A',
  'am x',
  'apply x',
  'bisect start',
  'branch x',
  'branch -d x',
  'branch -D x',
  'branch -rd x',
  'branch -m x y',
  'branch -u x',
  'branch -f x',
  'branch --delete x --list',
  'branch --edit-description',
  'branch --set-upstream-to=x',
  // Git accepts an abbreviation of any long option.
  'branch --unset-up',
  'branch --del x --list',
  'branch "$X"',
  'branch --list "$X"',
  'checkout x',
  'cherry-pick x',
  'commit -m --output=x',
  'commit --message --exec',
  'config a.b c',
  'config --unset a.b',
  'config --unset-all a.b',
  'config --add a.b c',
  'config --replace-all a.b c',
  'config --remove-section a',
  'config --rename-section a b',
  'config -e',
  'config --edit',
  'config "$X" y',
  'config --unset-a a.b',
  'config --remove-s a',
  'fetch',
  'gc',
  'merge x',
  'notes add x',
  'notes "$X"',
  // An option's own operand is not the action.
  'notes --ref list add -m x',
  'pull',
  'push',
  'rebase x',
  'reflog expire',
  'reflog delete x',
  'reflog "$X"',
  'remote add x y',
  'remote "$X"',
  'rerere clear',
  'reset x',
  'restore f',
  'revert x',
  'sparse-checkout set x',
  'stash',
  'stash push -m --output=x',
  'stash pop',
  'stash "$X"',
  'stash -m list',
  'submodule update',
  'switch x',
  'symbolic-ref HEAD x',
  'symbolic-ref -d HEAD',
  'symbolic-ref -qd HEAD',
  'tag x',
  'tag -d x',
  'tag -a x',
  'tag -f x',
  'tag --delete x -l',
  'tag -m --output=x y',
  'tag "$X"',
  'update-index x',
  'update-ref x y',
  'worktree "$X"',
  'bundle unbundle x',
  'constructor',
])
  metadata('git writes', 'git ' + command, command.split(' ', 1)[0] + ' @');
// A path Git is given to write is a target, beside the metadata it changes.
for (const [command, git, ...targets] of [
  ['mv a b', 'mv @', '@/a', '@/b'],
  ['mv -k a b s1', 'mv @', '@/a', '@/b', '@/s1'],
  ['rm f', 'rm @', '@/f'],
  ['rm -r -- -f', 'rm @', '@/-f'],
  ['rm --cached f', 'rm @'],
  ['-C s1 rm f', 'rm @/s1', '@/s1/f'],
  ['-C s1 mv a ^/b', 'mv @/s1', '@/s1/a', '^/b'],
  ['worktree add ^/x', 'worktree @', '^/x'],
  ['worktree add -b n x HEAD', 'worktree @', '@/x'],
  ['worktree add --reason r x', 'worktree @', '@/x'],
  ['worktree remove --force ^/x', 'worktree @', '^/x'],
  ['worktree move a b', 'worktree @', '@/a', '@/b'],
  ['worktree repair a', 'worktree @', '@/a'],
  ['worktree prune', 'worktree @'],
  ['worktree lock x', 'worktree @'],
  ['push ^/x HEAD', 'push @', '^/x'],
  ['push file://^/x HEAD', 'push @', '^/x'],
  ['push ./x HEAD', 'push @', '@/x'],
  ['push -o a ^/x', 'push @', '^/x'],
  ['push origin HEAD', 'push @'],
  ['push https://x/y', 'push @'],
  ['-C s1 restore f', 'restore @/s1', '@/s1/f'],
  ['-C s1 restore -s HEAD f', 'restore @/s1', '@/s1/f'],
  ['-C s1 restore --staged f', 'restore @/s1'],
  ['-C s1 restore -S -W f', 'restore @/s1', '@/s1/f'],
  ['-C s1 checkout x -- f', 'checkout @/s1', '@/s1/f'],
  ['-C s1 checkout x', 'checkout @/s1'],
  ['-C s1 clean -fd -e k x', 'clean @/s1', '@/s1/x'],
  ['checkout -- f', 'checkout @'],
  ['restore f', 'restore @'],
])
  add('git targets', 'git ' + command, { git: [git], targets });
for (const [command, ...targets] of [
  ['clone ^/x', '@/clone'],
  ['clone ^/x y', '@/y'],
  ['clone -b main --depth 1 ^/x ^/y', '^/y'],
  ['clone --no-checkout ^/x', '@/clone'],
  ['-C s1 clone ^/x y', '@/s1/y'],
  ['init', '@/clone'],
  ['init x', '@/x'],
  ['init -b main x', '@/x'],
  ['merge-file a b c', '@/a'],
  ['merge-file -L x ^/a b c', '^/a'],
  ['merge-file -p a b c'],
])
  writes('git targets', 'git ' + command, ...targets);
for (const [command, ...targets] of [
  ['git rm "$X"', '?'],
  ['git clone ^/x "$X"', '?'],
  ['git worktree remove "$X"', '?'],
])
  add('git targets', command, { targets, only: 'targets' });
add('git targets', 'cd "$X"; git rm f', {
  codes: ['cwd-unresolved', 'metadata-coordinate-unresolved'],
  git: ['rm @'],
  targets: ['@/f'],
});
writes('git targets', 'cd "$X"; git clone ^/x ^/y', '^/y');
for (const command of [
  'diff --ext-diff',
  'diff --ext',
  'show --textconv',
  'show --textc',
  'grep -Ox y',
  'grep -nO y',
  'grep --open-files-in-pager y',
  'cat-file --filters x',
  'ls-remote --upload-pack=x y',
  'ls-remote --exec=x y',
  'ls-remote ext::x',
  'archive --exec=x',
])
  held('git hazards', 'git-execution', 'git ' + command);
for (const command of [
  'clone -c a=b /x',
  'clone -u x /x',
  'clone --config a=b /x',
  'clone --template=x /x',
  'clone --separate-git-dir=x /x',
  'init --template=x',
  'init --separate-git-dir=x',
  'rebase -ix y',
])
  add('git hazards', 'git ' + command, { codes: ['git-execution'], only: 'codes' });
for (const command of [
  'filter-branch x',
  'difftool',
  'mergetool',
  'send-email x',
  'bisect run x',
  'submodule foreach x',
  'fetch --upload-pack=x',
  'push --receive-pack=x',
  'fetch ext::x',
  'rebase -x y',
  'rebase --exec y',
])
  add('git hazards', 'git ' + command, { codes: ['git-execution'], only: 'codes' });
for (const command of [
  'diff --output=x',
  'diff --output x',
  'log --outp=x',
  'log -n --output=x --output=y',
  'archive -o x',
  'archive -ox',
  'bundle create x',
  'format-patch -o x',
  'format-patch --output-directory=x',
  'fast-export --export-marks=x',
  'checkout-index --prefix=x',
  'read-tree --prefix=x',
  'bugreport -ox',
  'diagnose -o x',
  'index-pack -o x',
  'archive -vo x',
  'format-patch -no x',
  'checkout-index -a --prefix x',
  'config --global a.b c',
  'config --system a.b c',
  'config -f x a.b c',
  'config --file=x a.b c',
  'config --file x --unset a.b',
])
  add('git hazards', 'git ' + command, { codes: ['git-option-unmodeled'], only: 'codes' });
// A commit that skips the repository's hooks is not the commit they admit.
for (const command of [
  'commit --no-verify -m x',
  'commit --no-ver -m x',
  'commit -n -m x',
  'commit -anm x',
  'merge --no-verify x',
  'push --no-verify',
  'rebase --no-verify x',
  'am --no-verify x',
  'am -n x',
  'cherry-pick --no-verify x',
  'revert --no-verify x',
  'pull --no-verify',
])
  add('git hazards', 'git ' + command, { codes: ['git-hooks'], only: 'codes' });
// One subcommand's effect is another's ordinary option or operand.
for (const command of [
  'log -o x',
  'log run',
  'show foreach',
  'diff create',
  'ls-files --prefix=x',
  'ls-files -x y',
  'diff -Oorder',
  'log -c',
  'log --filters',
  'archive --format=tar HEAD',
  'archive HEAD -- -o x',
  'grep --no-color x',
  'log -n 3',
  'cat-file --batch',
  'ls-remote --sort=ext::x',
])
  add('git hazards', 'git ' + command);
for (const command of [
  'add -u',
  'fetch -u',
  'rebase --onto x y',
  'read-tree -m x',
  'commit -F --output=x',
  'commit --file --exec=x',
  'commit -C --output=x',
  'commit -c --output=x',
  'commit --author --output=x',
  'commit --date --output=x',
  'commit --trailer --output=x',
  'tag --message --output=x y',
  'tag -F --output=x y',
  'tag --file --output=x y',
  'notes add -m --output=x',
  'notes add -F --output=x',
  'stash push --message --output=x',
  'merge -m --output=x y',
  'merge -F --output=x y',
  'branch -d --contains x',
  'branch -rD --list x',
  'tag -d -l x',
  'tag -am --list x',
  'commit -m --no-verify',
  'commit -amn',
  'commit -F n -S',
  'commit --no-edit',
  'merge -n x',
  'merge --no-verify-signatures x',
  'push -n',
  'revert -n x',
  'cherry-pick -n x',
  'rebase -n x',
])
  metadata('git hazards', 'git ' + command, command.split(' ', 1)[0] + ' @');
for (const command of ['notes get-ref', 'submodule summary', 'rerere diff', 'rerere remaining'])
  add('git hazards', 'git ' + command);
add('git hazards', 'git sparse-checkout check-rules');
add('git hazards', 'git rebase -xcommand', { codes: ['git-execution'], only: 'codes' });
add('git hazards', 'git fast-import --export-pack-edges=x', {
  codes: ['git-option-unmodeled'],
  only: 'codes',
});

// ── Readers ─────────────────────────────────────────────────────────────────

for (const command of [
  'grep -n -A 24 x a',
  'grep --include=x -r y .',
  'rg --json x',
  'rg -- --pre=x',
  'rg --pretty x',
  'sort a b',
  'sort -t, -k2,2n a',
  'sort -t o a',
  'sort -k 1o a',
  'sort -to a',
  'sort -- -o a',
  'sort -S 1M -T o a',
  'sort --reverse --key=1 a',
  'sort --ignore-nonprinting --version-sort a',
  'sort -t -o a',
  'sort -',
  'grep -o x a',
  'ls -o',
  'grep --pre=x y',
  'uniq',
  'uniq a',
  'uniq -c a',
  'uniq -f 1 a',
  'uniq -s 1 -w 2 a',
  'uniq -- a',
  'uniq -',
  'cat a; head -c 1 a; tail -n 1 a; wc -l a; ls -la; cut -c1 a; tr a b',
])
  add('readers', command);
for (const command of [
  'sort -o x a',
  'sort -uo x a',
  'sort -ox a',
  'sort --output=x a',
  'sort --ou x a',
  'sort -f -o x a',
  'sort -s -o x a',
  'sort -t, -o x a',
  'sort -k1 -o x a',
])
  held('readers', 'reader-option', command);
for (const command of [
  'sort --compress-program=x a',
  'sort --comp x a',
  'rg --pre x y',
  'rg --pre=x y',
  'rg --hostname-bin x y',
])
  held('readers', 'reader-execution', command);
for (const command of [
  'uniq a b',
  'uniq -- a b',
  'uniq -c a b',
  'uniq -f 1 a b',
  'uniq -f1 a b',
  'uniq - b',
  'uniq "$X" b',
  'uniq -- a -b',
])
  held('readers', 'reader-output', command);

// ── sed ─────────────────────────────────────────────────────────────────────

for (const script of [
  's/a/b/',
  's/a/b/g',
  's/a/b/2p',
  's|a|b|gI',
  's/[/]/x/',
  's/[]/]/x/',
  's/[^]/]/x/',
  's/a\\/b/c/',
  's/w/e/',
  'y/abc/xyz/',
  '1d',
  '$d',
  '1,5p',
  '1,+3p',
  '0~2p',
  '1!d',
  '/a/d',
  '/a/I,/b/Id',
  '\\|a|d',
  '/a/,$p',
  '/a/{s/b/c/;p;}',
  '/a/{p\n}',
  'p;p',
  '=',
  'n;N;g;G;h;H;x;D;P;z;F',
  'l 5',
  'L 5',
  'R file',
  's/a/[/',
  's/[[:space:]]*$//',
  's/a/b/;s/[^/]*$//',
  '\\,a,I p',
  'q',
  'q5',
  'Q 1',
  ':a;N;$!ba;s/\\n/ /g',
  't end;T end;b',
  'a\\\ntext w file\\\nmore\np',
  'a text e w',
  'i text',
  'c text',
  'r file',
  '# comment w x\np',
  'w /dev/stdout',
  's/a/b/w /dev/stderr',
  'v 4.2',
  '/a/ , /b/ p',
  '  p  ',
  '',
])
  add('sed', `sed '${script}' f`);
for (const script of [
  'w out',
  'W out',
  's/a/b/w out',
  's/a/b/gw out',
  '/a/w out',
  'p;w out',
  '/a/{w out\n}',
  's/[/]/x/;w out',
  's/[/b/;w out',
  's/a/[/w out',
  's/a/[/;w out;s/]/x/',
  's/[^]a]/b/;w out',
  'a\\\ntext\nw out',
  '1,3w out',
  '$!w out',
  'b end;w out',
])
  held('sed', 'sed-script-unsupported', `sed '${script}' f`);
for (const script of ['e', 'e ls', '1e ls', 's/a/b/e', 's/a/b/ge', 'p;e', '/a/{e ls\n}'])
  held('sed', 'sed-execution', `sed '${script}' f`);
for (const script of [
  'k',
  's/a/b',
  's',
  's/a/b/k',
  '/a',
  '1,k',
  'y/a/b',
  'pp',
  '\\',
  's\\a\\b\\',
  's\na\nb\n',
  '\\\\a\\d',
  '\\\na\nd',
  'p p',
  '1,',
  '1,/a',
  'y/a/b/w out',
])
  held('sed', 'sed-script-unsupported', `sed '${script}' f`);
for (const command of [
  'sed -n p f',
  'sed -nE p f',
  'sed -e p -e d f',
  'sed -ep f',
  'sed -ne p f',
  'sed --expression=p f',
  'sed --expression p f',
  'sed --quiet --regexp-extended p f',
  'sed -- p f',
  'sed -e p -- w',
  'sed p w e',
  'sed "$X" f',
  'sed -e "$X" f',
  'sed --',
])
  add('sed', command);
for (const command of [
  'sed -n - f',
  'sed -e "w out" f',
  'sed -e p -e "w out" f',
  'sed -ew f',
  'sed --expression="w out" f',
  'sed --expression "w out" f',
  'sed -- "w out" f',
  'sed -n "w out" f',
])
  held('sed', 'sed-script-unsupported', command);
for (const command of [
  'sed -f x f',
  'sed -ni p f',
  'sed --file=x p',
  'sed --unknown p f',
  'sed -Ei p f',
])
  held('sed', 'sed-option', command);
for (const command of [
  "sed -i '' p f",
  'sed -i.bak p f',
  'sed -i p f',
  'sed --in-place p f',
  'sed --in-place=.b p f',
])
  add('sed', command);
held('sed', 'sed-script-unsupported', "sed -i '' 'w out' f");
held('sed', 'sed-script-unsupported', "sed -i 'w out' f");

// ── Interpreters ────────────────────────────────────────────────────────────

for (const [command, ...run] of [
  ['python3 x.py', 'python:program:x.py:unresolved'],
  ['.venv/bin/python -u x.py -c y', 'python:program:x.py:unresolved'],
  ['python3 -- x.py', 'python:program:x.py:unresolved'],
  ['python3 -m pytest -c y', 'python:program::unresolved'],
  ['python3 -mpytest', 'python:program::unresolved'],
  ['python3 -um pytest', 'python:program::unresolved'],
  ['python3 -V', 'python:program::unresolved'],
  ['python3 -VV', 'python:program::unresolved'],
  ['python3 -h', 'python:program::unresolved'],
  ['python3 --version', 'python:program::unresolved'],
  ['python3 --help-env', 'python:program::unresolved'],
  ['python3 -W ignore -X utf8 x.py', 'python:program:x.py:unresolved'],
  ['python3 -Wignore x.py', 'python:program:x.py:unresolved'],
  ['python3 -uW ignore x.py', 'python:program:x.py:unresolved'],
  ['python3 --check-hash-based-pycs never x.py', 'python:program:x.py:unresolved'],
  ['python3 --check-hash-based-pycs never -c 1', 'python:inline::unresolved'],
  // One unknown field names a program; nothing beside it is code.
  ['python3 "$X"', 'python:program::unresolved'],
  ['python3 "$X" --check out.txt -v', 'python:program::unresolved'],
  ['python3 -- "$X"', 'python:program::unresolved'],
  ['node "$X"', 'node:program::unresolved'],
  ['node --inspect "$X"', 'node:program::unresolved'],
  ['node -- "$X"', 'node:program::unresolved'],
  ['for f in *.py; do python3 "$f"; done', 'python:program::unresolved'],
  // Every field of a glob under a literal directory begins with that directory.
  ['python3 scripts/*.py', 'python:program::unresolved'],
  ['python3 -u ./*.py', 'python:program::unresolved'],
  ['python3 scripts/$X', 'python:program::unresolved'],
  ['python3 /x/*.py', 'python:program::unresolved'],
  ['node --check scripts/*.mjs', 'node:program::unresolved'],
  ['node scripts/*.mjs', 'node:program::unresolved'],
  ['python3 "scripts"/*.py', 'python:program::unresolved'],
  ['python3 .tools/*.py', 'python:program::unresolved'],
  ['python3 x{1,2}*.py', 'python:program::unresolved'],
  ['python3 scripts/*.py tests/*.py', 'python:program::unresolved'],
  ['node --test tests/unit/*.mjs tests/int/*.mjs', 'node:program::unresolved'],
  ['node --test --experimental-test-coverage tests/*.mjs', 'node:program::unresolved'],
  // The file that runs is the first in whichever order the locale sorts.
  ['python3 globs/*.py', 'python:program:globs/a.py:unresolved'],
  ['python3 ./globs/?.py', 'python:program:./globs/a.py:unresolved'],
  ['python3 globs/[!a]*.py', 'python:program:globs/b.py:unresolved'],
  [
    'cd globs; python3 ./b*',
    'python:program:./b.py:unresolved in @/globs',
    'python:program::unresolved',
  ],
  ['node globs/*.mjs', 'node:program:globs/c.mjs:unresolved'],
  ['python3 globs/none*.py', 'python:program::unresolved'],
  ['python3 globs/[z-a]*.py', 'python:program::unresolved'],
  [
    'python3 globs/mixed/*.py',
    'python:program:globs/mixed/B.py:unresolved',
    'python:program:globs/mixed/a.py:unresolved',
  ],
  ["python3 /dev/stdin <<'EOF'\n1\nEOF", 'python:inline::unresolved'],
  ["node /dev/stdin <<'EOF'\n1\nEOF", 'node:inline::readonly'],
  ["node --input-type module - <<'EOF'\n1\nEOF", 'node:inline::readonly'],
  ['node --import tsx x -e 1', 'node:program:x:unresolved'],
  ["node x.js <<'EOF'\n1\nEOF", 'node:program:x.js:unresolved'],
  ['python3 -c 1', 'python:inline::unresolved'],
  ['python3 -c1', 'python:inline::unresolved'],
  ['python3 -Bc 1', 'python:inline::unresolved'],
  ['python3 -Im pip', 'python:program::unresolved'],
  ['python3 -W ignore -c 1', 'python:inline::unresolved'],
  ["python3 - <<'EOF'\n1\nEOF", 'python:inline::unresolved'],
  ["python3 <<'EOF'\n1\nEOF", 'python:inline::unresolved'],
  ["python3 -- <<'EOF'\n1\nEOF", 'python:inline::unresolved'],
  ["python3 -- - <<'EOF'\n1\nEOF", 'python:inline::unresolved'],
  ['node x.js', 'node:program:x.js:unresolved'],
  ['node -- x.js', 'node:program:x.js:unresolved'],
  ['node x.js -e y', 'node:program:x.js:unresolved'],
  ['node x.js "$X"', 'node:program:x.js:unresolved'],
  ['node --version', 'node:program::unresolved'],
  ['node -v', 'node:program::unresolved'],
  ['node -h', 'node:program::unresolved'],
  ['node --test', 'node:program::unresolved'],
  ['node --test tests/', 'node:program:tests/:unresolved'],
  ['node --check x.mjs', 'node:program:x.mjs:unresolved'],
  ['node --run build', 'node:program:build:unresolved'],
  ['node --run=build', 'node:program::unresolved'],
  ['node --max-old-space-size=4096 x.mjs', 'node:program:x.mjs:unresolved'],
  ['node --import tsx x.ts', 'node:program:x.ts:unresolved'],
  ['node -r dotenv/config x.cjs "$X"', 'node:program:x.cjs:unresolved'],
  ['node --require dotenv/config run', 'node:program:run:unresolved'],
  ['node --foo run', 'node:program::unresolved'],
  ['node --enable-source-maps -- x.js', 'node:program:x.js:unresolved'],
  ['node --no-warnings x.js', 'node:program:x.js:unresolved'],
  ['node -e 1', 'node:inline::readonly'],
  ['node -pe 1', 'node:inline::readonly'],
  ['node -p 1 x "$X"', 'node:inline::readonly'],
  ['node --eval=1', 'node:inline::readonly'],
  ["node - x <<'EOF'\n1\nEOF", 'node:inline::readonly'],
  ["node -- - <<'EOF'\n1\nEOF", 'node:inline::readonly'],
  ['nodejs x.js', 'node:program:x.js:unresolved'],
  ['FOO=1 node -e 1', 'node:inline::readonly'],
  ['env FOO=1 node -e 1', 'node:inline::readonly'],
  ['NODE_OPTIONS=x node x.js', 'node:program:x.js:unresolved'],
  ['export PYTHONPATH=.; python3 x.py', 'python:program:x.py:unresolved'],
  ['PYTHONPATH=. python3 x.py', 'python:program:x.py:unresolved'],
])
  launches('interpreters', command, ...run);
for (const [code, command, ...run] of [
  ['mutation-code-source', 'python3 $X'],
  // Not a literal directory: an option, another program's text, or nothing.
  ['mutation-code-source', 'python3 *.py'],
  ['mutation-code-source', 'python3 ?.py'],
  ['mutation-code-source', 'python3 [a-z]*.py'],
  ['mutation-code-source', 'python3 $D/*.py'],
  ['mutation-code-source', 'python3 ""*.py'],
  ['mutation-code-source', "python3 '-c'*"],
  ['mutation-code-source', 'python3 scripts/*.py $X'],
  ['mutation-code-source', 'python3 scripts/*.py *.txt'],
  ['mutation-code-source', 'python3 -W $(ls) x.py'],
  ['mutation-code-source', 'python3 -X $(ls) x.py'],
  // The shell reads the home directory from a variable, so it can be anything.
  ['mutation-code-source', "HOME='-cprint(1)#'; python3 ~/*.py"],
  ['mutation-code-source', 'python3 ~/x/*.py --check'],
  ['mutation-code-source', 'python3 //dev/fd/*'],
  ['mutation-code-source', 'python3 /./dev/fd/*'],
  ['mutation-code-source', 'python3 /d?v/stdin'],
  ['mutation-code-source', 'python3 /*/stdin'],
  ['mutation-code-source', 'python3 "$D"/*.py'],
  ['mutation-code-source', 'python3 $(ls)'],
  ['mutation-code-source', 'python3 {-c,1}*'],
  ['mutation-code-source', 'python3 /dev/fd/*'],
  ['mutation-code-source', 'python3 /proc/self/fd/*'],
  ['mutation-code-source', 'python3 scripts/*.py -c 1'],
  ['mutation-code-source', 'python3 scripts/*.py "$Y"'],
  ['mutation-code-source', "python3 scripts/*.py 'print(1)'"],
  ['mutation-code-source', "python3 scripts/*.py <<'EOF'\n1\nEOF"],
  ['mutation-code-source', 'shopt -s nullglob; python3 scripts/*.py'],
  ['mutation-code-source', 'setopt null_glob; python3 scripts/*.py'],
  ['mutation-code-source', 'setopt NULL_GLOB; python3 scripts/*.py'],
  ['mutation-code-source', 'node --foo scripts/$X'],
  ['mutation-code-source', 'python3 "$X" -c 1'],
  ['mutation-code-source', 'python3 "$X" "print(1)"'],
  ['mutation-code-source', 'python3 "$X" "$Y"'],
  ['mutation-code-source', 'python3 "$@"'],
  ['mutation-code-source', 'a=(-c 1); python3 "${a[@]}"'],
  ['mutation-code-source', 'python3 "$X" <<\'EOF\'\n1\nEOF'],
  ['mutation-code-source', 'python3 <(echo 1)'],
  ['mutation-code-source', 'python3 /dev/fd/3'],
  ['mutation-code-source', 'python3 -c "$X"'],
  ['mutation-code-source', 'python3 -c'],
  ['mutation-interpreter-option', 'python3 -i -c 1'],
  ['mutation-interpreter-option', 'python3 --unknown -c 1'],
  ['mutation-interpreter-option', "python3 --unknown - <<'EOF'\n1\nEOF"],
  ['mutation-code-source', 'node $X'],
  ['mutation-code-source', 'node "$X" -e 1'],
  ['mutation-code-source', 'node "$X" -pe 1'],
  ['mutation-code-source', 'node "$X" --eval=1'],
  ['mutation-code-source', 'node "$X" --print 1'],
  ['mutation-code-source', 'node <(echo 1)'],
  ['mutation-code-source', 'node --inspect <(echo 1)'],
  ['mutation-code-source', 'node -r $X y'],
  ['mutation-code-source', 'node -e "$X"'],
  ['mutation-code-source', 'node -e'],
  ['mutation-code-source', 'node -e 1 "$X"'],
  ['mutation-code-source', 'node --test "$X"'],
  ['mutation-interpreter-option', 'node --import tsx -e 1'],
  ['mutation-interpreter-option', 'node --import=tsx -e 1'],
  ['mutation-interpreter-option', "node --import tsx - <<'EOF'\n1\nEOF"],
  ['mutation-interpreter-option', "node -r x <<'EOF'\n1\nEOF"],
  ['mutation-interpreter-option', "node --input-type other - <<'EOF'\n1\nEOF"],
  ['mutation-interpreter-option', "node --foo x - <<'EOF'\n1\nEOF"],
  ['mutation-interpreter-option', "node --foo x <<'EOF'\n1\nEOF"],
  ['mutation-interpreter-option', 'node --foo x <<< 1'],
  ['mutation-interpreter-option', 'node -e 1 --test'],
  ['mutation-interpreter-option', "node --inspect - <<'EOF'\n1\nEOF"],
  ['mutation-interpreter-option', "node --inspect <<'EOF'\n1\nEOF"],
  ['mutation-interpreter-option', "node --inspect -- <<'EOF'\n1\nEOF"],
])
  add('interpreters', command, { codes: [code], run });
for (const [code, command, ...run] of [
  [
    ['mutation-interpreter-effects', 'mutation-interpreter-source'],
    'python3 < x',
    'python:inline::unresolved',
  ],
  [
    ['mutation-interpreter-effects', 'mutation-interpreter-source'],
    'cat x | python3 -',
    'python:inline::unresolved',
  ],
  ['mutation-interpreter-effects', 'NODE_OPTIONS=x node -e 1', 'node:inline::unresolved'],
  ['mutation-interpreter-effects', 'env NODE_OPTIONS=x node -e 1', 'node:inline::unresolved'],
  ['mutation-interpreter-effects', 'NODE_OPTIONS=x; node -e 1', 'node:inline::unresolved'],
  ['mutation-interpreter-effects', 'PYTHONPATH=x python3 -c 1', 'python:inline::unresolved'],
  ['mutation-interpreter-effects', 'PYTHONPATH=x; python3 -c 1', 'python:inline::unresolved'],
])
  add('interpreters', command, { codes: [].concat(code).sort(), run });
add('interpreters', 'python3 -c 1', {
  label: 'python3 with inherited startup',
  environment: { PYTHONPATH: '/x' },
  run: ['python:inline::unresolved'],
});

// ── Nested shells ───────────────────────────────────────────────────────────

for (const [command, ...targets] of [
  ["bash -c 'touch a'", '@/a'],
  ["bash -lc 'touch a'", '@/a'],
  ["bash -ec 'touch a'", '@/a'],
  ["bash -euo pipefail -c 'touch a'", '@/a'],
  ["bash -o errexit -c 'touch a'", '@/a'],
  ["bash +e -c 'touch a'", '@/a'],
  ["bash --norc --noprofile -c 'touch a'", '@/a'],
  ["bash --login -c 'touch a'", '@/a'],
  ["bash -c -- 'touch a'", '@/a'],
  ["bash -c -e 'touch a'", '@/a'],
  ["bash -c 'touch a' x y", '@/a'],
  ["bash -s <<'EOF'\ntouch a\nEOF", '@/a'],
  ["bash -s x y <<'EOF'\ntouch a\nEOF", '@/a'],
  ["bash - <<'EOF'\ntouch a\nEOF", '@/a'],
  ["bash <<'EOF'\ntouch a\nEOF", '@/a'],
  ["bash /dev/stdin <<'EOF'\ntouch a\nEOF", '@/a'],
  ['bash "$X"'],
  ['bash -x "$X"'],
  ['bash "$X" -v out.txt'],
  ['bash -n scripts/*.sh'],
  ['bash -n scripts/*.sh tests/*.sh'],
  ['bash -n .hooks/*.sh .githooks/*'],
  ['bash -n "scripts"/*.sh'],
  ["bash -n 'scripts/'*.sh"],
  ['sh -n scripts/*.sh'],
  ['bash scripts/*.sh --quick'],
  ['bash -O extglob x.sh'],
  ['bash x.sh'],
  ['bash ./x.sh -c y'],
  ['bash -x x.sh "$X"'],
  ['bash -n x.sh'],
  ['bash -- x.sh'],
  ['bash - x.sh'],
  ['bash -l x.sh'],
  ['bash --version'],
  ['bash --help'],
  ['sh x.sh'],
  ['sh -x x.sh'],
  ['sh -eu x.sh'],
  ["cd s1 && bash -c 'touch a'", '@/s1/a'],
  ["HOME=@/s1; bash -c 'touch ~/a'", '?'],
  ['TMPDIR=@/s1; bash -c \'touch "$TMPDIR/a"\'', '?'],
  ["bash -c 'touch ~/a'", '~/a'],
  ['D=@/s1; bash -c \'touch "$D/a"\'', '?'],
  ['bash -c \'bash -c "touch a"\'', '@/a'],
])
  writes('nested shells', command, ...targets);
for (const [code, command] of [
  ['mutation-code-source', 'bash -c "$X"'],
  ['mutation-code-source', 'bash -c'],
  ['mutation-code-source', 'bash $X'],
  ['mutation-code-source', 'bash *.sh'],
  ['mutation-code-source', "bash -o $(ls) 'touch a'"],
  ['mutation-code-source', 'bash $D/*.sh'],
  ['mutation-code-source', "bash scripts/*.sh 'touch a'"],
  ['mutation-code-source', "bash scripts/*.sh -c 'touch a'"],
  ['mutation-code-source', "bash scripts/*.sh <<'EOF'\ntouch a\nEOF"],
  ['mutation-code-source', 'shopt -s nullglob; bash scripts/*.sh'],
  ['mutation-code-source', 'bash "$X" \'touch a\''],
  ['mutation-code-source', 'bash "$X" <<\'EOF\'\ntouch a\nEOF'],
  ['mutation-code-source', 'bash "$@"'],
  ['mutation-code-source', "bash <(echo 'touch a')"],
  ['mutation-code-source', 'bash -O "$X"'],
  ['mutation-shell-builtin', "source <(echo 'touch a')"],
  ['mutation-shell-builtin', "source /dev/stdin <<'EOF'\ntouch a\nEOF"],
  ['mutation-shell-builtin', "source /dev/fd/0 <<'EOF'\ntouch a\nEOF"],
  ['mutation-interpreter-option', "bash -O extglob -c 'touch a'"],
  ['mutation-interpreter-option', "bash -Oc extglob 'touch a'"],
  ['mutation-interpreter-option', "bash +O extglob <<'EOF'\ntouch a\nEOF"],
  ['mutation-interpreter-option', "bash -i -c ':'"],
  ['mutation-interpreter-option', "bash -a -c ':'"],
  ['mutation-interpreter-option', "bash -p -c ':'"],
  ['mutation-interpreter-option', "bash -k -c ':'"],
  ['mutation-interpreter-option', "bash -o posix -c ':'"],
  ['mutation-interpreter-option', 'bash -o "$X" -c \':\''],
  ['mutation-interpreter-option', "bash --posix -c ':'"],
  ['mutation-interpreter-option', "bash --rcfile x -c ':'"],
  ['mutation-interpreter-option', "bash -p <<'EOF'\n:\nEOF"],
  ['mutation-shell-source', 'bash'],
  ['mutation-shell-source', 'bash -s'],
  ['mutation-shell-source', 'cat x | bash'],
  ['mutation-shell-source', 'bash < x'],
  ['mutation-shell-dialect', "sh -c ':'"],
  ['mutation-shell-dialect', 'cat x | sh'],
  ['mutation-shell-environment', "A=1 bash -c ':'"],
  ['mutation-shell-environment', "env A=1 bash -c ':'"],
  ['mutation-shell-environment', "A=1 bash <<'EOF'\n:\nEOF"],
])
  held('nested shells', code, command);
writes('nested shells', 'A=1 bash x.sh');
writes('nested shells', 'bash -p x.sh');
held('nested shells', ['mutation-code-source', 'mutation-shell-dialect'], 'sh -c "$X"');

// ── Functions ───────────────────────────────────────────────────────────────

const NOWHERE = 'cwd-unresolved';
for (const [command, ...targets] of [
  // A recursive call reaches what its body defines and what it has changed.
  ['f() { f() { touch @/a; }; f; }; f', '@/a'],
  ['f() { h; g() { h() { touch @/a; }; }; g; f; }; f', '@/a'],
  ['f() { a; b; b() { a() { touch @/a; }; }; f; }; f', '@/a'],
  ['f() { touch @/a; f; }; f', '@/a'],
  // A prefix assignment is visible inside the function and ends with it.
  ['f() { touch ~/o; }; HOME=@/s1 f', '@/s1/o'],
  ['f() { touch "$D/o"; }; D=@/a; D=@/b f', '@/b/o'],
  ['f() { :; }; D=@/a; D=@/b f; touch "$D/o"', '?'],
  // Returning uncovers the name a local declaration covered.
  ['f() { D=@/b; local D=@/a; }; D=@/a; f; touch "$D/o"', '?'],
  ['f() { local D=@/b; touch "$D/o"; }; f', '@/b/o'],
  ['f() { declare D; }; D=@/a; f; touch "$D/o"', '?'],
  ['f() { typeset -x D=@/b; }; D=@/a; f; touch "$D/o"', '?'],
  ['f() { D=@/b; }; D=@/a; f; touch "$D/o"', '@/a/o', '@/b/o'],
  // Assigning a read-only name fails and leaves what it held.
  ['readonly D=@/b\nD=@/a\ntouch "$D/o"', '?'],
  ['declare -r D=@/b\nD=@/a\ntouch "$D/o"', '?'],
  ['D=@/b; readonly D\nD=@/a\ntouch "$D/o"', '?'],
  ['readonly D=@/a; touch "$D/o"', '@/a/o'],
  ['readonly E=x; D=@/a; touch "$D/o"', '@/a/o'],
  // A failed redirection skips a body, and any exit it holds.
  ['{ exit 0; } > log; touch a', '@/a', '@/log'],
  ['for i in 1; do exit 0; done > log; touch a', '@/a', '@/log'],
  ['{ cd s1; } > log; touch a', '@/a', '@/s1/a', '@/log'],
  ['{ cd s1 && touch a; } > log', '@/s1/a', '@/log'],
  // Another program's name changes nothing in this shell.
  ['env cd s1 && touch a', '@/a'],
  ['/usr/bin/cd s1 && touch a', '@/a'],
  ['exec cd s1 && touch a', '@/a'],
  ['command cd s1 && touch a', '@/s1/a'],
  ['./export x'],
  ['bin/source x'],
  ['help() { touch a; }; help', '@/a'],
  // A directory this source makes is one it can change into.
  ['mkdir d && cd d && touch a', '@/d/a'],
  ['mkdir -p d/e && cd d/e && touch a', '@/d/e/a'],
  ['mkdir -p d/e && cd d && touch a', '@/d/a'],
  ['mkdir d && cd d && mkdir e && cd e && touch a', '@/d/e/a'],
  ['mkdir d; cd d; touch a', '@/a', '@/d/a'],
  // What a list skips has the status that skipped it.
  ['x && cd s1 && touch a', '@/s1/a'],
  ['x || cd s1 || touch a', '@/a'],
  ['x && cd s1 || touch a', '@/a'],
  ['x || cd s1 && touch a', '@/a', '@/s1/a'],
])
  writes('functions', command, ...targets);
for (const [code, command, ...targets] of [
  [NOWHERE, 'f() { touch a; cd s1 && f; }; f', '@/a', '@/s1/a'],
  ['function-shadow', 'cd() { :; }; cd s1'],
  [NOWHERE, 'f() { f() { touch a; }; f; }; f', '@/a'],
  [NOWHERE, 'f() { touch "$D/o"; [ "$D" = @/b ] && return; D=@/b; f; }; D=@/a; f', '?', '@/a/o'],
  [NOWHERE, 'f() { f; }; D=@/a; f; touch "$D/o"', '?', '@/a/o'],
  ['function-shadow', 'exit() { :; }'],
  ['function-shadow', 'command() { touch a; }; command x'],
  ['function-shadow', 'function return { :; }'],
  ['function-shadow', 'export() { :; }'],
  ['mutation-shell-builtin', 'f() { declare -g D=@/b; }; f'],
  // It may have become a link, or never have been made.
  [NOWHERE, 'mkdir d; rm -r d; ln -s ^/x d; cd d; touch a', '@/a', '@/d'],
  [NOWHERE, 'mkdir d; (rm -r d; ln -s ^/x d); cd d; touch a', '@/a', '@/d'],
  [NOWHERE, 'cd d; mkdir d; touch a', '@/a'],
  [NOWHERE, 'mkdir "$X"; cd d; touch a', '@/a'],
  [NOWHERE, 'mkdir d/../e; cd e; touch a', '@/a'],
  [NOWHERE, 'mkdir d; cd d/e; touch a', '@/a'],
  [NOWHERE, 'if x; then mkdir d; fi; cd d; touch a', '@/a', '@/d/a'],
  [NOWHERE, 'cd "$X"; perl -0pi -e s/a/b/ f'],
  [NOWHERE, 'cd "$X"; perl -l012i -e s/a/b/ f'],
  [NOWHERE, 'cd "$X"; touch -- -f'],
  [NOWHERE, 'cd "$X"; dd of=f'],
])
  held('functions', code, command, ...targets);
for (const command of [
  'cd "$X"; perl -pe s/a/b/ f',
  'cd "$X"; perl -ne print f',
  'cd "$X"; dd if=f of=/x',
  'cd "$X"; touch -c /x',
])
  add('functions', command, { codes: [], only: 'codes' });
// Text Bash would evaluate again is source, not data.
for (const [code, command] of [
  ['read-options', "read 'a[$(touch a)]' <<< x"],
  ['test-source', "[[ -v 'a[$(touch a)]' ]]"],
  ['test-source', "[[ 'a[$(touch a)]' -eq 0 ]]"],
  ['test-source', "test -v 'a[$(touch a)]'"],
  ['test-source', "[ -v 'a[`touch a`]' ]"],
  ['arithmetic-source', "X='a[$(touch a)]'; echo $((X))"],
  ['arithmetic-source', "X='a[$(touch a)]'; ((X++))"],
  ['parameter-operation', 'X=\'a[$(touch a)]\'; echo "${!X}"'],
  ['substitution-source', 'echo "${ touch a; }"'],
])
  add('functions', command, { codes: [code], only: 'codes' });
for (const command of [
  "[[ 'a[$x]' = y ]]",
  "[ 'a[$x]' = y ]",
  'X=3; echo $((X + 1))',
  "X='a[$(touch a)]'; ((X = 1))",
  'X=Y; echo "${!X}"',
  'printf "%s" x',
])
  add('functions', command);
writes('functions', 'printf "$O" x; D=@/a; touch "$D/o"', '@/a/o');
writes('functions', 'D=@/a; printf "$O" x; touch "$D/o"', '?');

// ── Programs ────────────────────────────────────────────────────────────────

// A program this command writes for itself is read like any other source.
const SCRIPT = (file, body, run) => `cat > ${file} <<'EOF'\n${body}\nEOF\n${run}`;
for (const [command, ...targets] of [
  [SCRIPT('x.sh', 'touch a', 'bash x.sh'), '@/x.sh', '@/a'],
  [SCRIPT('x.sh', 'touch a', 'sh x.sh'), '@/x.sh', '@/a'],
  [SCRIPT('x.sh', 'touch a', './x.sh'), '@/x.sh', '@/a'],
  [SCRIPT('x.sh', 'touch a', '. ./x.sh'), '@/x.sh', '@/a'],
  [SCRIPT('x.sh', '#!/bin/bash\ntouch a', 'chmod +x x.sh; @/x.sh'), '@/x.sh', '@/a'],
  [SCRIPT('x.sh', 'touch a', 'cd s1; bash ^/project/x.sh'), '@/x.sh', '@/a', '@/s1/a'],
  [SCRIPT('x.sh', 'touch a', 'for i in 1 2 3; do bash x.sh; done'), '@/x.sh', '@/a'],
  [`tee x.sh <<'EOF'\ntouch a\nEOF\nbash x.sh`, '@/x.sh', '@/a'],
  [`tee x.sh <<'EOF' > /dev/null\ntouch a\nEOF\nbash x.sh`, '@/x.sh', '/dev/null', '@/a'],
  [SCRIPT('x.sh', 'touch a', SCRIPT('x.sh', 'touch b', 'bash x.sh')), '@/x.sh', '@/a', '@/b'],
  // A name the projection cannot read can be any script this command wrote.
  [SCRIPT('x.sh', 'touch a', 'bash ./*.sh'), '@/x.sh', '@/a'],
  [SCRIPT('x', 'touch a', 'sh ./*'), '@/x', '@/a'],
  [SCRIPT('x.sh', 'touch a', 'for f in ./*.sh; do bash "$f"; done'), '@/x.sh', '@/a'],
  [SCRIPT('x.md', 'touch "$X"', 'bash ./*.sh'), '@/x.md'],
  [SCRIPT('x.sh', 'touch "$X"', 'bash --version'), '@/x.sh'],
  // A different file, or one in another language, is not shell source.
  [SCRIPT('x.sh', 'touch a', 'bash y.sh'), '@/x.sh'],
  [SCRIPT('x.rb', '#!/usr/bin/env ruby\nputs(', './x.rb'), '@/x.rb'],
  ['echo "touch a" > x.sh; bash x.sh', '@/x.sh'],
  [`bash x.sh; cat > x.sh <<'EOF'\ntouch a\nEOF`, '@/x.sh'],
])
  writes('submitted programs', command, ...targets);
for (const [command, payloads, rewritten] of [
  [SCRIPT('x.py', 'print(1)', 'python3 x.py'), ['print(1)\n'], false],
  [SCRIPT('x.py', 'print(1)', 'python3 ./s1/../x.py'), ['print(1)\n'], false],
  [SCRIPT('x.mjs', 'let a', 'node x.mjs'), ['let a\n'], false],
  [SCRIPT('x', '#!/usr/bin/env python3\n1', './x'), ['#!/usr/bin/env python3\n1\n'], false],
  [SCRIPT('x', '#!/usr/bin/env node\n1', './x'), ['#!/usr/bin/env node\n1\n'], false],
  [SCRIPT('x.py', '1', SCRIPT('x.py', '2', 'python3 x.py')), ['1\n', '2\n'], false],
  [`cat >> x.py <<'EOF'\n1\nEOF\npython3 x.py`, ['1\n'], true],
  [SCRIPT('x.py', '1', 'echo 2 >> x.py; python3 x.py'), ['1\n'], true],
  [`cat > x.py <<EOF\n$X\nEOF\npython3 x.py`, [], true],
  ['echo 1 > x.py; python3 x.py', [], true],
  ['echo 1 | tee x.py; python3 x.py', [], true],
  ['cp y.py x.py; python3 x.py', [], true],
  ['cp s1/x.py .; python3 x.py', [], true],
  ['echo 1 > y.py; python3 x.py', [], false],
  [SCRIPT('x.py', '1', 'python3 ./new*.py'), ['1\n'], false],
  [SCRIPT('x.py', '1', 'python3 "$f"'), ['1\n'], false],
  [SCRIPT('x.mjs', '1', 'node "$f"'), ['1\n'], false],
  [SCRIPT('x.py', '1', 'node "$f"'), [], false],
  [SCRIPT('x.py', '1', 'python3 -m x'), [], false],
  ['echo 1 > x.py; python3 "$f"', [], false],
  ['for i in 1 2 3; do python3 x.py; done', [], false],
])
  add('submitted programs', command, { submitted: { payloads, rewritten } });

for (const command of [
  './scripts/x.sh --quick',
  '/abs/x.sh',
  'node_modules/.bin/tsc --noEmit',
  'npm test',
  'make all',
  'frobnicate "$X"',
  'zsh -c "x"',
  'xargs touch',
  'P=.venv/bin/tool; $P x',
])
  add('programs', command);
// The copy profile alone accounts for programs that ran before it.
for (const [command, ...copies] of [
  ['cp /a /b', 'finite'],
  ['ls; cp /a /b', 'finite'],
  ['git log; sed p f; cp /a /b', 'finite'],
  ['echo x > /dev/null; cp /a /b', 'finite'],
  ['frobnicate; cp /a /b', 'unresolved'],
  ['echo x > log; cp /a /b', 'unresolved'],
  ['sort -o x f; cp /a /b', 'unresolved'],
  ['(frobnicate); cp /a /b', 'unresolved'],
  ['frobnicate | cat; cp /a /b', 'unresolved'],
  ['x=$(frobnicate); cp /a /b', 'unresolved'],
  ['frobnicate & cp /a /b', 'unresolved'],
  // A missing file leaves the shell as it was.
  ['source x.sh; cp /a /b', 'finite', 'unresolved'],
  ['source v/bin/activate; cp /a /b', 'unresolved'],
  ["frobnicate; bash -c 'cp /a /b'", 'unresolved'],
  ["bash -c 'cp /a /b'; frobnicate", 'unresolved'],
  ["bash -c 'cp /a /b'", 'finite'],
])
  add('programs', command, { copies, only: 'copies' });

describe('write projection', () => {
  let root, locations, results;
  const expand = (value) =>
    value
      .replace(/@(?=\/(?!n))/g, locations['@'])
      .replace(/\^(?=\/)/g, locations['^'])
      .replace(/\/@n/g, '/@n');
  const contract = (value) => {
    for (const mark of ['@', '~', '^'])
      if (value === locations[mark] || value.startsWith(locations[mark] + '/'))
        return mark + value.slice(locations[mark].length);
    return value;
  };
  beforeAll(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-write-projection-')));
    locations = {
      '@': path.join(root, 'project'),
      '^': root,
      '~': path.join(root, 'home'),
    };
    for (const directory of [
      'project/.git',
      'project/s1',
      'project/s2',
      'project/meta',
      'project/real/deep',
      'project/globs/mixed',
      'home/h1',
      'links',
      'tmpdir',
    ])
      fs.mkdirSync(path.join(root, directory), { recursive: true });
    for (const file of ['b.py', 'a.py', '.hidden.py', 'c.mjs', 'mixed/a.py', 'mixed/B.py'])
      fs.writeFileSync(path.join(root, 'project/globs', file), '');
    fs.symlinkSync(path.join(root, 'project/real/deep'), path.join(root, 'project/link'));
    fs.symlinkSync(path.join(root, 'project'), path.join(root, 'links/project'));
    const requests = rows.map(({ command, facts }) => ({
      environment: facts.environment ?? {},
      input: {
        command: expand(command),
        cwd: facts.cwd === null ? null : facts.cwd ? expand(facts.cwd) : locations['@'],
        project: locations['@'],
      },
    }));
    const active = String(
      globalThis.__stryker__?.activeMutant ?? process.env.__STRYKER_ACTIVE_MUTANT__ ?? ''
    );
    const child = spawnSync(
      process.execPath,
      [
        '-e',
        '(' + RUNNER + ')().catch(error=>{console.error(error);process.exitCode=1;})',
        path.resolve(__dirname, '../../dist/shell/analysis/mutation-view.js'),
        active,
      ],
      {
        // A fixed environment: inherited settings are cases of their own.
        env: {
          PATH: process.env.PATH,
          HOME: locations['~'],
          TMPDIR: path.join(root, 'tmpdir'),
        },
        input: JSON.stringify(requests),
        encoding: 'utf8',
        timeout: 60000,
        maxBuffer: 64 * 1024 * 1024,
      }
    );
    if (child.error || child.status !== 0)
      throw new Error(
        JSON.stringify({ status: child.status, error: child.error?.message, stderr: child.stderr })
      );
    const output = JSON.parse(child.stdout);
    expect(output).toHaveLength(rows.length);
    results = new Map(rows.map((row, index) => [row.name, output[index]]));
  });
  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  /** Paths named by the recognized writes in a view's token records. */
  function targets(view) {
    const found = [];
    let record = [];
    for (const token of view.tokens) {
      if (token.kind !== 'op') {
        record.push(token);
        continue;
      }
      const words = record.filter((item) => item.kind === 'word');
      let operands = [];
      if (record[0]?.kind === 'redirect') operands = words;
      else if (record[0]?.kind === 'word') {
        const at = words.findIndex(
          (item) => !item.dynamic && ['touch', 'rm', 'tee'].includes(path.basename(item.value))
        );
        const wrapped = words
          .slice(0, Math.max(at, 0))
          .every((item) => /^(?:.*\/)?(?:command|env|exec)$|^--$|=/.test(item.value));
        if (at >= 0 && wrapped)
          operands = words.slice(at + 1).filter((item) => !/^-/.test(item.value));
      }
      for (const item of operands)
        found.push(
          item.dynamic
            ? '?'
            : path.isAbsolute(item.value)
              ? contract(path.normalize(item.value))
              : item.cwd === null
                ? 'null:' + item.value
                : contract(path.resolve(item.cwd, item.value))
        );
      record = [];
    }
    return [...new Set(found)].sort();
  }
  const summarize = (view) => ({
    codes: [...new Set(view.issues.map((issue) => issue.code))].sort(),
    targets: targets(view),
    git: view.gitMetadata
      .map(({ subcommand, worktree, directory }) => {
        const usual = directory === worktree + '/.git';
        return `${subcommand} ${contract(worktree)}${usual ? '' : ' in ' + contract(directory)}`;
      })
      .sort(),
    run: view.interpreters
      .map(
        ({ language, launch, entry, effects, cwd }) =>
          `${language}:${launch}:${entry ?? ''}:${effects.kind}` +
          (cwd === null ? ' anywhere' : cwd === locations['@'] ? '' : ' in ' + contract(cwd))
      )
      .sort(),
    copies: view.copyOperations.map((row) => row.knowledge),
  });

  test('every case is distinct', () => {
    const names = rows.map((row) => row.name);
    expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
  });
  test.each(rows)('$name', ({ name, facts }) => {
    const expected = {
      codes: [...(facts.codes ?? [])].sort(),
      targets: [...new Set(facts.targets ?? [])].sort(),
      git: [...(facts.git ?? [])].sort(),
      run: [...(facts.run ?? [])].sort(),
      copies: facts.copies ?? [],
    };
    const actual = summarize(results.get(name));
    if (facts.submitted) {
      const { interpreters, interpreterInvocations } = results.get(name);
      expect(
        interpreters.map(({ launch, payloads, rewritten }) => ({
          launch,
          payloads: payloads.map((payload) => payload.text),
          rewritten,
        }))
      ).toEqual([{ launch: 'program', ...facts.submitted }]);
      expect(interpreterInvocations).toHaveLength(1);
      expect(actual.codes).toEqual([]);
    } else if (facts.only)
      expect({ [facts.only]: actual[facts.only] }).toEqual({ [facts.only]: expected[facts.only] });
    else expect(actual).toEqual(expected);
  });
});
