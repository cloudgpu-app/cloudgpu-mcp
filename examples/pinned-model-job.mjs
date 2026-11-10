// Dry-run by default. No dependencies beyond Node and this repository's REST client.
// Example: CLOUDGPU_API_KEY=... node examples/pinned-model-job.mjs org/model main config.json
// To submit, explicitly set CGPU_SUBMIT=YES plus CGPU_GPU, CGPU_BUDGET_USD, CGPU_MAX_MINUTES,
// CGPU_COMMAND and CGPU_JOB_KEY. Reuse the SAME key only to retry this SAME submission.
import {resolveModelReference} from '../src/model-references.js';
import {CloudGpuApi} from '../src/api.js';
const [repo_id,revision='main',...files]=process.argv.slice(2);
if(!repo_id||!files.length)throw new Error('Provide repository, revision and explicit model files');
const model=await resolveModelReference({repo_id,revision,name:'model',files});
if(process.env.CGPU_SUBMIT!=='YES'){
 console.log(JSON.stringify({model_references:[model],next:'Dry run only. Choose the full model file set, compatible GPU image, command, budget and time limit before explicit submission. Files will be in $CLOUDGPU_MODEL_DIR/model. No GPU created.'},null,2));
}else{
 const {CGPU_GPU:gpu_model,CGPU_BUDGET_USD:budget,CGPU_MAX_MINUTES:minutes,CGPU_COMMAND:command,CGPU_JOB_KEY:key}=process.env;
 if(!gpu_model||!command||!key||!(Number(budget)>0)||!Number.isInteger(Number(minutes))||Number(minutes)<1)throw new Error('Explicit GPU, command, new submission key, positive budget and integer minutes are required');
 const api=new CloudGpuApi({apiKey:process.env.CLOUDGPU_API_KEY});
 const quote=await api.quote({requirements:{gpu_model,gpu_count:1},estimated_duration_seconds:Number(minutes)*60,max_budget_usd:Number(budget)});
 const body={gpu_model,gpu_count:1,command,max_minutes:Number(minutes),max_spend_usd:Number(budget),quote_id:quote.id,model_references:[model]};
 if(!body.quote_id)throw new Error('Quote did not return quote_id; no Job submitted');
 if(process.env.CGPU_WORKSPACE_VERSION)body.workspace_version_id=process.env.CGPU_WORKSPACE_VERSION;
 const job=await api.createJob(body,key);
 console.log(JSON.stringify({job_id:job.id,status:job.status,next:'Poll get_job until terminal; inspect release evidence and cost. To run again, prepare_job_rerun, obtain a new quote/approval, then use a NEW submission key. Output is not automatically persisted.'},null,2));
}
