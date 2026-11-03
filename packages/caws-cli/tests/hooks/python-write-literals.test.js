const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const library = path.resolve(
  __dirname,
  '../../templates/hook-packs/shared/lib/bash-mutation-targets.sh'
);
let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-python-literals-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function extract(source) {
  const entry = path.join(root, 'runner.py');
  fs.writeFileSync(entry, source);
  const result = spawnSync(
    'bash',
    [
      '--noprofile',
      '--norc',
      '-c',
      'source "$1"; caws_bash_interpreter_write_literals "$2" "$3"',
      '_',
      library,
      `python3 ${entry}`,
      root,
    ],
    { encoding: 'utf8', timeout: 10000 }
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  return result.stdout.trim().split('\n').filter(Boolean);
}

test('documentation, read paths, report text and argparse help are not write paths', () => {
  expect(
    extract(`"""See docs/DOCTRINE-OPERATIONAL.md and engine/ProjectSettings/ProjectVersion.txt."""
from pathlib import Path
import argparse
# docs/comment.md
def report():
    lines = []
    lines.append("See docs/DOCTRINE-OPERATIONAL.md")
    return lines
def run(out):
    readme = Path("docs/readme.md").read_text()
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine", help="default engine/")
    snapshot = out / "snapshot.txt"
    snapshot.write_text(readme)
    print("See docs/DOCTRINE-OPERATIONAL.md")
run(Path("/tmp/owned-output"))
`)
  ).toEqual(['/tmp/owned-output']);
});

test.each([
  ['direct receiver', 'Path("foreign/direct.txt").write_text("payload")', 'foreign/direct.txt'],
  [
    'assigned receiver',
    'p = Path("foreign/assigned.txt")\np.write_bytes(b"x")',
    'foreign/assigned.txt',
  ],
  ['open mode', 'open("foreign/open.txt", "w").write("x")', 'foreign/open.txt'],
  [
    'keyword open mode',
    'open(file="foreign/keyword.txt", mode="a").write("x")',
    'foreign/keyword.txt',
  ],
  [
    'home composition',
    'p = Path.home() / "Desktop/Projects/other/file.py"\np.write_text("x")',
    'Desktop/Projects/other/file.py',
  ],
  [
    'function argument',
    'def save(p):\n    p.write_text("x")\nsave(Path("foreign/argument.txt"))',
    'foreign/argument.txt',
  ],
  [
    'keyword argument',
    'def save(p):\n    p.write_text("x")\nsave(p=Path("foreign/keyword-argument.txt"))',
    'foreign/keyword-argument.txt',
  ],
  [
    'attribute assignment',
    'box.p = Path("foreign/attribute.txt")\nbox.p.write_text("x")',
    'foreign/attribute.txt',
  ],
  [
    'container mutation',
    'paths = []\npaths.append(Path("foreign/container.txt"))\npaths[0].write_text("x")',
    'foreign/container.txt',
  ],
  [
    'loop binding',
    'for p in [Path("foreign/loop.txt")]:\n    p.write_text("x")',
    'foreign/loop.txt',
  ],
  [
    'return value',
    'def target():\n    return Path("foreign/returned.txt")\ntarget().write_text("x")',
    'foreign/returned.txt',
  ],
  [
    'callable alias',
    'def save(p):\n    p.write_text("x")\nalias = save\nalias(Path("foreign/alias.txt"))',
    'foreign/alias.txt',
  ],
  [
    'escaped callback fallback',
    'def save(p):\n    p.write_text("x")\nlist(map(save, [Path("foreign/callback.txt")]))',
    'foreign/callback.txt',
  ],
  [
    'lambda fallback',
    'save = lambda p: p.write_text("x")\nsave(Path("foreign/lambda.txt"))',
    'foreign/lambda.txt',
  ],
  [
    'constructor fallback',
    'class Save:\n def __init__(self, p):\n  self.path = p\n  self.path.write_text("x")\nSave(Path("foreign/constructor.txt"))',
    'foreign/constructor.txt',
  ],
  [
    'reflection fallback',
    'p = object()\nsetattr(p, "file", Path("foreign/reflection.txt"))\np.file.write_text("x")',
    'foreign/reflection.txt',
  ],
  [
    'shadowed display function',
    'def print(p):\n    Path(p).write_text("x")\nprint("foreign/shadowed.txt")',
    'foreign/shadowed.txt',
  ],
  [
    'interpolated write',
    "print(f\"done {Path('foreign/interpolated.txt').write_text('x')}\")",
    'foreign/interpolated.txt',
  ],
])('%s keeps the literal target', (_, source, target) => {
  expect(extract(`from pathlib import Path\n${source}\n`)).toContain(target);
  expect(fs.existsSync(path.join(root, target))).toBe(false);
});

test('data written into a file does not acquire path authority', () => {
  expect(
    extract('from pathlib import Path\nPath("/tmp/owned.txt").write_text("docs/message.md")\n')
  ).toEqual(['/tmp/owned.txt']);
});

test('all assignment alternatives remain potential targets', () => {
  const result = extract(
    'from pathlib import Path\np = Path("foreign/first.txt")\nif unknown:\n p = Path("foreign/second.txt")\np.write_text("x")\n'
  );
  expect(result).toEqual(expect.arrayContaining(['foreign/first.txt', 'foreign/second.txt']));
});

test('malformed source preserves the conservative original observation', () => {
  expect(extract('p.write_text("x")\n# docs/fallback.md\nif (\n')).toContain('docs/fallback.md');
});

test('reference cycles terminate without executing the script', () => {
  expect(extract('a = b\nb = a\na.write_text("docs/data.md")\n')).toEqual([]);
});

test('unrelated function and lambda bindings cannot contaminate a write path', () => {
  expect(
    extract(
      'from pathlib import Path\ndef report():\n s = "docs/report.md"\n return sorted([s], key=lambda s: s)\ndef save(out):\n p = out / "result.txt"\n p.write_text("x")\nsave(Path("/tmp/owned"))\n'
    )
  ).toEqual(['/tmp/owned']);
});

test('relevant nonlocal bindings retain the original conservative observation', () => {
  expect(
    extract(
      'from pathlib import Path\ndef outer():\n p = Path("foreign/nonlocal.txt")\n def save():\n  nonlocal p\n  p.write_text("x")\n save()\nouter()\n'
    )
  ).toContain('foreign/nonlocal.txt');
});

test('analysis budget exhaustion retains original literals', () => {
  expect(
    extract('p.write_text("x")\n# docs/budget-fallback.md\n' + 'a = 1\n'.repeat(9000))
  ).toContain('docs/budget-fallback.md');
});

test.each([
  [
    'context binding',
    'from contextlib import nullcontext\nwith nullcontext(Path("foreign/context.txt")) as p:\n p.write_text("x")',
    'foreign/context.txt',
  ],
  [
    'class attribute fallback',
    'class C:\n p = Path("foreign/class.txt")\nC.p.write_text("x")',
    'foreign/class.txt',
  ],
  [
    'generator return',
    'def target():\n yield Path("foreign/generator.txt")\nnext(target()).write_text("x")',
    'foreign/generator.txt',
  ],
  [
    'lambda expanded fallback',
    'save = lambda *p: p[0].write_text("x")\nsave(Path("foreign/lambda-expanded.txt"))',
    'foreign/lambda-expanded.txt',
  ],
])('%s retains a target previously visible to the legacy guard', (_, source, target) => {
  expect(extract('from pathlib import Path\n' + source + '\n')).toContain(target);
});

test.each([
  [
    'expanded assignment',
    '*p, = [Path("foreign/expanded.txt")]\np[0].write_text("x")',
    'foreign/expanded.txt',
  ],
  [
    'descriptor open',
    'import os\nf = os.open("foreign/descriptor.txt", os.O_WRONLY)',
    'foreign/descriptor.txt',
  ],
  [
    'aliased descriptor open',
    'import os as files\nf = files.open("foreign/descriptor-alias.txt", files.O_WRONLY)',
    'foreign/descriptor-alias.txt',
  ],
  [
    'unbound path open',
    'Path.open(Path("foreign/unbound-open.txt"), "w")',
    'foreign/unbound-open.txt',
  ],
  [
    'exception binding fallback',
    'try:\n raise ValueError("foreign/exception.txt")\nexcept ValueError as p:\n Path(p.args[0]).write_text("x")',
    'foreign/exception.txt',
  ],
  [
    'decorated binding fallback',
    '@decorate("foreign/decorated.txt")\ndef save(p):\n p.write_text("x")\nsave()',
    'foreign/decorated.txt',
  ],
])('%s retains a possible literal target', (_, source, target) => {
  expect(extract('from pathlib import Path\n' + source + '\n')).toContain(target);
});

test('path defaults stay attached to their declared parameter', () => {
  expect(
    extract(
      'from pathlib import Path\nclass Record:\n pid: int\ndef save(out, formatting=Record()):\n out.write_text("x")\nsave(Path("/tmp/owned"))\n'
    )
  ).toEqual(['/tmp/owned']);
  expect(
    extract(
      'from pathlib import Path\ndef save(out=Path("foreign/default.txt")):\n out.write_text("x")\nsave()\n'
    )
  ).toContain('foreign/default.txt');
});

test('record construction used in a file name keeps source fields without unrelated prose', () => {
  expect(
    extract(
      'from pathlib import Path\nclass Record:\n pid: int\ndef save(out):\n client = Record(123)\n target = out / f"result-{client.pid}.txt"\n target.write_text("x")\n print("See docs/output.md")\nsave(Path("/tmp/owned"))\n'
    )
  ).toEqual(['/tmp/owned']);
});

test.each([
  'p = Path("foreign/outer-default.txt")\ndef save(p=p):\n p.write_text("x")\nsave()',
  'q = Path("foreign/outer-default.txt")\ndef save(p=q, q=None):\n p.write_text("x")\nsave()',
  'def outer(p=Path("foreign/outer-default.txt")):\n def save(p=p):\n  p.write_text("x")\n save()\nouter()',
])('default expressions resolve in the defining scope: %s', (source) => {
  expect(extract('from pathlib import Path\n' + source + '\n')).toContain(
    'foreign/outer-default.txt'
  );
});
