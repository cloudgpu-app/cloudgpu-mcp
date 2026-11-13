import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {checkCommand} from './guards.js';
import {checkedTail} from './job-results.js';

const input=z.object({
 steps:z.array(z.object({id:z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/).refine(v=>v.trim()===v),command:z.string().min(1).max(4096)}).strict()).min(1).max(8),
 workspace_version_id:z.string().regex(/^wsv_[a-f0-9]{32}$/).refine(v=>v.trim()===v).optional(),
 persist_summary:z.boolean().default(false),
}).strict();
const program=fs.readFileSync(new URL('./recipes/task-pipeline.py',import.meta.url),'utf8');
export function prepareTaskPipeline(raw,apiKey='') {
 const p=input.parse(raw);
 if(new Set(p.steps.map(s=>s.id)).size!==p.steps.length)throw Error('Pipeline step IDs must be unique.');
 for(const step of p.steps) {
  if(!step.command.trim()||step.command.includes('\0'))throw Error('Pipeline commands must be nonempty and contain no NUL.');
  const refused=checkCommand(step.command);if(refused)throw Error(refused);
  try{checkedTail(step.command,apiKey);}catch{throw Error('Pipeline command may contain credentials or a queried URL. Remove sensitive input before preparation.');}
 }
 const fingerprint=createHash('sha256').update(JSON.stringify(p)).digest('hex');
 const options={...p,pipeline_sha256:fingerprint};
 const command="python3 - <<'CGPU_PIPELINE'\nimport json\noptions=json.loads("+JSON.stringify(JSON.stringify(options))+")\n"+program+'\nCGPU_PIPELINE';
 if(Buffer.byteLength(command)>32768)throw Error('Combined pipeline exceeds the execution size limit.');
 return {requirements:['Python 3','bash','Reviewed commands and prepared dependencies'],preparation_only:true,starts_gpu:false,pipeline_sha256:fingerprint,steps:p.steps,
  run_job_draft:{command,...(p.workspace_version_id?{workspace_version_id:p.workspace_version_id}:{}),...(p.persist_summary?{outputs:{files:['pipeline-summary.json'],max_bytes:1048576,accept_storage_charges:false}}:{})},
  execution:'Sequential child shells in one GPU allocation. Shared filesystem and GPU; shell variables and in-memory model processes do not persist between steps. First failure stops later steps. No execution retry.',
  next:'Review every command and prerequisites. Obtain a fresh compatible Job quote and explicit GPU/budget/time approval, then call run_job once with a stable idempotency key. Preserve that key on a lost response. This fingerprint is not server approval or an idempotency key.',
  existing_rental:'The command can instead run with run_command on an owned, ready, explicitly approved existing rental within its original limits. Apply any Workspace separately and use its returned working directory. This preparation never applies files, extends limits or stops an existing user instance. With persist_summary=true, use the Job output collector; preparation does not configure an output directory on an existing rental.',
  storage_note:p.persist_summary?'Summary persists only through enabled automatic output collection and existing quota/retention/fees. It contains step IDs, exit codes and state, not commands or output. No other results are collected by this draft; declare and approve result persistence separately.':'No persistent output collection requested. Save results explicitly before release.',
 };
}
export function registerTaskPipelineTools(server,{wrap,ok,cfg}) {
 server.registerTool('prepare_task_pipeline',{
  title:'Prepare sequential tasks for one GPU allocation',
  description:'Local read-only preparation of 1–8 reviewed commands for one bounded Job or an approved existing rental. Reuses GPU and disk across steps; stops on the first error. Does not create, retry, install dependencies, approve spending or change an instance lifecycle. Summary persistence is optional and never implies paid-storage consent.',
  inputSchema:input.shape,annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
 },wrap(async p=>ok(prepareTaskPipeline(p,cfg.apiKey))));
}
