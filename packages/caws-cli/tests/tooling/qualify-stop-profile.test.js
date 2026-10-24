/** Structural hostility only. Real component comparisons require pinned images. */
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const script = path.resolve(__dirname, '../../scripts/qualify-stop-profile.mjs');
const run = (body) =>
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
  import assert from 'node:assert/strict';
  const q = await import(${JSON.stringify(require('node:url').pathToFileURL(script).href)});
  ${body}
`,
    ],
    { encoding: 'utf8', timeout: 5000 }
  );

test('fixed corpus refuses omitted, duplicate, failed, skipped and swapped-surface cases', () => {
  run(`
    const rows=[4300,0].flatMap(limit=>[...q.SQL_CASES.map(name=>({id:'sql/'+limit+'/'+name,result:'equal'})),...q.RENDER_CASES.map(name=>({id:'renderer/'+limit+'/'+name,result:'equal'}))]);
    q.verifyCoverage(rows);
    assert.throws(()=>q.verifyCoverage(rows.slice(1)),/missing/);
    assert.throws(()=>q.verifyCoverage([...rows,rows[0]]),/missing/);
    for(const result of ['failed','skipped','unknown']) {
      const bad=rows.map(row=>({...row})); bad[0].result=result;
      assert.throws(()=>q.verifyCoverage(bad),/did not establish/);
    }
    const swapped=rows.map(row=>({...row})); swapped[0].id='zcode/'+swapped[0].id;
    assert.throws(()=>q.verifyCoverage(swapped),/missing/);
  `);
});

test('request cannot replace fixed oracle with echo recipes or change reviewed corpus', () => {
  const sharedRoot = path.resolve(__dirname, '../../templates/hook-packs/shared');
  const sharedFiles = {};
  const visit = (directory) => {
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name);
      if (fs.lstatSync(file).isDirectory()) visit(file);
      else
        sharedFiles[path.relative(sharedRoot, file)] = createHash('sha256')
          .update(fs.readFileSync(file))
          .digest('hex');
    }
  };
  visit(sharedRoot);
  run(`
    const pin={path:'/physical/tool',sha256:'0'.repeat(64)};
    const request={schema:'caws.qualify-stop-components.request.v1',outputRoot:'/external/new',surface:'opencode',
      candidate:{node:pin,native:pin,engine:pin,distRoot:'/physical/dist',distFiles:{'index.js':'0'.repeat(64)}},
      reference:{python:pin,adapter:{path:'/external/frozen-reference.py',sha256:q.REVIEWED_REFERENCE_ADAPTER_SHA256},sharedRoot:'/physical/shared',sharedFiles:${JSON.stringify(sharedFiles)},pythonDependencies:{'/physical/stdlib/json.py':'0'.repeat(64)}},
      corpus:{cells:{path:'/retained/sql-cells.json',sha256:q.SQL_CORPUS_SHA256}}};
    q.validateRequest(request);
    assert.throws(()=>q.validateRequest({...request,surface:'zcode'}));
    assert.throws(()=>q.validateRequest({...request,commands:[['echo','same'],['echo','same']]}),/unsupported/);
    assert.throws(()=>q.validateRequest({...request,requiredCases:[]}),/unsupported/);
    assert.throws(()=>q.validateRequest({...request,corpus:{cells:pin}}),/unreviewed/);
    assert.throws(()=>q.validateRequest({...request,reference:{...request.reference,adapter:pin}}),/unreviewed external reference adapter/);
    const replaced={...request.reference.sharedFiles,'session_log_renderer.py':'0'.repeat(64)};
    assert.throws(()=>q.validateRequest({...request,reference:{...request.reference,sharedFiles:replaced}}),/unreviewed stock reference inventory/);
    const omitted={...request.reference.sharedFiles}; delete omitted['lib/transcript-store.py'];
    assert.throws(()=>q.validateRequest({...request,reference:{...request.reference,sharedFiles:omitted}}),/unreviewed stock reference inventory/);
  `);
});

test('numeric-looking crashes cannot become renderer integer-limit agreement', () => {
  run(`
    const failure={disposition:'failed',failure:{phase:'numeric',cause:{phase:'numeric',message:'Integer exceeds selected 4300-digit limit',byteOffset:0n}}};
    assert.equal(q.normalizeRendererFailure(failure,'integer4301',4300).sourceStage,'json_integer');
    for(const changed of [
      {...failure,failure:{...failure.failure,phase:'encoding'}},
      {...failure,failure:{...failure.failure,cause:{...failure.failure.cause,message:'Integer limit crashed unexpectedly'}}},
      {...failure,failure:{...failure.failure,cause:{...failure.failure.cause,byteOffset:1n}}},
    ]) assert.throws(()=>q.normalizeRendererFailure(changed,'integer4301',4300));
    assert.throws(()=>q.normalizeRendererFailure(failure,'plain',4300));
    assert.throws(()=>q.normalizeRendererFailure(failure,'integer4301',0));
    assert.throws(()=>q.normalizeRendererFailure(failure,'html-decimal4301',4300));
  `);
});

test('matching false outcomes and unpinned Python dependencies refuse', () => {
  run(`
    assert.throws(()=>q.verifyFixedOutcome('sql','message-int4301',4300,{kind:'projection'}),/wrong semantic/);
    assert.throws(()=>q.verifyFixedOutcome('renderer','html-decimal4301',4300,{kind:'artifacts'}),/wrong semantic/);
    assert.throws(()=>q.verifyFixedOutcome('renderer','plain',0,{kind:'integer_limit'}),/wrong semantic/);
    assert.throws(()=>q.verifyReferenceDependencies({implementation:'cpython',version:'3.11.13 fixture',modules:{json:{path:'/unreviewed/json.py',sha256:'0'.repeat(64)}}},{}),/unqualified Python dependency/);
    assert.throws(()=>q.verifyReferenceDependencies({implementation:'cpython',version:'3.11.13 fixture',modules:{}},{}),/empty reference/);
  `);
});

test('HTML refusal must identify the shell row after the visible user row', () => {
  run(`
    const offset=123n;
    const failure={disposition:'failed',failure:{phase:'normalization',cause:{phase:'normalization',message:'Exceeds the limit (4300 digits) for integer string conversion: value has 4301 digits; use sys.set_int_max_str_digits() to increase the limit',byteOffset:offset}}};
    assert.equal(q.normalizeRendererFailure(failure,'html-decimal4301',4300,offset).sourceStage,'html_decimal');
    assert.throws(()=>q.normalizeRendererFailure(failure,'html-decimal4301',4300),/outside fixed row/);
    assert.throws(()=>q.normalizeRendererFailure(failure,'html-literal4301',4300,offset),/not expected/);
    q.verifyFixedOutcome('renderer','html-literal4301',4300,{kind:'artifacts'});
    assert.throws(()=>q.verifyFixedOutcome('renderer','html-literal4301',4300,{kind:'integer_limit'}),/wrong semantic/);
  `);
});
