// 轻量 D14：只保存已结束 Job 的有限输出，不访问 GPU、不增加 GPU 等待时间。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {PersistentStorage} from './storage.js';
const terminal=new Set(['succeeded','failed','cancelled']);
const idSchema=z.string().regex(/^job_[a-f0-9]{32}$/);
const locks=new Map();
function assertId(id){if(!/^job_[a-f0-9]{32}$/.test(id))throw Error('Invalid Job ID.');}
// Inspect bounded decoded views but preserve the original safe log byte-for-byte.
// This is a conservative refusal filter, not proof that arbitrary log content is secret-free.
const credentialField=/(?:^|[^A-Za-z0-9_])["']?[A-Za-z0-9_.-]*(?:password|passwd|pwd|passphrase|secret|client[_-]?secret|secret[_-]?(?:access[_-]?)?key|api[_-]?key|access[_-]?key(?:[_-]?id)?|aws[_-]?(?:access[_-]?key[_-]?id|secret[_-]?access[_-]?key|session[_-]?token)|(?:access|refresh|id|auth|session|csrf|xsrf)[_-]?token|token|authorization|proxy[_-]?authorization|cookie|set[_-]?cookie|x[_-]?(?:api[_-]?key|auth[_-]?token))["']?\s*[:=]\s*(?=\S)/i;
const credentialForms=[credentialField,/-----BEGIN [^-]*PRIVATE KEY-----/i,/\bsk-[A-Za-z0-9_-]{16,}/,/\b(?:Bearer|Basic)\s+[A-Za-z0-9_+/.=-]{8,}/i,/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,/https?:\/\/[^\s"'<>]*\?[^\s"'<>]*/i,/https?:\/\/[^/\s"'<>@]+@/i];
function decodedTailView(text){
 const named={quot:'"',apos:"'",colon:':',equals:'=',amp:'&',sol:'/',quest:'?'};
 return text.normalize('NFKC')
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'')
  .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g,'')
  .replace(/\\u([0-9a-f]{4})|\\x([0-9a-f]{2})|\\(["'\\/:=])/gi,(_m,u,x,c)=>u?String.fromCharCode(parseInt(u,16)):x?String.fromCharCode(parseInt(x,16)):c)
  .replace(/(?:%[0-9a-f]{2})+/gi,part=>Buffer.from(part.replaceAll('%',''),'hex').toString('utf8'))
  .replace(/&#(x[0-9a-f]+|[0-9]+);|&(quot|apos|colon|equals|amp|sol|quest);/gi,(_m,n,name)=>{
   if(name)return named[name.toLowerCase()];const value=n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):parseInt(n,10);
   if(value>0x10ffff)throw Error('Output normalization is unsafe; nothing was uploaded.');return String.fromCodePoint(value);
  });
}
export function checkedTail(text,apiKey){
 if(typeof text!=='string'||Buffer.byteLength(text)>16384)throw Error('Job output tail exceeds the bounded snapshot limit.');
 let view=text;
 for(let depth=0;depth<5;depth++){
  if((apiKey&&apiKey.length>=4&&view.includes(apiKey))||credentialForms.some(re=>re.test(view)))throw Error('Output may contain credentials or a signed URL. Sanitize it before saving; nothing was uploaded.');
  const next=decodedTailView(view);
  if(Buffer.byteLength(next)>65536)throw Error('Output normalization exceeds the bounded snapshot limit.');
  if(next===view)return text;
  view=next;
 }
 throw Error('Output normalization is too deeply encoded; nothing was uploaded.');
}
export async function diagnoseJob(api,id){
 assertId(id);const job=await api.job(id);const code=job.error?.code||null;
 let observed='not_checked';if(job.instance_id){try{const r=await api.instance(job.instance_id);observed=String(r.status);}catch{observed='unavailable';}}
 const groups={model_load_failed:'model_preparation',workspace_restore_failed:'workspace_restore',workspace_unavailable:'workspace_restore',command_failed:'command_execution',instance_unreachable:'connectivity',command_lost:'execution_lost',insufficient_balance:'funding',cannot_create:'provisioning'};
 let category=job.status==='needs_attention'?'release_uncertainty':groups[code]||(job.status==='succeeded'?'completed':'inspect_job');
 return {job_id:job.id,status:job.status,category,error_code:code,observed_instance_status:observed,
  supplier_release_verified:false,cost_usd:job.cost_usd,cost_status:job.cost_status,
  cost_note:job.cost_status==='final'?'Final platform Job charge.':'Unsettled; may include preauthorisation and refunds not yet applied.',
  automatic_retry_allowed:false,next:category==='release_uncertainty'?'Stop and ask support to reconcile resources; do not create another GPU.':job.status==='succeeded'?'Reuse the Workspace and parameters only after a fresh quote and explicit budget approval.':'Inspect the error and remaining resources. Do not blame user code or rerun automatically; obtain a fresh quote and approval for a new Job.'};
}
async function saveOne(api,storage,id,acceptCharges){
 const job=await api.job(id);if(!terminal.has(job.status))throw Error('Wait until the Job has ended; no running GPU will be changed.');
 const logs=await api.jobLogs(id);const tail=checkedTail(logs.tail??job.output_tail??'',api.apiKey);
 const content=JSON.stringify({object:'job_output_tail',job_id:job.id,status:job.status,tail_only:true,complete_output:false,output_tail:tail},null,2)+'\n';
 const sha=createHash('sha256').update(content).digest('hex');const name=`${id}-${sha.slice(0,16)}.json`;
 // 同一客户端串行保存并核验已有内容。跨进程不承诺exactly-once。
 const files=(await api.request('GET','/v1/files')).data||[];
 const existing=files.find(f=>f.name===name&&f.purpose==='artifact'&&f.status==='ready'&&Number(f.size_bytes)===Buffer.byteLength(content));
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cgpu-job-output-'));
 try{
  const local=path.join(dir,'output.json');
  if(existing){await storage.download(existing.file_id,local);if(createHash('sha256').update(await fs.readFile(local)).digest('hex')!==sha)throw Error('Existing snapshot does not match; inspect it before saving another.');return {file_id:existing.file_id,reused:true,tail_only:true,complete_output:false,sha256:sha};}
  await fs.writeFile(local,content,{mode:0o600});const saved=await storage.upload(local,'artifact',name,acceptCharges===true);
  return {...saved,reused:false,tail_only:true,complete_output:false,sha256:sha};
 }finally{await fs.rm(dir,{recursive:true,force:true});}
}
export async function saveJobOutput(api,storage,id,confirmed,acceptCharges=false){
 assertId(id);if(confirmed!==true)throw Error('Ask the user before storing Job output.');
 const previous=locks.get(id)||Promise.resolve();const current=previous.catch(()=>{}).then(()=>saveOne(api,storage,id,acceptCharges));locks.set(id,current);
 try{return await current;}finally{if(locks.get(id)===current)locks.delete(id);}
}
export function registerJobResultTools(server,{api,wrap,ok,readOnly}){
 const storage=new PersistentStorage(api);
 server.registerTool('diagnose_job',{title:'Inspect Job failure and cost state',description:'Read-only Job diagnosis and observed platform instance state. Never creates, stops or retries a GPU. Does not claim supplier release verification or classify every command failure as user error.',inputSchema:{job_id:idSchema},annotations:{readOnlyHint:true,openWorldHint:true}},wrap(async({job_id})=>ok(await diagnoseJob(api,job_id))));
 if(readOnly)return;
 server.registerTool('save_job_output',{title:'Save ended Job output tail',description:'With approval, persist the ended Job log tail as a small Artifact using existing storage quota and retention. This is not the full log or binary output collection. Refuses recognizable credentials, quoted/aliased fields and bounded escaped representations or queried URLs. This is not a guarantee that arbitrary logs contain no secrets; save only logs you know are sanitized. Never touches GPU resources. Reuses a matching verified snapshot when found; cross-client concurrent calls may create duplicates.',inputSchema:{job_id:idSchema,user_confirmed:z.boolean(),accept_storage_charges:z.boolean().default(false)},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true}},wrap(async({job_id,user_confirmed,accept_storage_charges})=>ok(await saveJobOutput(api,storage,job_id,user_confirmed,accept_storage_charges))));
}
