import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {CloudGpuApi} from '../src/api.js';
import {BatchReceipts} from '../src/batch-receipts.js';import {prepareJobBatch,submitJobBatch,registerBatchTools} from '../src/job-batches.js';
const cfg={maxSpend:5,maxHours:2};const id=n=>'job_'+String(n).repeat(32);
function input(){return {batch_key:'owner-review',total_budget_usd:2,jobs:[1,2].map(n=>({quote_id:'quote_'+String(n).repeat(32),command:'printf secret_fixture_do_not_persist',max_spend_usd:1,max_hours:.5}))};}
const approval=p=>({...p,user_confirmed:true,approved_plan_sha256:prepareJobBatch(p,cfg).plan_sha256});
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'cgpu-receipt-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return {root,store:new BatchReceipts({root,apiKey:'synthetic-key-never-store',baseUrl:'https://example.invalid'})};}
async function files(dir){let all=[];for(const e of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())all.push(...await files(p));else all.push(p);}return all;}
test('new process/store recovers accepted IDs by GET, never another creation POST',async t=>{
 const {root,store}=await fixture(t);let creates=0,reads=0;const p=approval(input());const api={createJob:async()=>({id:id(++creates),status:'queued'}),job:async key=>{reads++;return {id:key,status:'running'};}};
 const a=await submitJobBatch(api,p,cfg,store);assert.equal(a.status,'submitted');assert.equal(creates,2);
 const b=await submitJobBatch(api,p,cfg,new BatchReceipts({root,apiKey:'synthetic-key-never-store',baseUrl:'https://example.invalid'}));assert.equal(b.status,'submitted');assert.equal(creates,2);assert.equal(reads,2);assert.deepEqual(b.items.map(x=>x.job_id),a.items.map(x=>x.job_id));
 const snap=await store.snapshot(p.batch_key);assert.equal(snap.items[0].local_state,'accepted');assert.equal(snap.live_status,false);
 const names=await files(root);for(const file of names){const text=await fs.readFile(file,'utf8');assert.doesNotMatch(text,/secret_fixture|synthetic-key-never-store|https:|printf|quote_/);assert.equal((await fs.stat(file)).mode&0o077,0);}
});
test('lost acknowledgement leaves intent, identical replay reconciles same key; changed plan refused before requests',async t=>{
 const {store}=await fixture(t);const rows=new Map();let calls=0,lost=true;
 const api={createJob:async(b,k)=>{calls++;if(!rows.has(k))rows.set(k,{id:id(rows.size+1),status:'queued'});if(lost){lost=false;throw Error('private exception');}return rows.get(k);},job:async key=>[...rows.values()].find(x=>x.id===key)};
 const p=approval(input());const a=await submitJobBatch(api,p,cfg,store);assert.equal(a.status,'submission_stopped');const snap=await store.snapshot(p.batch_key);assert.equal(snap.items[0].local_state,'submission_uncertain');assert.equal(snap.items[1].local_state,'not_observed_locally');
 const changed=input();changed.jobs[0].command='printf changed';await assert.rejects(submitJobBatch(api,approval(changed),cfg,store));assert.equal(calls,1);
 const b=await submitJobBatch(api,p,cfg,store);assert.equal(b.status,'submitted');assert.equal(rows.size,2);assert.equal(calls,3);assert.equal(b.items[0].idempotency_key,a.items[0].idempotency_key);
});
test('recorded Job unavailable or stopping never causes a replacement POST or advances batch',async t=>{
 const {store}=await fixture(t);const p=approval(input()),plan=prepareJobBatch(input(),cfg),h=await store.bind(plan);await h.intent(plan.items[0]);await h.accept(plan.items[0],{id:id(1),status:'queued'});
 for(const status of ['unavailable','stopping','needs_attention']){let posts=0;const api={createJob:async()=>{posts++;},job:async()=>{if(status==='unavailable')throw Error('network/private');return {id:id(1),status};}};
 const r=await submitJobBatch(api,p,cfg,store);assert.equal(posts,0);assert.notEqual(r.status,'submitted');assert.equal(r.items[0].job_id,id(1));assert.equal(r.not_submitted.length,1);}
});
test('account and endpoint isolation; read-only missing lookup creates no files',async t=>{
 const {root,store}=await fixture(t);await store.bind(prepareJobBatch(input(),cfg));
 for(const change of [{apiKey:'other'},{baseUrl:'https://other.invalid'}]){const other=new BatchReceipts({root,apiKey:'synthetic-key-never-store',baseUrl:'https://example.invalid',...change});assert.equal((await other.snapshot('owner-review')).found,false);}
 const missing=path.join(root,'missing'),s=new BatchReceipts({root:missing,apiKey:'key',baseUrl:'x'});assert.equal((await s.snapshot('new')).found,false);await assert.rejects(fs.stat(missing));
});
test('malformed, symlink or publicly-readable receipts fail closed before new spending',async t=>{
 for(const kind of ['malformed','symlink','permissions']){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cgpu-invalid-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const store=new BatchReceipts({root:dir,apiKey:'key',baseUrl:'x'});await store.bind(prepareJobBatch(input(),cfg));const p=(await files(dir)).find(x=>x.endsWith('plan.json'));
 if(kind==='malformed')await fs.writeFile(p,'broken');if(kind==='permissions')await fs.chmod(p,0o644);if(kind==='symlink'){await fs.unlink(p);await fs.symlink('/etc/hosts',p);}
 let calls=0;await assert.rejects(submitJobBatch({createJob:async()=>{calls++;}},approval(input()),cfg,store));assert.equal(calls,0);
 }
});
test('accepted response is returned if receipt persistence fails; no later Jobs submitted',async()=>{
 let calls=0;const ledger={bind:async()=>({accepted:async()=>null,intent:async()=>{},accept:async()=>{throw Error('disk full / private path');}})};
 const r=await submitJobBatch({createJob:async()=>({id:id(++calls),status:'queued'})},approval(input()),cfg,ledger);assert.equal(calls,1);assert.equal(r.status,'receipt_persistence_failed');assert.equal(r.items[0].job_id,id(1));assert.equal(r.not_submitted.length,1);assert.doesNotMatch(JSON.stringify(r),/disk full|private path/);
});
test('receipt cap refuses new batches without discarding unresolved evidence',async t=>{
 const {root}=await fixture(t),s=new BatchReceipts({root,apiKey:'key',baseUrl:'x',maxBatches:1});await s.bind(prepareJobBatch(input(),cfg));const p=input();p.batch_key='another';await assert.rejects(s.bind(prepareJobBatch(p,cfg)));assert.equal((await s.snapshot('owner-review')).found,true);
});

test('newly connected or rotated API key is used after tool registration',async t=>{
 const {root}=await fixture(t),prior=process.env.CLOUDGPU_CONFIG_DIR;process.env.CLOUDGPU_CONFIG_DIR=root;t.after(()=>{if(prior===undefined)delete process.env.CLOUDGPU_CONFIG_DIR;else process.env.CLOUDGPU_CONFIG_DIR=prior;});
 const tools=new Map(),api={apiKey:'',createJob:async()=>({id:id(1),status:'queued'})};
 registerBatchTools({registerTool:(name,schema,fn)=>tools.set(name,fn)},{api,cfg:{...cfg,apiKey:'',baseUrl:'https://example.invalid'},wrap:f=>f,ok:x=>x});api.apiKey='new-scoped-key';
 const p=input();p.jobs=p.jobs.slice(0,1);const r=await tools.get('run_job_batch')(approval(p));assert.equal(r.status,'submitted');assert.equal((await tools.get('get_job_batch_receipt')({batch_key:p.batch_key})).found,true);
 api.apiKey='different-scoped-key';assert.equal((await tools.get('get_job_batch_receipt')({batch_key:p.batch_key})).found,false);
});
test('concurrent immutable plan and acceptance writes retain a single accepted Job identity',async t=>{
 const {root}=await fixture(t),a=new BatchReceipts({root,apiKey:'key',baseUrl:'x'}),b=new BatchReceipts({root,apiKey:'key',baseUrl:'x'}),plan=prepareJobBatch(input(),cfg);
 const [x,y]=await Promise.all([a.bind(plan),b.bind(plan)]);await Promise.all([x.intent(plan.items[0]),y.intent(plan.items[0])]);await Promise.all([x.accept(plan.items[0],{id:id(1),status:'queued'}),y.accept(plan.items[0],{id:id(1),status:'running'})]);
 assert.equal((await a.snapshot('owner-review')).items[0].job_id,id(1));assert.equal((await files(root)).some(x=>x.includes('.tmp-')),false);
});

test('terminal recorded Job without final settlement stops further submissions',async t=>{
 const {store}=await fixture(t),plan=prepareJobBatch(input(),cfg),h=await store.bind(plan);await h.intent(plan.items[0]);await h.accept(plan.items[0],{id:id(1),status:'queued'});
 let posts=0;const r=await submitJobBatch({createJob:async()=>{posts++;},job:async()=>({id:id(1),status:'failed',cost_status:'accruing'})},approval(input()),cfg,store);assert.equal(posts,0);assert.equal(r.status,'reconciliation_required');assert.equal(r.items[0].job_id,id(1));
});

test('in-flight batch keeps the original account and endpoint after concurrent key rotation',async t=>{
 const {root}=await fixture(t);let calls=0,api;const fetchImpl=async(url,opts)=>{assert.equal(url,'https://example.invalid/v1/jobs');assert.equal(opts.headers.Authorization,'Bearer original-key');calls++;api.apiKey='rotated-key';api.baseUrl='https://other.invalid';return new Response(JSON.stringify({id:id(calls),status:'queued'}),{status:200,headers:{'Content-Type':'application/json'}});};
 api=new CloudGpuApi({apiKey:'original-key',baseUrl:'https://example.invalid',fetchImpl});const store=new BatchReceipts({root,apiKey:api.apiKey,baseUrl:api.baseUrl});const r=await submitJobBatch(api,approval(input()),cfg,store);assert.equal(r.status,'submitted');assert.equal(calls,2);assert.equal((await store.snapshot('owner-review')).items.length,2);assert.match(r.not_submitted_scope,/this_invocation_only/);
});
