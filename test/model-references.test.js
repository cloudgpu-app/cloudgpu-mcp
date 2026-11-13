import test from "node:test";
import assert from "node:assert/strict";
import {resolveModelReference} from "../src/model-references.js";
import {CloudGpuApi} from "../src/api.js";
const input={repo_id:"org/model",name:"model",files:["config.json"]};
const sha="a".repeat(40);
test("pin public revision and available SHA without credentials", async()=>{
 let call;const result=await resolveModelReference(input,async(url,opts)=>{call={url,opts};return new Response(JSON.stringify({sha,siblings:[{rfilename:"config.json",size:3,lfs:{size:3,sha256:"b".repeat(64)}}]}));});
 assert.equal(result.revision,sha);assert.equal(result.files[0].size_bytes,3);assert.equal(result.files[0].sha256,"b".repeat(64));assert.equal(call.opts.headers.Authorization,undefined);assert.equal(call.opts.redirect,"error");assert.match(call.url,/^https:\/\/huggingface.co\/api\/models\/org\/model\/revision\/main/);
});
test("bad repo, traversal, duplicate file and revision are rejected before network",async()=>{
 for(const value of [{...input,repo_id:"https://evil"},{...input,files:["../secret"]},{...input,files:["x","x"]},{...input,revision:"a/b"}])await assert.rejects(()=>resolveModelReference(value,()=>assert.fail("network")));
});
test("missing/private/oversized metadata cannot become a model manifest",async()=>{
 await assert.rejects(()=>resolveModelReference(input,async()=>new Response("",{status:403})));
 await assert.rejects(()=>resolveModelReference(input,async()=>new Response(JSON.stringify({sha,siblings:[]}))));
 await assert.rejects(()=>resolveModelReference(input,async()=>new Response(" ".repeat(2*1024*1024+1))));
});
test("rerun preparation is GET only, not create or stale key replay",async()=>{
 const calls=[];const api=new CloudGpuApi({apiKey:"test",fetchImpl:async(url,opts)=>{calls.push({url,opts});return {ok:true,text:async()=>JSON.stringify({command:"echo",max_minutes:5})};}});
 await api.jobRerunSpec("job_123");assert.equal(calls.length,1);assert.equal(calls[0].opts.method,"GET");assert.equal(calls[0].opts.body,undefined);assert.equal(calls[0].opts.headers["Idempotency-Key"],undefined);assert.match(calls[0].url,/\/v1\/jobs\/job_123\/rerun-spec$/);
});
test("model deployment preparation does not call an instance creation endpoint",async()=>{
 let call;const api=new CloudGpuApi({apiKey:"test",fetchImpl:async(url,opts)=>{call={url,opts};return {ok:true,text:async()=>JSON.stringify({starts_gpu:false,template_id:"flux-1-dev",setup_script:"echo test"})};}});
 const result=await api.prepareModelDeployment({model_references:[]});assert.equal(result.starts_gpu,false);assert.match(call.url,/\/v1\/jobs\/prepare-model-deployment$/);assert.equal(call.opts.method,"POST");assert.equal(call.opts.headers["Idempotency-Key"],undefined);
});
test("older backend cannot silently ignore model references and start an unprepared job",async()=>{
 const calls=[];const api=new CloudGpuApi({apiKey:"test",fetchImpl:async(url,opts)=>{calls.push({url,opts});return {ok:true,text:async()=>JSON.stringify({jobs:true,model_registry:false})};}});
 await assert.rejects(()=>api.createJob({command:"echo",model_references:[{name:"model"}]},"new-key"),e=>e.code==="model_references_unavailable");
 assert.equal(calls.length,1);assert.equal(calls[0].opts.method,"GET");assert.equal(calls[0].opts.headers.Authorization,undefined);
});
test("gated model metadata is refused before any GPU submission",async()=>{
 await assert.rejects(()=>resolveModelReference(input,async()=>new Response(JSON.stringify({sha,gated:"manual",siblings:[{rfilename:"config.json",size:3}]}))),/gated/);
});
test('small JSON config is hashed from pinned origin without downloading weights or forwarding credentials',async()=>{
 const calls=[];
 const result=await resolveModelReference({...input,files:['config.json','weights.bin']},async(url,opts)=>{
  calls.push({url,opts});
  if(calls.length===1)return new Response(JSON.stringify({sha,siblings:[{rfilename:'config.json',size:2},{rfilename:'weights.bin',size:123}]}));
  assert.equal(url,`https://huggingface.co/org/model/raw/${sha}/config.json`);
  assert.equal(opts.headers.Authorization,undefined);assert.equal(opts.redirect,'error');return new Response('{}');
 });
 assert.equal(calls.length,2);assert.equal(result.files[0].sha256,'44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
 assert.equal(result.files[1].sha256,undefined);
});
test('config hashing refuses short or oversized origin content',async()=>{
 for(const content of ['x','xxxx']){
  let calls=0;
  await assert.rejects(()=>resolveModelReference(input,async()=>++calls===1?new Response(JSON.stringify({sha,siblings:[{rfilename:'config.json',size:2}]})):new Response(content)),/size mismatch/);
 }
});
test('config hashing has a bounded file count and never fetches oversized JSON',async()=>{
 const files=Array.from({length:9},(_,i)=>`config${i}.json`);let calls=0;
 await assert.rejects(()=>resolveModelReference({...input,files},async()=>{calls++;return new Response(JSON.stringify({sha,siblings:files.map(rfilename=>({rfilename,size:2}))}));}),/Too many/);
 assert.equal(calls,1);
 calls=0;const result=await resolveModelReference(input,async()=>{calls++;return new Response(JSON.stringify({sha,siblings:[{rfilename:'config.json',size:4*1024*1024+1}]}));});
 assert.equal(calls,1);assert.equal(result.files[0].sha256,undefined);
});
