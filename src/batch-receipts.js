// 本地受理回执：只保存哈希、Job ID与状态，不保存命令、凭证、签名URL或完整任务清单。
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {z} from 'zod';
import {configDir} from './credentials.js';
const sha=s=>createHash('sha256').update(s).digest('hex');
const states=z.enum(['queued','provisioning','running','stopping','needs_attention','succeeded','failed','cancelled']);
const key=z.string().regex(/^batch_[a-f0-9]{64}$/);
const meta=z.object({version:z.literal(1),plan_sha256:z.string().regex(/^[a-f0-9]{64}$/),total_budget_usd:z.number().positive(),item_keys:z.array(key).min(1).max(8)}).strict();
const intent=z.object({version:z.literal(1),index:z.number().int().min(0).max(7),idempotency_key:key}).strict();
const accepted=intent.extend({job_id:z.string().regex(/^job_[a-f0-9]{32}$/),status_at_acceptance:states}).strict();
const safeError=()=>new Error('Local batch receipt is unavailable or inconsistent. No replacement key or GPU may be created; retain the original manifest and reconcile existing Jobs.');
async function directory(p,create=false){
 try{const s=await fs.lstat(p);if(s.isSymbolicLink()||!s.isDirectory()||(s.mode&0o077)!==0||(process.getuid&&s.uid!==process.getuid()))throw safeError();}
 catch(e){if(e.code!=='ENOENT'||!create)throw e;await fs.mkdir(p,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});return directory(p);}
}
async function read(p,schema){
 let f;try{f=await fs.open(p,constants.O_RDONLY|constants.O_NOFOLLOW);const s=await f.stat();if(!s.isFile()||s.size>8192||(s.mode&0o077)!==0||(process.getuid&&s.uid!==process.getuid()))throw safeError();return schema.parse(JSON.parse(await f.readFile('utf8')));}
 catch(e){if(e.code==='ENOENT')return null;throw safeError();}finally{await f?.close();}
}
// 独立不可变文件避免进程退出或并发覆盖已受理ID。后端幂等仍是创建资源的最终防线。
async function put(p,value,schema,equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b)){
 schema.parse(value);
 const tmp=p+'.tmp-'+randomBytes(12).toString('hex');let f;
 try{
  f=await fs.open(tmp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  await f.writeFile(JSON.stringify(value)+'\n');await f.sync();await f.close();f=null;
  try{await fs.link(tmp,p);}catch(e){if(e.code!=='EEXIST')throw e;const old=await read(p,schema);if(!equal(old,value))throw safeError();}
  const d=await fs.open(path.dirname(p),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await d.sync();}finally{await d.close();}
 }catch{throw safeError();}finally{await f?.close();await fs.unlink(tmp).catch(()=>{});}
}

export class BatchReceipts{
 constructor({apiKey,baseUrl,root=configDir(),maxBatches=1024}){this.apiKey=apiKey;this.root=root;this.scope=sha(String(baseUrl||'https://cloudgpu.app')+'\0'+String(apiKey||''));this.maxBatches=maxBatches;}
 async locate(batchKey,create){
  if(!this.apiKey)throw Error('Connect the original scoped account before reading or submitting a batch receipt. Never paste the key into chat.');
  if(!/^[A-Za-z0-9_-]{1,80}$/.test(batchKey))throw Error('Invalid batch key');
  // 配置目录由用户选择；回执树及下级目录必须为当前用户私有，拒绝符号链接。
  if(create)await fs.mkdir(this.root,{recursive:true,mode:0o700}).catch(()=>{throw safeError();});
  const base=path.join(this.root,'batch-receipts-v1');
  try{await directory(base,create);}catch(e){if(e.code==='ENOENT')return null;throw safeError();}
  const scope=path.join(base,this.scope);
  try{await directory(scope,create);}catch(e){if(e.code==='ENOENT')return null;throw safeError();}
  const dir=path.join(scope,sha(batchKey));
  try{await directory(dir,false);}catch(e){if(e.code!=='ENOENT')throw safeError();if(!create)return null;
   if((await fs.readdir(scope).catch(()=>{throw safeError();})).length>=this.maxBatches)throw Error('Local batch receipt limit reached. Archive verified terminal receipts explicitly; do not discard uncertain receipts.');
   await directory(dir,true);
  }
  return dir;
 }
 async bind(plan){
  const dir=await this.locate(plan.batch_key,true);
  const value={version:1,plan_sha256:plan.plan_sha256,total_budget_usd:plan.total_budget_usd,item_keys:plan.items.map(x=>x.idempotency_key)};
  await put(path.join(dir,'plan.json'),value,meta);
  return this.handle(dir,value);
 }
 handle(dir,value){return {
  accepted:async index=>{const row=await read(path.join(dir,index+'.accepted.json'),accepted);if(row&&(row.index!==index||row.idempotency_key!==value.item_keys[index]))throw safeError();return row;},
  intent:async item=>put(path.join(dir,item.index+'.intent.json'),{version:1,index:item.index,idempotency_key:item.idempotency_key},intent),
  accept:async(item,job)=>{
   const p=path.join(dir,item.index+'.accepted.json'),row={version:1,index:item.index,idempotency_key:item.idempotency_key,job_id:job.id,status_at_acceptance:job.status};
   const prior=await read(p,accepted);if(prior){if(prior.job_id!==job.id||prior.idempotency_key!==item.idempotency_key)throw safeError();return;}
   await put(p,row,accepted,(a,b)=>a?.job_id===b.job_id&&a?.idempotency_key===b.idempotency_key&&a?.index===b.index);
  },
 };}
 async snapshot(batchKey){
  const dir=await this.locate(batchKey,false);
  if(!dir)return {found:false,items:[],note:'No local receipt was found. This does not prove that a GPU was never created; older clients or another key/device may hold the receipt.'};
  const value=await read(path.join(dir,'plan.json'),meta);if(!value)throw safeError();const h=this.handle(dir,value),items=[];
  for(let i=0;i<value.item_keys.length;i++){
   const a=await h.accepted(i),n=await read(path.join(dir,i+'.intent.json'),intent);if(n&&(n.index!==i||n.idempotency_key!==value.item_keys[i]))throw safeError();
   items.push({index:i,idempotency_key:value.item_keys[i],job_id:a?.job_id??null,local_state:a?'accepted':n?'submission_uncertain':'not_observed_locally',observed_status_at_acceptance:a?.status_at_acceptance??null});
  }
  return {found:true,plan_sha256:value.plan_sha256,total_budget_usd:value.total_budget_usd,items,live_status:false,execution_retries:0,note:'Private local metadata only, scoped to the original key and API endpoint. Query get_job_batch for live status. Resume only the identical approved manifest; no absent local entry proves non-creation. No automatic execution retry or durable server batch coordinator.'};
 }
}
