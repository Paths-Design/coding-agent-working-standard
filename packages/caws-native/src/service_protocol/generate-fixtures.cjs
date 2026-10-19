// Generate external Rust wire fixtures from the existing CLI distribution.
// Run after the CLI build, from the repository root, with an output path.
const fs = require('node:fs');
const path = require('node:path');
const root = process.cwd();
const p = require(path.join(root,'packages/caws-cli/dist/runtime/service-protocol.js')); const c = require(path.join(root,'packages/caws-cli/dist/runtime/service-client.js'));
const grant = {
  schema:c.SERVICE_GRANT_SCHEMA, grantId:'f'.repeat(64),adapter:c.SERVICE_ADAPTER,
  invocationId:'native-wire:fixture-1',selectedIndex:65535,canonicalProject:'/project/模型🙂',sourceGeneration:'a'.repeat(64),
  originalSource:{handlerSha256:'b'.repeat(64),closureDigest:'c'.repeat(64)},
  executionImage:{imageDigest:'d'.repeat(64),clientSha256:'e'.repeat(64)},
  originalHandlerEntry:'session-log.sh',originalHandlerPath:'/source/session-log.sh',hooksDirectory:'/image/hooks',leaseFile:'/lease',remainingBudgetMs:120000,
};
const args = ['/log','/cwd','sid','started','模型🙂\r\n\x1f\u2028\u2029/','branch','head','0','start','/transcript','/audit','/outcome'];
const request = c.makeServiceRenderRequest(grant,[grant.hooksDirectory,grant.leaseFile,...args]);
const cases=[];
const b64 = (b) => {
 const buf=Buffer.from(b);if(buf.length<8192)return buf.toString('base64');
 const parts=[];let start=0;
 for(let i=0;i<buf.length;){let end=i+1;while(end<buf.length&&buf[end]===buf[i])end++;
  if(end-i>=32){if(i>start)parts.push(buf.subarray(start,i).toString('base64'));parts.push({byte:buf[i],count:end-i});start=end;}i=end;}
 if(start<buf.length)parts.push(buf.subarray(start).toString('base64'));return parts;
};
const frame = (v) => Buffer.from(JSON.stringify(v)+'\n');
function add(name, kind, bytes) {
  let canonical = null;
  try {
    if(kind==='request') canonical=p.encodeRenderRequest(p.decodeRenderRequest(bytes));
    else if(kind==='grant') canonical=c.encodeServiceGrant(c.decodeServiceGrant(bytes));
    else if(kind==='bridge_request') canonical=c.encodeServiceBridgeRequest(grant,c.decodeServiceBridgeRequest(bytes,grant).request);
    else if(kind==='outcome') canonical=p.encodeRenderOutcome(p.decodeRenderOutcome(bytes,request),request);
    else if(kind==='bridge_reply') canonical=c.encodeServiceBridgeReply(c.decodeServiceBridgeReply(bytes,grant,request),grant,request);
    else if(kind==='receipt') canonical=c.encodeServiceClientReceipt(c.decodeServiceClientReceipt(bytes,grant,request),grant,request);
    else throw new Error(kind);
  } catch {}
  cases.push({name,kind,wire:b64(bytes),canonical:canonical ? b64(canonical) : null});
}
add('control nonASCII uint16-max request','request',p.encodeRenderRequest(request));
add('native-issued grant','grant',c.encodeServiceGrant(grant));
add('grant reordered no LF','grant',JSON.stringify(Object.fromEntries(Object.entries(grant).reverse())));
add('client bridge request','bridge_request',c.encodeServiceBridgeRequest(grant,request));
const reqbody=p.encodeRenderRequest(request).subarray(0,-1).toString();
for(const [name,mutate] of [
 ['leading whitespace',s=>' '+s],['trailing whitespace',s=>s+' '],['double LF',s=>s+'\n\n'],['CRLF',s=>s+'\r\n'],['BOM',s=>'\ufeff'+s],
 ['float spelling',s=>s.replace('"selectedIndex":65535','"selectedIndex":65535.0')],['exponent spelling',s=>s.replace('"selectedIndex":65535','"selectedIndex":65535e0')],
 ['negative zero',s=>s.replace('"selectedIndex":65535','"selectedIndex":-0')],['alternate escape',s=>s.replace('native-wire:fixture-1','\\u006eative-wire:fixture-1')],
 ['duplicate top field',s=>s.replace('"selectedIndex":65535','"selectedIndex":65535,"selectedIndex":65535')],
 ['duplicate nested field',s=>s.replace('"handlerSha256":','"closureDigest":"'+'c'.repeat(64)+'","handlerSha256":')],
 ['unpaired surrogate',s=>s.replace('模型🙂','\\ud800')],['raw NUL',s=>s.replace('模型🙂','\0')],['escaped NUL',s=>s.replace('模型🙂','\\u0000')],
 ['uint16 overflow',s=>s.replace('"selectedIndex":65535','"selectedIndex":65536')],
 ['unsafe integer',s=>s.replace('"selectedIndex":65535','"selectedIndex":9007199254740992')],
 ['unknown field',s=>s.slice(0,-1)+',"extra":true}'], ['missing field',s=>{const value=JSON.parse(s);delete value.arguments;return JSON.stringify(value);}],
 ['request id tamper',s=>s.replace(request.requestId,'0'.repeat(64))],['argument digest tamper',s=>s.replace(request.argumentDigest,'0'.repeat(64))],
 ['project key tamper',s=>s.replace(request.projectServiceKey,'0'.repeat(64))],
]) add(name,'request',mutate(reqbody));
add('invalid UTF8','request',Buffer.from([0xc0,0xaf]));
const reversed=Object.fromEntries(Object.entries(request).reverse());
reversed.originalSource=Object.fromEntries(Object.entries(request.originalSource).reverse());
add('canonical reordered members no LF','request',JSON.stringify(reversed));
for(const index of [0,65535]) {
  const r=p.createRenderRequest({...Object.fromEntries(['invocationId','selectedIndex','canonicalProject','sourceGeneration','originalSource','executionImage','arguments'].map(k=>[k,request[k]])),selectedIndex:index});
  add('request index '+index,'request',p.encodeRenderRequest(r));
}
for(let i=0;i<12;i++) { const a=args.slice();a[i]='\r\n\x1f模型🙂';const r=c.makeServiceRenderRequest(grant,[grant.hooksDirectory,grant.leaseFile,...a]); add('controls slot '+i,'request',p.encodeRenderRequest(r)); }
const long=request.arguments.slice(); long[0]='x'.repeat(65536-Buffer.byteLength(JSON.stringify(['caws-session-render-argv-v1',Array(12).fill('')])));for(let i=1;i<12;i++)long[i]='';
const boundary=p.createRenderRequest({...Object.fromEntries(['invocationId','selectedIndex','canonicalProject','sourceGeneration','originalSource','executionImage','arguments'].map(k=>[k,request[k]])),arguments:long});
add('argument exact 65536 bytes','request',p.encodeRenderRequest(boundary));
const oversized={...boundary,arguments:[long[0]+'x',...long.slice(1)]};
// Re-derive independently because the TS constructor properly rejects oversized data.
oversized.argumentDigest=require('node:crypto').createHash('sha256').update(JSON.stringify(['caws-session-render-argv-v1',oversized.arguments])).digest('hex');
add('argument 65537 bytes','request',frame(oversized));
add('request body 131073 bytes','request',' '.repeat(131073));
for(const [key,value] of [['remainingBudgetMs',0],['remainingBudgetMs',120001],['selectedIndex',65536],['canonicalProject','/x/../p'],['hooksDirectory','relative'],['originalHandlerPath','/x//p'],['leaseFile','/x\0p'],['grantId','F'.repeat(64)]])add('grant invalid '+key+' '+String(value),'grant',frame({...grant,[key]:value}));
add('grant duplicate','grant',c.encodeServiceGrant(grant).toString().replace('"remainingBudgetMs":120000','"remainingBudgetMs":120000,"remainingBudgetMs":120000'));
add('grant body too large','grant',' '.repeat(32769));
const baseOutcome={schema:p.RENDER_OUTCOME_SCHEMA,requestId:request.requestId,argumentDigest:request.argumentDigest,projectServiceKey:request.projectServiceKey,sourceGeneration:request.sourceGeneration,executionImageDigest:request.executionImage.imageDigest};
const outcomes=[
 {admission:'rejected',execution:'known_not_executed',reason:'why\0\r\n模型🙂'},
 ...['queued','running','unknown'].map(execution=>({admission:'accepted',execution})),
 ...['source_retired','grant_withdrawn'].map(reason=>({admission:'accepted',execution:'cancelled_before_dispatch',reason})),
 ...[{kind:'process_exit',code:0,signal:null},{kind:'process_exit',code:255,signal:null},{kind:'process_exit',code:null,signal:127},
 {kind:'daemon_response',response:'ok',served:9007199254740991,elapsedMs:9007199254740991,cached:true}].map(result=>({admission:'accepted',execution:'returned',result,artifactManifestDigest:null})),
];
for(let i=0;i<outcomes.length;i++){
 const outcome={...baseOutcome,outcome:outcomes[i]};
 add('outcome variant '+i,'outcome',p.encodeRenderOutcome(outcome,request));
 add('bridge reply variant '+i,'bridge_reply',c.encodeServiceBridgeReply({schema:c.SERVICE_BRIDGE_REPLY_SCHEMA,grantId:grant.grantId,grantDigest:c.serviceGrantDigest(grant),outcome},grant,request));
 add('receipt owner variant '+i,'receipt',c.encodeServiceClientReceipt({schema:c.SERVICE_RECEIPT_SCHEMA,grantId:grant.grantId,grantDigest:c.serviceGrantDigest(grant),outcome:{kind:'owner_outcome',frame:outcome}},grant,request));
}
for(const [name,result] of [
 ['both code signal',{kind:'process_exit',code:0,signal:1}], ['neither code signal',{kind:'process_exit',code:null,signal:null}],
 ['missing code',{kind:'process_exit',signal:1}],['signal zero',{kind:'process_exit',code:null,signal:0}],['signal 128',{kind:'process_exit',code:null,signal:128}],
 ['code 256',{kind:'process_exit',code:256,signal:null}],['served zero',{kind:'daemon_response',response:'ok',served:0,elapsedMs:0,cached:false}],
 ['elapsed unsafe',{kind:'daemon_response',response:'ok',served:1,elapsedMs:9007199254740992,cached:false}],
]) add(name,'outcome',frame({...baseOutcome,outcome:{admission:'accepted',execution:'returned',result,artifactManifestDigest:null}}));
for(const reason of ['transport_unavailable','transport_error','transport_closed','invalid_reply','reply_too_large','timeout','interrupted']) for(const attempted of [false,true]){
 const observation={kind:'client_observation',requestId:request.requestId,argumentDigest:request.argumentDigest,projectServiceKey:request.projectServiceKey,sourceGeneration:request.sourceGeneration,executionImageDigest:request.executionImage.imageDigest,delivery:attempted?'may_have_been_delivered':'not_attempted',execution:attempted?'unknown':'known_not_executed',reason};
 add('receipt '+reason+' '+attempted,'receipt',c.encodeServiceClientReceipt({schema:c.SERVICE_RECEIPT_SCHEMA,grantId:grant.grantId,grantDigest:c.serviceGrantDigest(grant),outcome:observation},grant,request));
 add('receipt contradiction '+reason+' '+attempted,'receipt',frame({schema:c.SERVICE_RECEIPT_SCHEMA,grantId:grant.grantId,grantDigest:c.serviceGrantDigest(grant),outcome:{...observation,execution:attempted?'known_not_executed':'unknown'}}));
}
for(const kind of ['bridge_request','bridge_reply','receipt']) {
 const good=cases.find(v=>v.kind===kind && v.canonical);const wire=Buffer.from(good.wire,'base64').toString();
 add(kind+' wrong grant id',kind,wire.replace(grant.grantId,'0'.repeat(64)));
 add(kind+' wrong grant digest',kind,wire.replace(c.serviceGrantDigest(grant),'0'.repeat(64)));
 add(kind+' unknown field',kind,wire.slice(0,-2)+',"extra":null}\n');
}
const digest=(file)=>require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const result={producer:'existing CLI dist, no build run by worker',distFiles:{'service-protocol.js':digest(path.join(root,'packages/caws-cli/dist/runtime/service-protocol.js')),'service-client.js':digest(path.join(root,'packages/caws-cli/dist/runtime/service-client.js'))},sourceFiles:{'service-protocol.ts':digest(path.join(root,'packages/caws-cli/src/runtime/service-protocol.ts')),'service-client.ts':digest(path.join(root,'packages/caws-cli/src/runtime/service-client.ts'))},grant:b64(c.encodeServiceGrant(grant)),request:b64(p.encodeRenderRequest(request)),cases};
if (!process.argv[2]) throw new Error('Pass the fixture output path explicitly');
fs.writeFileSync(process.argv[2],JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({cases:cases.length,accepted:cases.filter(c=>c.canonical).length,sourceFiles:result.sourceFiles}));
