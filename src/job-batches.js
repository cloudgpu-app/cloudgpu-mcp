// D17第一阶段：复用现有持久化Job队列。部分提交可恢复，不伪装成原子事务。
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {CloudGpuApi} from './api.js';
import {BatchReceipts} from './batch-receipts.js';
import {jobInputShape} from './job-input.js';
import {checkCommand} from './guards.js';
const sha=value=>createHash('sha256').update(value).digest('hex');
function stable(value){if(Array.isArray(value))return '['+value.map(stable).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).filter(k=>value[k]!==undefined).sort().map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')+'}';return JSON.stringify(value);}
function micros(value){const s=String(value);if(!/^\d+(?:\.\d{1,6})?$/.test(s))throw Error('Budgets require at most six decimal places');const [whole,decimal='']=s.split('.');return BigInt(whole)*1000000n+BigInt(decimal.padEnd(6,'0'));}
function schema(cfg){return z.object({
 batch_key:z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/),
 total_budget_usd:z.number().positive(),
 jobs:z.array(z.object(jobInputShape(cfg)).omit({user_confirmed:true,idempotency_key:true}).extend({quote_id:z.string().regex(/^quote_[a-f0-9]{32}$/)}).strict()).min(1).max(8),
}).strict();}
function bodyOf(item){const {max_hours,...rest}=item;return {...rest,max_minutes:Math.ceil(max_hours*60)};}
export function prepareJobBatch(raw,cfg){
 const p=schema(cfg).parse(raw);const cap=micros(p.total_budget_usd);
 if(cap>micros(cfg.maxSpend))throw Error('Batch total exceeds this client spending cap');
 let reserved=0n;
 const items=p.jobs.map((job,index)=>{
  if(job.max_hours>cfg.maxHours||micros(job.max_spend_usd)>micros(cfg.maxSpend))throw Error('Job exceeds client budget or time cap');
  const refused=checkCommand(job.command);if(refused)throw Error(refused);
  reserved+=micros(job.max_spend_usd);
  return {index,idempotency_key:'batch_'+sha(p.batch_key+':'+index),body:bodyOf(job)};
 });
 if(reserved>cap)throw Error('Sum of per-Job maximum spending exceeds the approved batch budget');
 const plan_sha256=sha(stable(p));
 return {preparation_only:true,starts_gpu:false,batch_key:p.batch_key,plan_sha256,total_budget_usd:p.total_budget_usd,reserved_maximum_usd:Number(reserved)/1e6,items,
  atomic:false,execution_retries:0,scope:'GPU Job spending caps only; separately approved storage charges are additional. Immutable manifest; unused GPU budget is not automatically reassigned.',
  next:'Review every command, GPU quote, time limit and storage choice. Retain this exact manifest, plan hash and batch key. Submission may partially succeed; resume the identical manifest, never invent new keys after a lost response.'};
}
export async function submitJobBatch(api,raw,cfg,receipts=null){
 // 固定本次批量调用的凭证/端点，避免并行connect或轮换让重试跨账户。
 if(api instanceof CloudGpuApi)api=new CloudGpuApi({apiKey:api.apiKey,baseUrl:api.baseUrl,fetchImpl:api.fetch,userAgent:api.userAgent});
 const {approved_plan_sha256,user_confirmed,...input}=raw;
 if(user_confirmed!==true)throw Error('Obtain explicit approval for all Jobs and the aggregate budget before submission');
 const plan=prepareJobBatch(input,cfg);
 if(approved_plan_sha256!==plan.plan_sha256)throw Error('The approved batch manifest changed; review it again before submitting');
 const journal=receipts?await receipts.bind(plan):null;
 const results=[];
 for(const item of plan.items){
  let known;
  if(journal){
   try{known=await journal.accepted(item.index);if(!known)await journal.intent(item);}
   catch{return receipt('receipt_unavailable',results,item.index);}
  }
  try{
   const job=known?await api.job(known.job_id):await api.createJob(item.body,item.idempotency_key);
   if(known&&job?.id!==known.job_id)throw Error('Mismatched recorded Job');
   if(!job||!/^job_[a-f0-9]{32}$/.test(job.id)||!['queued','provisioning','running','stopping','needs_attention','succeeded','failed','cancelled'].includes(job.status))throw Error('Invalid submission response');
   results.push({index:item.index,idempotency_key:item.idempotency_key,job_id:job.id,status:job.status});
   if(journal&&!known){try{await journal.accept(item,job);}catch{return receipt('receipt_persistence_failed',results,item.index+1);}}
   if(job.status==='needs_attention'||job.status==='stopping'||(journal&&['succeeded','failed','cancelled'].includes(job.status)&&job.cost_status!=='final'))return receipt('reconciliation_required',results,item.index+1);
  }catch{
   // Even a server error may follow an accepted create. Never turn uncertainty into another GPU.
   results.push({index:item.index,idempotency_key:item.idempotency_key,job_id:known?.job_id??null,status:known?'status_unavailable':'submission_uncertain'});
   return receipt('submission_stopped',results,item.index+1);
  }
 }
 return receipt('submitted',results,plan.items.length);
 function receipt(status,items,next){return {batch_key:plan.batch_key,plan_sha256:plan.plan_sha256,status,atomic:false,total_budget_usd:plan.total_budget_usd,items,not_submitted_scope:'this_invocation_only; entries may already exist from an earlier invocation',not_submitted:plan.items.slice(next).map(i=>({index:i.index,idempotency_key:i.idempotency_key})),execution_retries:0,local_receipts_enabled:!!journal,next:status==='submitted'?'Poll get_job_batch. A failed command is not automatically retried.':'Reconcile or replay only the identical approved manifest with the same batch key. No automatic new-attempt retry or cancellation was performed.'};}
}
export async function getJobBatch(api,ids){
 z.array(z.string().regex(/^job_[a-f0-9]{32}$/)).min(1).max(8).parse(ids);
 if(new Set(ids).size!==ids.length)throw Error('Job IDs must be distinct');
 const items=[];
 for(const id of ids){try{const j=await api.job(id);if(j.id!==id||!['queued','provisioning','running','stopping','needs_attention','succeeded','failed','cancelled'].includes(j.status))throw Error('Unrecognized Job response');items.push({job_id:id,status:j.status,cost_usd:j.cost_usd??null,cost_status:j.cost_status??null,automatic_retry_allowed:false,release_risk:j.status==='needs_attention'||j.status==='stopping'});}catch{items.push({job_id:id,status:'unavailable',automatic_retry_allowed:false,release_risk:true});}}
 return {items,all_terminal:items.every(j=>['succeeded','failed','cancelled'].includes(j.status)),requires_reconciliation:items.some(j=>j.release_risk),automatic_retry_allowed:false,note:'Status and costs come from the existing Job API. Terminal state is not an independent supplier audit; stopping, needs_attention or unavailable must never trigger a new GPU.'};
}
export async function submitServerJobBatch(api,raw,cfg){
 if(api instanceof CloudGpuApi)api=new CloudGpuApi({apiKey:api.apiKey,baseUrl:api.baseUrl,fetchImpl:api.fetch,userAgent:api.userAgent});
 const {approved_plan_sha256,user_confirmed,...input}=raw;
 if(user_confirmed!==true)throw Error('Approve every command, billing period and the aggregate budget first');
 const plan=prepareJobBatch(input,cfg);
 if(approved_plan_sha256!==plan.plan_sha256)throw Error('Approved batch manifest changed');
 const quoteIds=new Set();
 for(const item of plan.items)if(item.body.billing_quote_id){
  if(item.body.billing_accepted!==true)throw Error('Accept the exact source billing period and minimum first');
  if(quoteIds.has(item.body.billing_quote_id))throw Error('Each hourly allocation requires its own accepted billing quote');quoteIds.add(item.body.billing_quote_id);
 }
 const result=await api.createServerJobBatch({total_budget_usd:plan.total_budget_usd,jobs:plan.items.map(i=>i.body)},'server-batch:'+plan.batch_key);
 if(!/^[a-f0-9]{32}$/.test(result?.batch_id)||result.durable!==true||!Array.isArray(result.jobs)||result.jobs.length!==plan.items.length||result.jobs.some(j=>!/^job_[a-f0-9]{32}$/.test(j.id)))
  throw Error('Unrecognized batch receipt; reconcile with the identical manifest/key before retrying');
 return {...result,batch_key:plan.batch_key,plan_sha256:plan.plan_sha256,atomic_enqueue:true,automatic_command_retries:false,next:'Use get_server_job_batch. Never replace an uncertain or failed task automatically; the same approved key replays this batch.'};
}

export function registerBatchTools(server,{api,cfg,wrap,ok}){
 const input=schema(cfg);
 const receipts=()=>new BatchReceipts({apiKey:'apiKey' in api?api.apiKey:cfg.apiKey,baseUrl:api.baseUrl||cfg.baseUrl});
 server.registerTool('get_job_batch_receipt',{title:'Read a private local batch receipt',description:'Read only saved accepted Job IDs and uncertain submission intents for the original batch key, API key and endpoint. No API request or GPU creation. Local state is historical, not live release evidence; a missing entry does not prove non-creation. Commands, tokens and signed URLs are never stored.',inputSchema:{batch_key:z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/)},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},wrap(async({batch_key})=>ok(await receipts().snapshot(batch_key))));
 server.registerTool('prepare_job_batch',{title:'Review a bounded Job batch',description:'Local, read-only preparation for up to eight Jobs with fresh per-Job quotes and one aggregate cap. No API requests, reservations, installations or automatic execution retries. Retain the immutable plan hash and batch key.',inputSchema:input.shape,annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},wrap(async p=>ok(prepareJobBatch(p,cfg))));
 server.registerTool('get_job_batch',{title:'Inspect a Job batch',description:'Read-only status and cost summary for explicit Job IDs. Does not retry, cancel, create or claim independent supplier release verification.',inputSchema:{job_ids:z.array(z.string().regex(/^job_[a-f0-9]{32}$/)).min(1).max(8)},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true}},wrap(async({job_ids})=>ok(await getJobBatch(api,job_ids))));
 server.registerTool('get_server_job_batch',{title:'Read a durable server batch',description:'Read persisted child Job states and costs after either client or server restarts. Does not create or retry resources.',inputSchema:{batch_id:z.string().regex(/^[a-f0-9]{32}$/)},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true}},wrap(async({batch_id})=>ok(await api.serverJobBatch(batch_id))));
 if(cfg.readOnly)return;
 server.registerTool('run_server_job_batch',{title:'Atomically enqueue an approved server batch',description:'Paid. Use the exact reviewed prepare_job_batch manifest/hash. Enqueue is atomic and persists on the server; each Job reserves its own budget and waits for account/key concurrency. No automatic command retries and no partial client-side fallback. Whole-hour Jobs require a separate accepted current billing quote per allocation.',inputSchema:{...input.shape,approved_plan_sha256:z.string().regex(/^[a-f0-9]{64}$/),user_confirmed:z.boolean()},annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:true}},wrap(async p=>ok(await submitServerJobBatch(api,p,cfg))));
 server.registerTool('cancel_server_job_batch',{title:'Cancel a server batch',description:'Cancel queued children without starting a GPU; request safe shutdown of active children. Preserve outputs first. Previously started whole-hour charges remain payable.',inputSchema:{batch_id:z.string().regex(/^[a-f0-9]{32}$/),user_confirmed:z.boolean()},annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:true}},wrap(async({batch_id,user_confirmed})=>{if(user_confirmed!==true)throw Error('Confirm output preservation and cancellation first');return ok(await api.cancelServerJobBatch(batch_id));}));
 server.registerTool('run_job_batch',{title:'Submit an approved bounded Job batch',description:'Paid: submit an explicitly approved immutable manifest using existing durable Jobs, each with a quote, budget and deadline. Aggregate worst-case budget is capped. Partial success is possible. On lost responses replay the IDENTICAL manifest/key; never create replacement GPUs or retry failed execution automatically. Persist the returned receipt. No transaction rollback or independent batch scheduler.',inputSchema:{...input.shape,approved_plan_sha256:z.string().regex(/^[a-f0-9]{64}$/),user_confirmed:z.boolean()},annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:true}},wrap(async p=>ok(await submitJobBatch(api,p,cfg,receipts()))));
}
