// Explicit isolated candidate endpoint only. Real GPU edges are bounded by the separately approved bridge.
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const base=process.env.CGPU_ISOLATED_BASE;assert.equal(new URL(base).hostname,'127.0.0.1');
assert.equal(process.env.CGPU_D13_OWNER_BUDGET_USD,'1');
const root='/workspace/.cloudgpu-d13-joint';
const manifest=JSON.parse(await fs.readFile(root+'/manifest.json','utf8'));
const command=await fs.readFile(root+'/inference.sh','utf8');
const transport=new StdioClientTransport({command:process.execPath,args:['src/index.js'],env:{...process.env,CLOUDGPU_BASE_URL:base,CLOUDGPU_API_KEY:process.env.CGPU_ISOLATED_KEY,CLOUDGPU_MAX_SPEND_USD:'1'},stderr:'pipe'});transport.stderr?.on('data',()=>{});
const client=new Client({name:'d13-joint-acceptance',version:'1.0.0'});const active=new Set();const results=[];
async function call(name,args={}){const r=await client.callTool({name,arguments:args});assert.ok(!r.isError,'mcp_'+name+'_failed');return JSON.parse(r.content.filter(x=>x.type==='text').map(x=>x.text).join(''));}
async function wait(id){const deadline=Date.now()+9*60_000;let previous;while(Date.now()<deadline){const j=await call('get_job',{job_id:id});if(j.status!==previous){console.log(JSON.stringify({event:'job',id,status:j.status,error_code:j.error?.code}));previous=j.status;}if(['succeeded','failed','cancelled'].includes(j.status)){active.delete(id);return j;}assert.notEqual(j.status,'needs_attention','resource_uncertainty_stop');await new Promise(r=>setTimeout(r,5000));}throw Error('job_deadline');}
async function run(name,refs,cmd){const args={gpu_model:'RTX 4090',gpu_count:1,model_references:refs,command:cmd,max_hours:6/60,max_spend_usd:.2,user_confirmed:true,idempotency_key:'d13-joint-'+name+'-'+randomUUID()};const j=await call('run_job',args);active.add(j.id);const replay=await call('run_job',args);assert.equal(replay.id,j.id);const done=await wait(j.id);assert.equal(done.attempt,1);assert.equal(done.cost_status,'final');results.push({scenario:name,job_id:done.id,instance_id:done.instance_id,status:done.status,error_code:done.error?.code,cost_usd:done.cost_usd,model_references:done.model_references,output_tail:done.output_tail});return done;}
try{
 await client.connect(transport);
 const negative=JSON.parse(await fs.readFile('/workspace/artifacts/d13-joint-20261109/template-network-failure.json','utf8'));assert.equal(negative.results[0].status,'failed');assert.equal(negative.results[0].error_code,'model_load_failed');const prior=JSON.parse(await fs.readFile(root+'/state.json','utf8'));assert.equal(prior.orders.find(o=>o.id===negative.results[0].instance_id)?.status,'stopped');
 const first=await run('inference',manifest,command);assert.equal(first.status,'succeeded');assert.ok(first.output_tail.includes('D13_GPU_LINEAR_OK'));assert.deepEqual(first.model_references,manifest);
 const spec=await call('prepare_job_rerun',{job_id:first.id});assert.deepEqual(spec.model_references,manifest);assert.equal(spec.quote_id,undefined);assert.equal(spec.idempotency_key,undefined);
 const forbidden=await fetch(base+`/v1/jobs/${first.id}/rerun-spec`,{headers:{Authorization:'Bearer '+process.env.CGPU_ISOLATED_OTHER_KEY}});assert.equal(forbidden.status,404);await forbidden.body?.cancel();
 const repeated=await run('rerun',spec.model_references,spec.command);assert.equal(repeated.status,'succeeded');assert.notEqual(repeated.instance_id,first.instance_id);assert.ok(repeated.output_tail.includes('D13_GPU_LINEAR_OK'));
 await fs.writeFile(root+'/joint-results.json',JSON.stringify({status:'passed',cases:['actual_mcp_http_auth_mysql_models','idempotent_single_create','read_only_rerun_and_new_gpu','cross_user_denied','failure_release_recorded_in_prior_template_attempt'],results},null,2));console.log(JSON.stringify({status:'passed',results}));
}catch(e){await fs.writeFile(root+'/joint-results.json',JSON.stringify({status:'failed',failure_type:e.constructor.name,results},null,2));console.log(JSON.stringify({status:'failed',failure_type:e.constructor.name,results}));process.exitCode=1;}
finally{for(const id of active){try{await call('cancel_job',{job_id:id});}catch{console.log(JSON.stringify({cleanup:'needs_reconciliation',job_id:id}));}}await client.close().catch(()=>{});await transport.close().catch(()=>{});}
