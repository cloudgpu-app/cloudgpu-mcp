import test from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {jobInputShape} from '../src/job-input.js';
import {prepareJobBatch} from '../src/job-batches.js';

// Small, deterministic regression: count element visits instead of exhausting memory.
test('oversized constrained arrays reject before visiting invalid elements',()=>{
 let visits=0;
 const schema=z.array(z.preprocess(x=>{visits++;return x;},z.string())).max(8);
 const result=schema.safeParse(Array(9).fill(0));
 assert.equal(result.success,false);assert.equal(visits,0);
 assert.equal(result.error.issues.length,1);assert.equal(result.error.issues[0].code,'too_big');
 assert.deepEqual(schema.parse(['ok']),['ok']);assert.equal(visits,1);
});
test('nested shipped model file schema rejects with one issue',()=>{
 const schema=z.object(jobInputShape({maxSpend:50,maxHours:24}));
 const base={gpu_model:'RTX 4090',command:'true',max_spend_usd:1,max_hours:1,user_confirmed:true,idempotency_key:'test',model_references:[{name:'model',repo_id:'a/b',revision:'a'.repeat(40),files:Array(33).fill({})}]};
 const parsed=schema.safeParse(base);
 assert.equal(parsed.success,false);
 const files=parsed.error.issues.filter(i=>i.path.includes('files'));
 assert.equal(files.length,1);assert.equal(files[0].code,'too_big');
});
async function withServer(fn){
 // Mock *all* HTTP in the child. Nothing can reach CloudGPU or a supplier.
 const mock=`globalThis.fetch=async(url,opts)=>new Response(JSON.stringify({mocked:true,path:new URL(url).pathname,body:opts.body?JSON.parse(opts.body):null}),{status:200,headers:{'content-type':'application/json'}});`;
 const transport=new StdioClientTransport({command:process.execPath,args:['--import','data:text/javascript,'+encodeURIComponent(mock),'src/index.js'],env:{...process.env,CLOUDGPU_API_KEY:'synthetic-limit-test',CLOUDGPU_BASE_URL:'http://127.0.0.1:1',CLOUDGPU_READ_ONLY:'0'},stderr:'pipe'});
 transport.stderr?.on('data',()=>{});
 const client=new Client({name:'resource-regression',version:'1.0.0'});
 try{await client.connect(transport);await fn(client);}finally{await client.close().catch(()=>{});await transport.close().catch(()=>{});}
}
test('actual stdio rejects arrays and records before handlers, stays responsive, and preserves populated records',async()=>withServer(async client=>{
 for(const args of [
  {model_references:[{}],workflow:{nodes:Array(10000).fill(null)}},
  {model_references:[{}],workflow:Object.fromEntries(Array.from({length:10000},(_,i)=>['k'+i,null]))},
  {model_references:[{files:Array(10000).fill({})}]},
 ]){
  const r=await client.callTool({name:'prepare_model_deployment',arguments:args});
  assert.equal(r.isError,true);assert.match(r.content[0].text,/maximum of 10000 elements/);assert.doesNotMatch(r.content[0].text,/mocked/);
 }
 const args={model_references:[{name:'checkpoints',files:[{path:'model.safetensors'}]}],workflow:{'1':{class_type:'LoadImage',inputs:{image:'a.png'}}}};
 const ok=await client.callTool({name:'prepare_model_deployment',arguments:args});
 assert.ok(!ok.isError,JSON.stringify(ok));const echoed=JSON.parse(ok.content[0].text);assert.equal(echoed.mocked,true);assert.deepEqual(echoed.body,args);
 // 3 root/nesting members + 9997 leaf members = exactly 10000, then one over.
 const boundary={model_references:[{}],workflow:Object.fromEntries(Array.from({length:9997},(_,i)=>['k'+i,null]))};
 assert.ok(!(await client.callTool({name:'prepare_model_deployment',arguments:boundary})).isError);
 boundary.workflow.extra=null;
 const over=await client.callTool({name:'prepare_model_deployment',arguments:boundary});assert.equal(over.isError,true);assert.match(over.content[0].text,/maximum of 10000 elements/);
 const unknown=await client.callTool({name:'prepare_model_deployment',arguments:{...args,unexpected:true}});assert.equal(unknown.isError,true);
 const local=await client.callTool({name:'prepare_task_template',arguments:{template_id:'gpu-check'}});assert.ok(!local.isError,JSON.stringify(local));
}));
test('maximum nested eight-job batch remains below the common ceiling and preserves plan hash',async()=>withServer(async client=>{
 const jobs=Array.from({length:8},(_,i)=>({gpu_model:'RTX 4090',command:'printf done',quote_id:'quote_'+String(i).repeat(32),max_spend_usd:1,max_hours:0.1,model_references:Array.from({length:4},(_,j)=>({name:'m'+j,repo_id:'a/b',revision:'a'.repeat(40),files:Array.from({length:32},(_,k)=>({path:'f'+k,size_bytes:1,sha256:'b'.repeat(64)}))})),outputs:{files:Array.from({length:16},(_,k)=>'out'+k),max_bytes:1024,accept_storage_charges:false}}));
 const args={batch_key:'max-batch',total_budget_usd:8,jobs};
 const expected=prepareJobBatch(args,{maxSpend:50,maxHours:24});
 // Captured from the published 0.16.5/Zod 3 baseline; existing approvals stay valid.
 assert.equal(expected.plan_sha256,'0375ab949acf3f81b58dc41531857192d9b890af0a42087aa285fee138de91de');
 const result=await client.callTool({name:'prepare_job_batch',arguments:args});
 assert.ok(!result.isError,JSON.stringify(result));assert.equal(JSON.parse(result.content[0].text).plan_sha256,expected.plan_sha256);
}));
