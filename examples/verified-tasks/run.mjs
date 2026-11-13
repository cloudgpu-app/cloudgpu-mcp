// Local dry-run by default. Submission requires current owner approval.
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {CloudGpuApi} from '../../src/api.js';
import {PersistentStorage} from '../../src/storage.js';
import {loadStoredKey} from '../../src/credentials.js';
const dir=path.dirname(fileURLToPath(import.meta.url));
const cases=JSON.parse(await fs.readFile(path.join(dir,'cases.json'),'utf8'));
const name=process.argv[2];if(!Object.hasOwn(cases,name))throw Error('Choose gpu-environment, causal-lora or comfy-wan-video.');
const {script,interpreter,...request}=cases[name];if(!['python3','bash'].includes(interpreter)||path.basename(script)!==script)throw Error('Invalid bundled script');
const bytes=await fs.readFile(path.join(dir,script));
request.command=`${interpreter} -c "$(printf '%s' '${bytes.toString('base64')}' | base64 -d)"`;
if(Buffer.byteLength(request.command)>32768)throw Error('Command exceeds Job limit');
const summary={case:name,gpu_model:request.gpu_model,template:request.template||null,max_minutes:request.max_minutes,max_spend_usd:request.max_spend_usd,script_sha256:createHash('sha256').update(bytes).digest('hex')};
if(process.env.CGPU_SUBMIT!=='YES'){
 console.log(JSON.stringify({...summary,submitted:false,next:'Review script, current quote and storage terms. Submit with CGPU_SUBMIT=YES and a stable new CGPU_JOB_KEY. Resume a known Job with CGPU_JOB_ID.'},null,2));
}else{
 const api=new CloudGpuApi({apiKey:process.env.CLOUDGPU_API_KEY||loadStoredKey()?.api_key});
 let job;
 if(process.env.CGPU_JOB_ID){
  if(!/^job_[a-f0-9]{32}$/.test(process.env.CGPU_JOB_ID))throw Error('Invalid existing Job ID');
  job=await api.job(process.env.CGPU_JOB_ID);
 }else{
  const key=process.env.CGPU_JOB_KEY;if(!/^[A-Za-z0-9._:-]{1,128}$/.test(key||''))throw Error('A stable new submission key is required.');
  const quote=await api.quote({requirements:{gpu_model:request.gpu_model,gpu_count:request.gpu_count,...(request.template?{template:request.template}:{})},estimated_duration_seconds:request.max_minutes*60,max_budget_usd:request.max_spend_usd});
  if(!quote.id||!quote.candidates?.some(c=>c.supports_jobs&&c.within_budget&&c.can_start_with_balance))throw Error('No eligible bounded Job candidate; nothing submitted.');
  request.quote_id=quote.id;job=await api.createJob(request,key);
 }
 console.log(JSON.stringify({...summary,job_id:job.id,status:job.status,next:'Retain this Job ID. Resume this same Job after interruption. An uncertain initial submission requires reconciliation; do not generate a replacement key or GPU.'}));
 const deadline=Date.now()+(request.max_minutes*60+900)*1000;
 while(!['succeeded','failed','cancelled','needs_attention'].includes(job.status)||job.cost_status!=='final'){
  if(job.status==='needs_attention'||Date.now()>=deadline)throw Error(`Reconcile existing Job ${job.id}; no replacement submitted.`);
  await new Promise(resolve=>setTimeout(resolve,5000));job=await api.job(job.id);
 }
 if(job.status!=='succeeded'||job.output_collection?.status!=='succeeded')throw Error(`Existing Job ${job.id} ended without complete output delivery; inspect it before any new submission.`);
 const files=job.output_collection.files,allowed=new Set(request.outputs.files);
 if(files.length!==allowed.size||new Set(files.map(f=>f.path)).size!==allowed.size||files.some(f=>!allowed.has(f.path)||path.basename(f.path)!==f.path||f.status!=='ready'))throw Error('Unexpected output manifest');
 const root=path.resolve(process.env.CGPU_RESULTS_DIR||path.join('cloudgpu-results',job.id));await fs.mkdir(root,{recursive:true,mode:0o700});
 const info=await fs.lstat(root);if(info.isSymbolicLink()||!info.isDirectory()||(info.mode&0o077))throw Error('Results directory must be private');
 const storage=new PersistentStorage(api),verified=[];
 for(const file of files){
  const destination=path.join(root,file.path);
  try{const previous=await fs.lstat(destination);if(previous.isSymbolicLink()||!previous.isFile())throw Error('Unsafe existing result target');}catch(e){if(e.code!=='ENOENT')throw e;}
  await storage.download(file.file_id,destination);await fs.chmod(destination,0o600);
  const sha=await storage.digest(destination),stat=await fs.stat(destination);
  if(stat.size!==file.size_bytes||sha!==file.sha256)throw Error('Downloaded output integrity mismatch');
  verified.push({path:file.path,size_bytes:stat.size,sha256:sha,local_file:destination});
 }
 console.log(JSON.stringify({case:name,job_id:job.id,status:'succeeded',cost_usd:job.cost_usd,cost_status:job.cost_status,total_elapsed_seconds:job.finished_at-job.created_at,transfer_method:job.output_collection.transfer_method||'direct_object_storage',outputs:verified,platform_release_recorded:true,independent_upstream_release:'See the published internal acceptance evidence; platform status alone is not an upstream health probe.'}));
}
