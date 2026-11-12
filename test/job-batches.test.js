import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareJobBatch,submitJobBatch,getJobBatch} from '../src/job-batches.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const cfg={maxSpend:10,maxHours:2};
const job=(n=1)=>({command:'printf done',quote_id:'quote_'+String(n).repeat(32),max_spend_usd:1,max_hours:0.5});
const input=()=>({batch_key:'reviewed-batch',total_budget_usd:3,jobs:[job(1),job(2),job(3)]});
const approved=p=>({...p,user_confirmed:true,approved_plan_sha256:prepareJobBatch(p,cfg).plan_sha256});
const id=n=>'job_'+String(n).repeat(32);
test('preparation binds exact quote/command/storage choices, stable keys and exact decimal budget',()=>{
 const p=input(),a=prepareJobBatch(p,cfg),b=prepareJobBatch(p,cfg);assert.deepEqual(a,b);assert.equal(a.starts_gpu,false);assert.equal(a.reserved_maximum_usd,3);assert.equal(a.items[0].body.max_minutes,30);assert.equal(a.items[0].body.max_hours,undefined);assert.equal(new Set(a.items.map(i=>i.idempotency_key)).size,3);
 const fractional={...p,total_budget_usd:0.3,jobs:[{...job(),max_spend_usd:0.1},{...job(),max_spend_usd:0.2}]};assert.equal(prepareJobBatch(fractional,cfg).reserved_maximum_usd,0.3);
 const changed=structuredClone(p);changed.jobs[0].command='printf changed';assert.notEqual(prepareJobBatch(changed,cfg).plan_sha256,a.plan_sha256);assert.equal(prepareJobBatch(changed,cfg).items[0].idempotency_key,a.items[0].idempotency_key);
});
test('all Jobs are validated before the first API call; approval or plan changes cannot spend',async()=>{
 let calls=0;const api={createJob:async()=>{calls++;return {id:id(1),status:'queued'};}};
 const p=input();
 for(const invalid of [{...p,user_confirmed:false},{...approved(p),approved_plan_sha256:'0'.repeat(64)},{...approved(p),jobs:[job(),{...job(),max_hours:3}]},{...approved(p),total_budget_usd:2},{...approved(p),total_budget_usd:11},{...approved(p),jobs:[{...job(),command:'pkill -f cgpu-watchdog'}]}])await assert.rejects(submitJobBatch(api,invalid,cfg));
 assert.equal(calls,0);
 for(const invalid of [{...p,jobs:[]},{...p,jobs:Array.from({length:9},()=>job())},{...p,batch_key:'key\nunsafe'},{...p,jobs:[{...job(),quote_id:'old'}]},{...p,jobs:[{...job(),idempotency_key:'caller-changed'}]},{...p,jobs:[{...job(),max_spend_usd:0.0000001}]}])assert.throws(()=>prepareJobBatch(invalid,cfg));
});
test('a lost acknowledgement stops the batch; identical replay creates each Job at most once',async()=>{
 const rows=new Map();let resources=0,lost=true,posts=0;
 const api={createJob:async(body,key)=>{posts++;if(!rows.has(key))rows.set(key,{id:id(++resources),status:'queued',body:structuredClone(body)});else assert.deepEqual(rows.get(key).body,body);if(resources===2&&lost){lost=false;throw Error('response lost with a private token');}return rows.get(key);}};
 const p=approved(input());const first=await submitJobBatch(api,p,cfg);assert.equal(first.status,'submission_stopped');assert.equal(first.items.length,2);assert.equal(first.items[1].status,'submission_uncertain');assert.equal(first.not_submitted.length,1);assert.equal(resources,2);assert.doesNotMatch(JSON.stringify(first),/private token/);
 const second=await submitJobBatch(api,p,cfg);assert.equal(second.status,'submitted');assert.equal(resources,3);assert.equal(posts,5);assert.equal(second.items[0].job_id,first.items[0].job_id);assert.equal(second.items[1].idempotency_key,first.items[1].idempotency_key);assert.equal(second.execution_retries,0);
 const third=await submitJobBatch(api,p,cfg);assert.equal(third.status,'submitted');assert.equal(resources,3);
});
test('release uncertainty, malformed responses and API rejection never advance to another GPU',async()=>{
 for(const response of [{id:id(1),status:'needs_attention'},{id:id(1),status:'stopping'},{id:id(1),status:'unknown'},{id:'malformed',status:'queued'},null]){
  let calls=0;const api={createJob:async()=>{calls++;return response;}};const result=await submitJobBatch(api,approved(input()),cfg);assert.equal(calls,1);assert.notEqual(result.status,'submitted');assert.equal(result.not_submitted.length,2);
 }
 let calls=0;const result=await submitJobBatch({createJob:async()=>{calls++;throw Error('quote expired');}},approved(input()),cfg);assert.equal(calls,1);assert.equal(result.items[0].status,'submission_uncertain');assert.equal(result.execution_retries,0);
});
test('actual MCP to local REST preserves submission keys after a lost response and never duplicates a GPU',async()=>{
 const rows=new Map();let posts=0,resources=0,lost=false;
 const server=http.createServer(async(req,res)=>{
  assert.equal(req.headers.authorization,'Bearer example-batch-key');
  if(req.method==='POST'&&req.url==='/v1/jobs'){
   posts++;let text='';for await(const b of req)text+=b;const body=JSON.parse(text),key=req.headers['idempotency-key'];assert.ok(key);assert.equal(body.max_minutes,30);assert.equal(body.user_confirmed,undefined);
   if(!rows.has(key))rows.set(key,{id:id(++resources),status:'queued'});
   if(resources===2&&!lost){lost=true;req.socket.destroy();return;}
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify(rows.get(key)));return;
  }
  const j=[...rows.values()].find(j=>req.url==='/v1/jobs/'+j.id);
  if(j){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({...j,cost_usd:0,cost_status:'accruing'}));return;}
  res.writeHead(404);res.end('{}');
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const receiptDir=await fs.mkdtemp(path.join(os.tmpdir(),'cgpu-batch-'));
 const transport=new StdioClientTransport({command:process.execPath,args:['src/index.js'],env:{...process.env,CLOUDGPU_CONFIG_DIR:receiptDir,CLOUDGPU_API_KEY:'example-batch-key',CLOUDGPU_BASE_URL:'http://127.0.0.1:'+server.address().port,CLOUDGPU_READ_ONLY:'0'},stderr:'pipe'});transport.stderr?.on('data',()=>{});const client=new Client({name:'batch-rest-test',version:'1'});
 try{
  await client.connect(transport);const call=async(name,args)=>{const r=await client.callTool({name,arguments:args});assert.ok(!r.isError,r.content[0].text);return JSON.parse(r.content[0].text);};
  const p=input();const plan=await call('prepare_job_batch',p);const request={...p,user_confirmed:true,approved_plan_sha256:plan.plan_sha256};
  const first=await call('run_job_batch',request);assert.equal(first.status,'submitted');assert.equal(resources,3);assert.equal(posts,4);
  const replay=await call('run_job_batch',request);assert.deepEqual(replay.items,first.items);assert.equal(resources,3);assert.equal(posts,4);
  const state=await call('get_job_batch',{job_ids:first.items.map(i=>i.job_id)});assert.equal(state.all_terminal,false);assert.equal(state.requires_reconciliation,false);assert.equal(state.automatic_retry_allowed,false);
  await client.close();await transport.close();
  const restartedTransport=new StdioClientTransport({command:process.execPath,args:['src/index.js'],env:{...process.env,CLOUDGPU_CONFIG_DIR:receiptDir,CLOUDGPU_API_KEY:'example-batch-key',CLOUDGPU_BASE_URL:'http://127.0.0.1:'+server.address().port,CLOUDGPU_READ_ONLY:'0'},stderr:'pipe'});restartedTransport.stderr?.on('data',()=>{});
  const restarted=new Client({name:'batch-after-process-exit',version:'1'});
  try{await restarted.connect(restartedTransport);const saved=await restarted.callTool({name:'get_job_batch_receipt',arguments:{batch_key:p.batch_key}});const local=JSON.parse(saved.content[0].text);assert.equal(local.found,true);assert.deepEqual(local.items.map(x=>x.job_id),first.items.map(x=>x.job_id));
   const resumed=await restarted.callTool({name:'run_job_batch',arguments:request});assert.ok(!resumed.isError,resumed.content[0].text);assert.equal(JSON.parse(resumed.content[0].text).status,'submitted');assert.equal(posts,4);assert.equal(resources,3);
  }finally{await restarted.close().catch(()=>{});await restartedTransport.close().catch(()=>{});}

 }finally{await client.close().catch(()=>{});await transport.close().catch(()=>{});server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(receiptDir,{recursive:true,force:true});}
});
test('batch status never equates missing or unfamiliar state with release, success or a retry',async()=>{
 const api={job:async key=>key===id(1)?{id:key,status:'failed',cost_usd:0.1,cost_status:'final'}:key===id(2)?{id:key,status:'needs_attention'}:{id:key,status:'unknown'}};
 const r=await getJobBatch(api,[id(1),id(2),id(3)]);assert.equal(r.all_terminal,false);assert.equal(r.requires_reconciliation,true);assert.equal(r.items[2].status,'unavailable');assert.equal(r.items[0].automatic_retry_allowed,false);
 await assert.rejects(getJobBatch(api,[id(1),id(1)]));
});
test('actual read-only MCP exposes batch preparation/monitoring but cannot submit paid batches',async()=>{
 const transport=new StdioClientTransport({command:process.execPath,args:['src/index.js'],env:{...process.env,CLOUDGPU_API_KEY:'',CLOUDGPU_BASE_URL:'http://127.0.0.1:1',CLOUDGPU_READ_ONLY:'1'},stderr:'pipe'});transport.stderr?.on('data',()=>{});const client=new Client({name:'batch-boundary-test',version:'1'});
 try{await client.connect(transport);const {tools}=await client.listTools();assert.equal(tools.find(t=>t.name==='run_job_batch'),undefined);assert.equal(tools.find(t=>t.name==='prepare_job_batch').annotations.readOnlyHint,true);
  const r=await client.callTool({name:'prepare_job_batch',arguments:input()});assert.ok(!r.isError);assert.equal(JSON.parse(r.content[0].text).starts_gpu,false);
 }finally{await client.close().catch(()=>{});await transport.close().catch(()=>{});}
});
