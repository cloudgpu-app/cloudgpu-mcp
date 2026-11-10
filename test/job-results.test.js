import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {checkedTail,diagnoseJob,saveJobOutput,registerJobResultTools} from '../src/job-results.js';
const id='job_'+'a'.repeat(32);
function fixture(){
 const files=[],contents=new Map(),calls=[];let lastLocal;
 const api={apiKey:'synthetic-account-key',job:async()=>({id,status:'succeeded',cost_usd:.01,cost_status:'final'}),jobLogs:async()=>({tail:'{"answer":42}'}),request:async(method,url)=>{calls.push([method,url]);assert.equal(method,'GET');assert.equal(url,'/v1/files');return {data:files};}};
 const storage={upload:async(local,purpose,name,paid)=>{lastLocal=local;calls.push(['upload',paid]);assert.equal(purpose,'artifact');const content=await fs.readFile(local);contents.set('file_result',content);const f={file_id:'file_result',name,purpose,status:'ready',size_bytes:content.length};files.push(f);return f;},download:async(file,local)=>{lastLocal=local;await fs.writeFile(local,contents.get(file));}};
 return {api,storage,calls,files,get lastLocal(){return lastLocal;}};
}
test('output snapshot is bounded, marked tail-only and reuses verified content under concurrent calls',async()=>{
 const f=fixture();const results=await Promise.all([saveJobOutput(f.api,f.storage,id,true),saveJobOutput(f.api,f.storage,id,true)]);
 assert.deepEqual(results.map(x=>x.reused),[false,true]);assert.equal(results[0].complete_output,false);assert.equal(f.calls.filter(x=>x[0]==='upload').length,1);assert.equal(f.calls.find(x=>x[0]==='upload')[1],false);await assert.rejects(()=>fs.stat(f.lastLocal),/ENOENT/);
});
test('saving requires approval before any API call and cannot save running output',async()=>{
 const f=fixture();f.api.job=()=>assert.fail('no API before approval');await assert.rejects(()=>saveJobOutput(f.api,f.storage,id,false),/Ask the user/);
 f.api.job=async()=>({id,status:'running'});await assert.rejects(()=>saveJobOutput(f.api,f.storage,id,true),/ended/);assert.equal(f.calls.length,0);
});
test('credential-like output and signed URLs never reach file upload',async()=>{
 for(const text of ['synthetic-account-key','sk-'+ 'x'.repeat(24),'password=secret','https://object.invalid/a?X-Amz-Signature=secret','-----BEGIN PRIVATE KEY-----']){
  const f=fixture();f.api.jobLogs=async()=>({tail:text});await assert.rejects(()=>saveJobOutput(f.api,f.storage,id,true),/credentials|signed URL/);assert.equal(f.calls.length,0);
 }
 assert.throws(()=>checkedTail('x'.repeat(16385)),/bounded/);
});
test('storage disabled and upload failure never stop or recreate any GPU; temp file removed',async()=>{
 const f=fixture();f.api.request=async()=>{throw Error('storage_not_enabled');};await assert.rejects(()=>saveJobOutput(f.api,f.storage,id,true),/storage_not_enabled/);
 f.api.request=async()=>({data:[]});let local;f.storage.upload=async p=>{local=p;throw Error('quota_exceeded');};await assert.rejects(()=>saveJobOutput(f.api,f.storage,id,true),/quota_exceeded/);await assert.rejects(()=>fs.stat(local),/ENOENT/);
});
test('storage charges need literal consent and mismatched existing snapshot is refused',async()=>{
 const f=fixture();await saveJobOutput(f.api,f.storage,id,true,'true');assert.equal(f.calls.find(x=>x[0]==='upload')[1],false);
 f.storage.download=async(_id,p)=>fs.writeFile(p,'tampered');await assert.rejects(()=>saveJobOutput(f.api,f.storage,id,true),/does not match/);assert.equal(f.calls.filter(x=>x[0]==='upload').length,1);
});
test('diagnosis does not infer supplier release or charge finality from terminal Job alone',async()=>{
 const f=fixture();f.api.job=async()=>({id,status:'failed',instance_id:'123',error:{code:'command_failed'},cost_usd:.39,cost_status:'accruing'});f.api.instance=async()=>({status:'stopped'});
 const r=await diagnoseJob(f.api,id);assert.equal(r.category,'command_execution');assert.equal(r.supplier_release_verified,false);assert.equal(r.automatic_retry_allowed,false);assert.match(r.cost_note,/preauthorisation/);assert.match(r.next,/Do not blame user/);
 f.api.job=async()=>({id,status:'needs_attention'});assert.equal((await diagnoseJob(f.api,id)).category,'release_uncertainty');
});
test('read-only server exposes diagnosis only; write tool has explicit consent and no idempotency guarantee',()=>{
 const tools=new Map();registerJobResultTools({registerTool:(n,s,f)=>tools.set(n,{s,f})},{api:{},wrap:f=>f,ok:x=>x,readOnly:true});assert.deepEqual([...tools.keys()],['diagnose_job']);
 tools.clear();registerJobResultTools({registerTool:(n,s,f)=>tools.set(n,{s,f})},{api:{},wrap:f=>f,ok:x=>x,readOnly:false});assert.equal(tools.get('save_job_output').s.annotations.idempotentHint,false);
});

test('credential aliases, JSON keys and encoded representations are refused before any storage operation',async()=>{
 const secret='synthetic-private-value';
 const examples=[
  JSON.stringify({password:secret}),JSON.stringify({Authorization:`Bearer ${secret}`}),`{'token':'${secret}'}`,
  `DB_PASSWORD=${secret}`,JSON.stringify({database_password:secret}),JSON.stringify({databasePassword:secret}),`access_token=${secret}`,`refreshToken=${secret}`,`clientSecret=${secret}`,`AWS_SECRET_ACCESS_KEY=${secret}`,
  `Cookie: session=${secret}`,`Set-Cookie: sid=${secret}; Secure`, `Bearer ${secret}`,`Basic c3ludGhldGljOnNlY3JldA==`,
  '{"pass\\u0077ord":"'+secret+'"}', '"{\\"password\\":\\"'+secret+'\\"}"',
  encodeURIComponent(`password=${secret}`),encodeURIComponent(encodeURIComponent(`access_token=${secret}`)),
  encodeURIComponent(`https://object.invalid/a?sig=${secret}`),`https://user:${secret}@object.invalid/a`,
  `password&#61;${secret}`,`pass\u200bword=${secret}`,`pass\x1b[31mword\x1b[0m=${secret}`,
 ];
 for(const text of examples){
  const f=fixture();f.api.jobLogs=async()=>({tail:text});
  await assert.rejects(()=>saveJobOutput(f.api,f.storage,id,true),/credentials|signed URL|normalization/);
  assert.equal(f.calls.length,0,'unsafe tail must be refused before list/download/upload');
 }
});
test('safe structured logs remain byte-identical and non-secret metric names are allowed',()=>{
 for(const value of ['{"answer":42}','https://example.invalid/results','token_count=128 api_key_count=3','{"password_strength":"strong"}','模型执行完成\nloss=0.01','request_id=ok %FF','{"text":"hello\\nworld"}'])assert.equal(checkedTail(value),value);
});

test('encoded current key, bounded normalization and output-tail fallback are checked before storage',async()=>{
 const f=fixture();f.api.jobLogs=async()=>({});f.api.job=async()=>({id,status:'failed',output_tail:'{"DB_PASSWORD":"synthetic-private-value"}'});
 await assert.rejects(()=>saveJobOutput(f.api,f.storage,id,true),/credentials/);assert.equal(f.calls.length,0);
 assert.throws(()=>checkedTail([...Buffer.from('synthetic-account-key')].map(b=>'%'+b.toString(16).padStart(2,'0')).join(''),'synthetic-account-key'),/credentials/);
 let nested='password=synthetic-private-value';for(let i=0;i<8;i++)nested=encodeURIComponent(nested);
 assert.throws(()=>checkedTail(nested),/credentials|normalization/);
});
