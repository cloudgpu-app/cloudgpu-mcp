import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareJobBatch,submitServerJobBatch} from '../src/job-batches.js';
import {CloudGpuApi} from '../src/api.js';
const cfg={maxSpend:10,maxHours:2};
const job=n=>({gpu_model:'RTX 4090',command:'printf done',quote_id:'quote_'+String(n).repeat(32),max_spend_usd:1,max_hours:0.1});
const input=()=>({batch_key:'durable-case',total_budget_usd:2,jobs:[job(1),job(2)]});
const approve=p=>({...p,user_confirmed:true,approved_plan_sha256:prepareJobBatch(p,cfg).plan_sha256});
const receipt={batch_id:'a'.repeat(32),durable:true,jobs:[{id:'job_'+'1'.repeat(32),status:'queued'},{id:'job_'+'2'.repeat(32),status:'queued'}]};
test('server batch validates approval, immutable plan, cap and hourly consent before any API call',async()=>{
 let calls=0;const api={createServerJobBatch:async()=>{calls++;return receipt;}};const p=approve(input());
 for(const bad of [{...p,user_confirmed:false},{...p,approved_plan_sha256:'0'.repeat(64)},{...p,total_budget_usd:11}])await assert.rejects(submitServerJobBatch(api,bad,cfg));
 const unpaid=input();unpaid.jobs[0].billing_quote_id='11111111-2222-3333-4444-555555555555';await assert.rejects(submitServerJobBatch(api,approve(unpaid),cfg),/billing period/);
 const duplicate=input();for(const j of duplicate.jobs){j.billing_quote_id='11111111-2222-3333-4444-555555555555';j.billing_accepted=true;}
 await assert.rejects(submitServerJobBatch(api,approve(duplicate),cfg),/own accepted/);assert.equal(calls,0);
});
test('a lost acknowledgement only replays the same atomic request and key, with no individual-job fallback',async()=>{
 const posts=[];let lost=true;
 const api={createServerJobBatch:async(body,key)=>{posts.push({body,key});if(lost){lost=false;throw Error('connection lost');}return structuredClone(receipt);},createJob:async()=>{assert.fail('must never fall back to partial submission');}};
 const p=approve(input());await assert.rejects(submitServerJobBatch(api,p,cfg));const result=await submitServerJobBatch(api,p,cfg);
 assert.deepEqual(posts[0],posts[1]);assert.equal(posts[0].key,'server-batch:durable-case');assert.equal(posts[0].body.total_budget_usd,2);assert.equal(posts[0].body.jobs[0].max_minutes,6);assert.equal(posts.length,2);assert.equal(result.atomic_enqueue,true);assert.equal(result.automatic_command_retries,false);
});
test('fresh hourly billing identity and explicit consent reach the durable request unchanged',async()=>{
 const p=input();p.jobs[0].billing_quote_id='11111111-2222-3333-4444-555555555555';p.jobs[0].billing_accepted=true;
 let body;await submitServerJobBatch({createServerJobBatch:async b=>{body=b;return receipt;}},approve(p),cfg);
 assert.equal(body.jobs[0].billing_quote_id,p.jobs[0].billing_quote_id);assert.equal(body.jobs[0].billing_accepted,true);
});
test('old backend capability cannot trigger any partial paid POST',async()=>{
 const calls=[];const api=new CloudGpuApi({apiKey:'synthetic',baseUrl:'https://example.invalid',fetchImpl:async(url,opts)=>{calls.push({url,method:opts.method});return new Response(JSON.stringify({durable_batch:{enabled:false}}),{status:200,headers:{'content-type':'application/json'}});}});
 await assert.rejects(api.createServerJobBatch({jobs:[{}]},'stable'),/Durable batch/);assert.equal(calls.length,1);assert.equal(calls[0].method,'GET');
});
test('server batch URLs reject arbitrary paths before HTTP',async()=>{
 const api=new CloudGpuApi({apiKey:'synthetic',fetchImpl:()=>assert.fail('HTTP not allowed')});
 assert.throws(()=>api.serverJobBatch('../jobs'));assert.throws(()=>api.cancelServerJobBatch('https://evil.invalid'));
});
