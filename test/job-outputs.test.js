import test from 'node:test';
import assert from 'node:assert/strict';
import {CloudGpuApi} from '../src/api.js';
const body={command:'echo ok > "$CLOUDGPU_OUTPUT_DIR/result.txt"',outputs:{files:['result.txt'],max_bytes:100}};
function setup(caps) {
 const calls=[];return {calls,api:new CloudGpuApi({apiKey:'test-key',fetchImpl:async(url,opts)=>{
  calls.push({url,opts});return {ok:true,text:async()=>JSON.stringify(opts.method==='GET'?caps:{id:'job_mock',outputs:JSON.parse(opts.body).outputs})};
 }})};
}
test('output requests are rejected on old or storage-disabled backends without submitting',async()=>{
 for(const caps of [{jobs:true},{automatic_output_collection:true,storage:false},{storage:true,automatic_output_collection:false}]){
  const {api,calls}=setup(caps);await assert.rejects(()=>api.createJob(body,'new-key'),e=>e.code==='outputs_unavailable');
  assert.equal(calls.length,1);assert.equal(calls[0].opts.method,'GET');assert.equal(calls[0].opts.headers.Authorization,undefined);
 }
});
test('output configuration and same idempotency key reach the enabled backend unchanged',async()=>{
 const {api,calls}=setup({storage:true,automatic_output_collection:true});const result=await api.createJob(body,'same-key');
 assert.deepEqual(result.outputs,body.outputs);assert.equal(calls.length,2);assert.equal(calls[1].opts.headers['Idempotency-Key'],'same-key');
 assert.equal(JSON.parse(calls[1].opts.body).outputs.accept_storage_charges,undefined);
});
test('combined models and outputs do not bypass either capability',async()=>{
 const {api,calls}=setup({storage:true,automatic_output_collection:true,model_references:false});
 await assert.rejects(()=>api.createJob({...body,model_references:[{}]},'key'),e=>e.code==='model_references_unavailable');assert.equal(calls.length,1);
});
