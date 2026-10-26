const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { classifyInterpreterEffects } = require('../../dist/shell/analysis/interpreter-effects');

const profile = 'caws.node-source-effects.v1';
const classify = (source) => classifyInterpreterEffects('node', source);
function held(source, reason) {
  expect(classify(source)).toEqual({
    kind: 'unresolved',
    profile: null,
    writes: [],
    reason: expect.stringMatching(reason || /.+/),
  });
}

describe('bounded interpreter source effects', () => {
  test.each([
    '',
    '// writeFileSync("/foreign", "x")\nconsole.log("write /foreign/output");',
    'console.log(JSON.stringify([{id:1}].map(e=>({id:e.id}))));',
    'const f=()=>{console.log(1,2)}; const obj={a:1,b:2};f();',
    'const values=[{id:1},{id:2}]; console.log(JSON.stringify(values.map(e=>({id:e.id}))));',
    'const obj={path:"/foreign", write:"/also-foreign"}; console.log(obj.path);',
    'const fs=require("fs"); console.log(fs.readFileSync("/foreign/source", "utf8"));',
    'require("node:fs").readdirSync("/foreign");',
    '(()=>"a > b")();',
    'const f=(x)=>{const o={id:x}; return o.id;}; console.log(f(1));',
    'const console={log:1}; console;',
    'console.log(null,true,false,2+3);',
    'const obj={"owned":"/owned/result"};console.log(obj.owned);',
    ';const f=()=>{return;};f();',
  ])('admits only modeled benign source: %s', (source) => {
    expect(classify(source)).toEqual({ kind: 'readonly', profile, writes: [] });
  });

  test.each(['fs', 'node:fs'])('reports only actual first-argument targets for %s', (module) => {
    const source = `const fs=require('${module}');fs.readFileSync('/project/.caws/worktrees/foreign/input','utf8');fs.writeFileSync('/project/.caws/worktrees/own/output','/project/.caws/worktrees/foreign/data');`;
    const target = "'/project/.caws/worktrees/own/output'";
    expect(classify(source)).toEqual({
      kind: 'finite-writes',
      profile,
      writes: [
        {
          target: '/project/.caws/worktrees/own/output',
          operation: 'write',
          start: source.indexOf(target),
          end: source.indexOf(target) + target.length,
        },
      ],
    });
  });

  test('preserves ordered write and append effects with exact target-expression offsets', () => {
    const source =
      '// λ and 💡 use UTF-16 source offsets\nconst fs=require("node:fs");const base="/project/";const out=base+"owned";fs.writeFileSync(out,"/foreign/inert");fs.appendFileSync(base+"next","x","utf8");';
    const first = source.indexOf('out,"/foreign');
    const second = source.indexOf('base+"next"');
    expect(classify(source)).toEqual({
      kind: 'finite-writes',
      profile,
      writes: [
        { target: '/project/owned', operation: 'write', start: first, end: first + 3 },
        {
          target: '/project/next',
          operation: 'append',
          start: second,
          end: second + 'base+"next"'.length,
        },
      ],
    });
    expect(source.slice(first, first + 3)).toBe('out');
    expect(source.slice(second, second + 'base+"next"'.length)).toBe('base+"next"');
  });

  test('passes a finite target through a modeled direct function call', () => {
    const source =
      'const fs=require("fs");const f=(p)=>{fs.writeFileSync(p,"x")};f("/owned/result");';
    const start = source.indexOf('p,"x"');
    expect(classify(source)).toEqual({
      kind: 'finite-writes',
      profile,
      writes: [{ target: '/owned/result', operation: 'write', start, end: start + 1 }],
    });
  });

  test('source analysis performs no filesystem or code execution', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-interpreter-inert-'));
    const sentinel = path.join(directory, 'executed');
    try {
      const literal = JSON.stringify(sentinel);
      const source = `require('fs').writeFileSync(${literal},'executed')`;
      expect(classify(source).writes).toEqual([
        {
          target: sentinel,
          operation: 'write',
          start: source.indexOf(literal),
          end: source.indexOf(literal) + literal.length,
        },
      ]);
      held(`eval("require('fs').writeFileSync(${literal.replace(/"/g, '\\"')},'executed')")`);
      held(`process.mainModule.require('fs').writeFileSync(${literal},'executed')`);
      expect(fs.existsSync(sentinel)).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test.each([
    'require("fs").rmSync("/foreign");',
    'require("fs").truncateSync("/foreign");',
    'require("fs").openSync("/foreign","w");',
    'require("child_process").execSync("touch /foreign");',
    'require("node:module").createRequire("/tmp/a.js")("other");',
    'unknownApi();',
    'process.chdir("/foreign");',
    'process.env.NODE_OPTIONS;',
    'eval("1");',
    'new Function("return 1")();',
    'import("fs");',
    'import fs from "fs";',
    'const fs=require("fs");const w=fs.writeFileSync;w("/foreign","x");',
    'const fs=require("fs");const alias=fs;alias.writeFileSync("/foreign","x");',
    'const fs=require("fs");fs["writeFileSync"]("/foreign","x");',
    'const fs=require("fs");fs.writeFileSync(process.argv[2],"x");',
    'const fs=require("fs");fs.writeFileSync(String.fromCharCode(47,120),"x");',
    'const fs=require("fs");fs.writeFileSync(fs.readFileSync("/target","utf8"),"x");',
    'const fs=require("fs");fs.writeFileSync({toString:()=>"/foreign"},"x");',
    'require("fs").readFileSync("/foreign",{flag:"w"});',
    'require("fs").readdirSync("/foreign",{encoding:"utf8"});',
    'require("fs").writeFileSync("/owned","x",{flag:"a"});',
    'require("fs").writeFileSync(1,"x");',
    'require("fs").writeFileSync("/owned\\0other","x");',
    'require("fs").writeFileSync("/owned");',
    'require("fs").readFileSync("/foreign","utf8","extra");',
    'const x={get a(){return 1}}; console.log(x.a);',
    'const x={set a(v){console.log(v)}};',
    'const x={method(){return 1}};x.method();',
    'const x={__proto__:{a:1}};console.log(x.a);',
    'console.log({}.constructor);',
    'console.log({}.toString);',
    'const x={a:1};console.log(x.missing);',
    'const x={a:1};x.a=2;',
    'let x=1;x++;',
    'if(true){console.log(1)}',
    'while(false){}',
    'try{console.log(1)}catch(e){}',
    'console.log(JSON.stringify([1],()=>1));',
    'console.log(JSON.stringify({toJSON:()=>"/foreign"}));',
    'console.log(...[1,2]);',
    'console.log([,1]);',
    'console.log({...{a:1}});',
    'console.log(/x/);',
    'console.log(1n);',
    'const f=async()=>1;f();',
    'const f=()=>unknownApi();',
    'const f=x=>x;',
    'const f=()=>1;const g=f;g();',
    'const f=()=>f();f();',
    '[].map(x=>unknownApi());',
    '[1].map(()=>unknownApi());',
    '[{id:1}].map(x=>x.constructor);',
    '[1].map(x=>require("fs").writeFileSync("/foreign","x"));',
    '[1].map(x=>{const f=()=>require("fs").writeFileSync("/foreign","x");f();return x;});',
    'const x={a:1};console.log("prefix"+x);',
    'const console={log:()=>1};console.log();',
    'console.log(1); require("fs").rmSync("/foreign");',
    'require("fs").writeFileSync("/owned","x");unknownApi();',
    'console.log(1); this',
    'console.log(1); /* unterminated',
  ])('holds unsupported syntax or effects without partial claims: %s', (source) => held(source));

  test.each(['print("a > b")', '1', '__import__("os").remove("/foreign")', ''])(
    'Python has no admitted source profile: %s',
    (source) => {
      expect(classifyInterpreterEffects('python', source)).toEqual({
        kind: 'unresolved',
        profile: null,
        writes: [],
        reason: 'no admitted Python source-effect profile',
      });
    }
  );

  test('enforces the source byte boundary before parsing', () => {
    const atLimit = '//' + 'x'.repeat(65534);
    expect(classify(atLimit)).toEqual({ kind: 'readonly', profile, writes: [] });
    held(atLimit + 'x', /source byte budget/);
    held('//' + 'λ'.repeat(32768), /source byte budget/);
  });

  test('enforces AST depth including literal leaf nodes', () => {
    const nested = (depth) => '['.repeat(depth) + '1' + ']'.repeat(depth);
    expect(classify(nested(62))).toEqual({ kind: 'readonly', profile, writes: [] });
    held(nested(63), /AST budget/);
    held(nested(5000));
  });

  test('enforces AST node and abstract value budgets independently', () => {
    expect(classify('0;'.repeat(4095))).toEqual({ kind: 'readonly', profile, writes: [] });
    held('0;'.repeat(4096), /AST budget/);
    const array = (count) => 'const x=[' + Array(count).fill('0').join(',') + '];';
    expect(classify(array(4094))).toEqual({ kind: 'readonly', profile, writes: [] });
    held(array(4095), /abstract value budget/);
  });

  test('holds abstract string expansion even when source fits the byte limit', () => {
    const source = 'const a="' + 'x'.repeat(32768) + '";const b=a+a;';
    held(source, /abstract string budget/);
  });

  test('bounds recursive plain-data visits even for shared abstract objects', () => {
    let source = 'const a0={a:1};';
    for (let i = 1; i <= 16; i++) source += `const a${i}={a:a${i - 1},b:a${i - 1}};`;
    held(source, /evaluation step budget/);
  });

  test.each([
    ['const x={prototype:1};', 'prototype-related object key'],
    ['const x={constructor:1};', 'prototype-related object key'],
    ['const x={__proto__:1};', 'prototype-related object key'],
    ['const fs=require("fs");console.log(fs);', 'capability or function used as plain data'],
    ['const f=()=>1;f();console.log(f);', 'capability or function used as plain data'],
    ['const fs=require("fs");const x={a:fs};', 'capability or function used as plain data'],
    ['const fs=require("fs");const x=[fs];', 'capability or function used as plain data'],
    ['require("fs").writeFileSync(1,"x");', 'target or option is not a finite string'],
    ['require("fs").writeFileSync();', 'unsupported fs call arity'],
    [
      'const fs=require("fs");fs.writeFileSync("/owned",fs);',
      'capability or function used as plain data',
    ],
    ['require("fs").writeFileSync("/owned",unknownApi());', 'unknown identifier: unknownApi'],
    ['const fs=require("fs");fs["readFileSync"]("/source");', 'unsupported property access'],
    ['const obj={a:1};obj["a"];', 'unsupported property access'],
    ['const obj={a:1};obj.missing;', 'property is not proven own plain data'],
    ['console.log(1,{},{}).missing;', 'property is not proven own plain data'],
    ['const x={get a(){return 1}};', 'object accessors, methods, or spread are unsupported'],
    ['const x={set a(v){console.log(v)}};', 'object accessors, methods, or spread are unsupported'],
    ['const x={method(){return 1}};', 'object accessors, methods, or spread are unsupported'],
    ['const x={["a"]:1};', 'object accessors, methods, or spread are unsupported'],
    ['const x={...{a:1}};', 'object accessors, methods, or spread are unsupported'],
    ['const x={1:"number key"};', 'unsupported object key'],
    ['console.log([,1]);', 'array holes or spread are unsupported'],
    ['console.log([...[]]);', 'array holes or spread are unsupported'],
    ['console.log(1-2);', 'unsupported operator'],
    ['console.log(1+"2");', 'mixed primitive coercion is unsupported'],
    ['console.log("1"+2);', 'mixed primitive coercion is unsupported'],
    ['console.log(true+false);', 'mixed primitive coercion is unsupported'],
    ['console.log(null+1);', 'mixed primitive coercion is unsupported'],
    ['console.log({}+1);', 'implicit object coercion'],
    ['console.log(1+{});', 'implicit object coercion'],
    ['const f=1;f();', 'call target is not an admitted function'],
    ['const f=(x)=>1;f();', 'function arity is not modeled'],
    ['const f=()=>1;f(2);', 'function arity is not modeled'],
    ['const f=({x})=>x;f({x:1});', 'unsupported arrow function'],
    ['const f=async()=>1;f();', 'unsupported arrow function'],
    ['console.log(...[1]);', 'unsupported call syntax'],
    ['require("fs", "ignored");', 'only literal builtin fs require is admitted'],
    ['require();', 'only literal builtin fs require is admitted'],
    ['require("child_process");', 'only literal builtin fs require is admitted'],
    ['console.error(1);', 'unknown identifier: console'],
    ['JSON.parse("{}");', 'unknown identifier: JSON'],
    ['const console=1;console.log(1);', 'unsupported method call'],
    ['const JSON=1;JSON.stringify(1);', 'unsupported method call'],
    ['const require=()=>1;require("fs");', 'function arity is not modeled'],
    ['const f=()=>require("fs");const fs=f();', 'aliased filesystem capability'],
    ['const object={a:1};object.log(1);', 'unsupported method call'],
    ['const object={a:1};object.stringify(1);', 'unsupported method call'],
    ['[1].filter(x=>x);', 'unsupported method call'],
    ['const f=x=>x;[1].map(f);', 'map requires a direct arrow callback'],
    ['[1].map(x=>x,1);', 'map requires a direct arrow callback'],
    ['[1].map();', 'map requires a direct arrow callback'],
    ['[].map(x=>x);', 'empty map leaves callback behavior unproven'],
    ['let x=1;', 'unsupported statement: VariableDeclaration'],
    ['const {x}={x:1};', 'unsupported declaration'],
    ['const f=()=>{return 1;console.log(2)};f();', 'unsupported statement: ReturnStatement'],
    ['const f=()=>{if(true){console.log(1)}};f();', 'unsupported statement: IfStatement'],
  ])('explains the rejected capability or grammar boundary: %s', (source, reason) => {
    expect(classify(source)).toEqual({ kind: 'unresolved', profile: null, writes: [], reason });
  });

  test('uses quoted own-property data as an actual finite target', () => {
    const source =
      'const obj={"target":"/owned/result"};require("fs").writeFileSync(obj.target,"x");';
    const start = source.indexOf('obj.target');
    expect(classify(source)).toEqual({
      kind: 'finite-writes',
      profile,
      writes: [
        { target: '/owned/result', operation: 'write', start, end: start + 'obj.target'.length },
      ],
    });
  });

  test('propagates a modeled function return into a finite target', () => {
    const source = 'const f=()=>{return "/owned/result";};require("fs").writeFileSync(f(),"x");';
    const start = source.indexOf('f(),"x"');
    expect(classify(source)).toEqual({
      kind: 'finite-writes',
      profile,
      writes: [{ target: '/owned/result', operation: 'write', start, end: start + 'f()'.length }],
    });
  });

  test('restores callback and direct-call state before a later top-level write', () => {
    const source =
      'const f=()=>1;f();[1,2].map(x=>x);require("fs").writeFileSync("/owned/result","x");';
    const start = source.indexOf('"/owned/result"');
    expect(classify(source)).toEqual({
      kind: 'finite-writes',
      profile,
      writes: [
        {
          target: '/owned/result',
          operation: 'write',
          start,
          end: start + '"/owned/result"'.length,
        },
      ],
    });
  });

  test('applies ordinary unshadowed builtins inside a lexical function environment', () => {
    expect(classify('const f=()=>{console.log(JSON.stringify({"a":1}));};f();')).toEqual({
      kind: 'readonly',
      profile,
      writes: [],
    });
    held('const console=1;const f=()=>console.log(1);f();', /^unsupported method call$/);
    held('const f=(JSON)=>JSON.stringify(1);f(1);', /^unsupported method call$/);
  });

  test('admits exactly the AST-node budget even when the statement count is odd', () => {
    const atLimit = '0;'.repeat(4095) + ';';
    expect(classify(atLimit)).toEqual({ kind: 'readonly', profile, writes: [] });
    held(atLimit + ';', /^AST budget exceeded$/);
  });

  test('admits exactly the accumulated abstract-string byte budget', () => {
    const atLimit = 'const a="' + 'x'.repeat(16384) + '";const b=a+a;const c=a+"";';
    expect(classify(atLimit)).toEqual({ kind: 'readonly', profile, writes: [] });
    held(atLimit + '"x";', /^abstract string budget exceeded$/);
  });

  test('admits exactly the function-depth budget and releases completed frames', () => {
    const chain = (count) => {
      let source = 'const f0=()=>1;';
      for (let i = 1; i < count; i++) source += `const f${i}=()=>f${i - 1}();`;
      return source + `f${count - 1}();`;
    };
    expect(classify(chain(64))).toEqual({ kind: 'readonly', profile, writes: [] });
    held(chain(65), /^function depth budget exceeded$/);
    expect(classify('const f=()=>1;' + 'f();'.repeat(65))).toEqual({
      kind: 'readonly',
      profile,
      writes: [],
    });
    held('const f=()=>f();f();', /^function depth budget exceeded$/);
  });

  test('admits exactly the evaluation-step budget for shared plain data', () => {
    let source = 'const a0={a:1};';
    for (let i = 1; i <= 12; i++) source += `const a${i}={a:a${i - 1},b:a${i - 1}};`;
    // Declarations consume 24598 visits. The subsequent data walks consume
    // 3074 + 3074 + 1538 + 386 + 98 visits, reaching the inclusive 32768 limit.
    source += 'console.log(a10);console.log(a10);console.log(a9);console.log(a7);console.log(a5);';
    expect(classify(source)).toEqual({ kind: 'readonly', profile, writes: [] });
    held(source + ';', /^evaluation step budget exceeded$/);
  });
});
