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
  run: ['node:inline::finite-writes'],
});
add('directories', 'cd "$X" && node -e \'require("fs").writeFileSync("/abs/o", "x")\'', {
  run: ['node:inline::finite-writes'],
});
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
  ["touch $'a\\tb'", '?'],
  ['touch $"a"', '?'],
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
  ['pathname-expansion', 'rm {a,b}', '?'],
  ['pathname-expansion', 'X="*.log"; touch $X', '?'],
  ['positional-spread', 'touch "$@"', '?'],
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
  'HOME=@/s1 cd',
])
  held('environment', 'environment-change', command);
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
  'GIT_EDITOR=vi git log',
  'GIT_EXTERNAL_DIFF=x git diff',
  'GIT_DIR="$X" git log',
])
  add('git routing', command, { codes: ['git-environment'], only: 'codes' });
add('git routing', 'git log', {
  label: 'git log with an inherited pager',
  environment: { GIT_PAGER: 'less' },
});
add('git routing', 'GIT_PAGER=other git log', {
  environment: { GIT_PAGER: 'less' },
  codes: ['git-environment'],
});

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
  'core.hooksPath=/dev/null',
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
  'clone /x y',
  'commit-tree HEAD',
  'config --get a.b',
  'config --get-all a.b',
  'config -l',
  'config --list',
  'config a.b',
  'config get a.b',
  'config list',
  'config --global a.b c',
  'config --system a.b c',
  'config -f x a.b c',
  'config --file=x a.b c',
  'describe --tags',
  'diff --stat',
  'diff --no-index a b',
  'for-each-ref',
  'fsck',
  'grep -n -e -O x',
  'grep -A1 O x',
  'grep -nfO x',
  'init x',
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
  'branch "$X"',
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
  'fetch',
  'gc',
  'merge x',
  'mv a b',
  'notes add x',
  'notes "$X"',
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
  'rm f',
  'sparse-checkout set x',
  'stash',
  'stash push -m --output=x',
  'stash pop',
  'stash "$X"',
  'submodule update',
  'switch x',
  'symbolic-ref HEAD x',
  'symbolic-ref -d HEAD',
  'tag x',
  'tag -d x',
  'tag -a x',
  'tag -f x',
  'tag --delete x -l',
  'tag -m --output=x y',
  'tag "$X"',
  'update-index x',
  'update-ref x y',
  'worktree add x',
  'worktree "$X"',
  'bundle unbundle x',
  'constructor',
])
  metadata('git writes', 'git ' + command, command.split(' ', 1)[0] + ' @');
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
  'clone -c a=b /x',
  'clone -u x /x',
  'clone --config a=b /x',
  'clone --template=x /x',
  'clone --separate-git-dir=x /x',
])
  held('git hazards', 'git-execution', 'git ' + command);
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
])
  add('git hazards', 'git ' + command, { codes: ['git-option-unmodeled'], only: 'codes' });
add('git hazards', 'git log -o x');
add('git hazards', 'git ls-files --prefix=x');
add('git hazards', 'git grep --no-color x');
add('git hazards', 'git cat-file --batch');

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
  'sort -',
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
  'a\\\ntext\nw out',
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
  'p p',
  '1,',
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
  ['python3 --check-hash-based-pycs never x.py', 'python:program:never:unresolved'],
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
  ['node --require dotenv/config run', 'node:program::unresolved'],
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
  ['mutation-code-source', 'python3 "$X"'],
  ['mutation-code-source', 'python3 -c "$X"'],
  ['mutation-code-source', 'python3 -c'],
  ['mutation-code-source', 'python3 -- "$X"'],
  ['mutation-interpreter-option', 'python3 -i -c 1'],
  ['mutation-interpreter-option', 'python3 --unknown -c 1'],
  ['mutation-interpreter-option', "python3 --unknown - <<'EOF'\n1\nEOF"],
  ['mutation-code-source', 'node "$X"'],
  ['mutation-code-source', 'node -e "$X"'],
  ['mutation-code-source', 'node -e'],
  ['mutation-code-source', 'node -e 1 "$X"'],
  ['mutation-code-source', 'node --inspect "$X"'],
  ['mutation-code-source', 'node -- "$X"'],
  ['mutation-interpreter-option', 'node --import tsx -e 1'],
  ['mutation-interpreter-option', 'node --import=tsx x.js -e 1'.replace(' x.js', '')],
  ['mutation-interpreter-option', 'node --import tsx x -e 1'],
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
  ['mutation-code-source', 'bash "$X"'],
  ['mutation-code-source', 'bash -x "$X"'],
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

// ── Programs ────────────────────────────────────────────────────────────────

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
      'home/h1',
      'links',
      'tmpdir',
    ])
      fs.mkdirSync(path.join(root, directory), { recursive: true });
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
        ({ language, launch, entry, effects }) =>
          `${language}:${launch}:${entry ?? ''}:${effects.kind}`
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
    if (facts.only)
      expect({ [facts.only]: actual[facts.only] }).toEqual({ [facts.only]: expected[facts.only] });
    else expect(actual).toEqual(expected);
  });
});
