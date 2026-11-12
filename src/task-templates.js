// 只读任务准备：不访问 API、不租 GPU、不安装依赖，也不推断预算或存储同意。
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {INFERENCE_TASKS,inferenceFields,prepareInferenceRecipe} from './inference-recipes.js';
import {APPLICATION_TASKS,applicationFields,prepareApplicationRecipe} from './application-recipes.js';

const TASKS = [
  {id:'gpu-check',version:1,title:'Check the allocated GPU',requires_workspace:false,requirements:['Python 3','nvidia-smi'],result_files:['gpu-check.json'],description:'Report visible GPU names and total memory. No model download or benchmark.'},
  {id:'csv-summary',version:1,title:'Summarize a Workspace CSV',requires_workspace:true,requirements:['Python 3','Immutable Workspace version','UTF-8 CSV, at most 32 MiB'],result_files:['csv-summary.json'],description:'Count rows, columns and inconsistent row widths without logging cell values. Usually a CPU task; prefer local execution when a GPU is unnecessary.'},
  {id:'workspace-python',version:1,title:'Run a reviewed Workspace Python script',requires_workspace:true,requirements:['Python 3','Immutable Workspace version','User-reviewed Python entrypoint and dependencies already prepared'],result_files:[],description:'Reuse your own inference or training script. Does not install packages, supply a model, or certify application compatibility.'},
];
TASKS.push(...APPLICATION_TASKS,...INFERENCE_TASKS);
const id=z.enum(TASKS.map(t=>t.id));
const relative=z.string().min(1).max(240).regex(/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/).refine(p=>p.split('/').every(s=>s && s!=='.' && s!=='..' && !s.startsWith('.')),'Use a relative path without traversal or hidden components');
const schema=z.object({
  template_id:id,
  ...applicationFields,
  ...inferenceFields,
  workspace_version_id:z.string().regex(/^wsv_[0-9a-f]{32}$/).optional(),
  input_path:relative.optional(),
  entrypoint:relative.refine(p=>p.endsWith('.py'),'Entrypoint must be a Python file').optional(),
  persist_results:z.boolean().default(false),
  output_files:z.array(relative).min(1).max(16).optional(),
  accept_storage_charges:z.boolean().default(false),
}).strict();
const programs={
  'gpu-check':`import json,subprocess
r=subprocess.run(['nvidia-smi','--query-gpu=name,memory.total','--format=csv,noheader,nounits'],capture_output=True,text=True,timeout=15)
if r.returncode: raise RuntimeError('GPU query failed; no automatic retry')
gpus=[]
for line in r.stdout.splitlines():
    name,memory=line.rsplit(',',1)
    gpus.append({'name':name.strip(),'memory_mib':int(memory.strip())})
if not gpus: raise RuntimeError('No visible GPU; no automatic retry')
result={'gpus':gpus}
`,
  'csv-summary':`import csv,json,os,pathlib,stat
root=pathlib.Path.cwd().resolve()
p=root.joinpath(options['input_path'])
for component in p.relative_to(root).parts:
    root=root/component
    if root.is_symlink(): raise ValueError('Input must not use symlinks')
flags=os.O_RDONLY|getattr(os,'O_NOFOLLOW',0)|os.O_NONBLOCK
fd=os.open(str(p),flags)
meta=os.fstat(fd)
if not stat.S_ISREG(meta.st_mode) or meta.st_size>33554432:
    os.close(fd)
    raise ValueError('Input must be a regular CSV of at most 32 MiB')
csv.field_size_limit(1048576)
with os.fdopen(fd,'r',encoding='utf-8',newline='') as f:
    reader=csv.reader(f)
    header=next(reader,None)
    columns=len(header) if header is not None else 0
    rows=0
    inconsistent=0
    for row in reader:
        rows+=1
        inconsistent+=int(len(row)!=columns)
        if rows>1000000: raise ValueError('CSV row limit exceeded')
result={'rows':rows,'columns':columns,'inconsistent_rows':inconsistent,'input_bytes':meta.st_size,'header_assumed':True}
`,
  'workspace-python':`import os,pathlib,stat,sys
root=pathlib.Path.cwd().resolve()
p=root.joinpath(options['entrypoint'])
check=root
for component in p.relative_to(root).parts:
    check=check/component
    if check.is_symlink(): raise ValueError('Entrypoint must not use symlinks')
if not stat.S_ISREG(p.stat().st_mode): raise ValueError('Entrypoint must be a regular file')
os.execv(sys.executable,[sys.executable,str(p)])
`,
};

export function listTaskTemplates(){
  return {preparation_only:true,starts_gpu:false,templates:structuredClone(TASKS),
    note:'Preparation costs no GPU time. Running a Job costs money and requires a fresh quote, explicit GPU/budget/time approval and a new idempotency key. No automatic retry or dependency installation. Application execution recipes are experimental, reuse prepared environments and require persistent outputs. They are not real-GPU or model-quality acceptance. Image/SDXL LoRA is not included.'};
}

export function prepareTaskTemplate(raw){
  const p=schema.parse(raw),t=TASKS.find(t=>t.id===p.template_id);
  const inference=prepareInferenceRecipe(p);if(inference)return inference;
  if(Object.keys(inferenceFields).some(k=>p[k]!==undefined))throw Error('Inference fields do not belong to this task');
  const application=prepareApplicationRecipe(p);if(application)return application;
  if(Object.keys(applicationFields).some(k=>p[k]!==undefined))throw Error('Application-specific fields do not belong to this task');
  if(t.requires_workspace && !p.workspace_version_id)throw Error('Select an immutable Workspace version before preparing this task');
  if(!t.requires_workspace && p.workspace_version_id)throw Error('gpu-check does not use a Workspace');
  if(p.template_id==='csv-summary' ? !p.input_path : p.input_path!==undefined)throw Error('input_path is required only for csv-summary');
  if(p.template_id==='workspace-python' ? !p.entrypoint : p.entrypoint!==undefined)throw Error('entrypoint is required only for workspace-python');
  if(p.accept_storage_charges && !p.persist_results)throw Error('Storage consent is only relevant when persisting results');
  if(p.output_files && (!p.persist_results || p.template_id!=='workspace-python'))throw Error('Explicit output_files are only for persistent workspace-python results');
  if(p.persist_results && p.template_id==='workspace-python' && !p.output_files)throw Error('List the exact result files your reviewed script writes under CLOUDGPU_OUTPUT_DIR');
  if(p.output_files && new Set(p.output_files).size!==p.output_files.length)throw Error('Result paths must be distinct');
  const options={...(p.input_path?{input_path:p.input_path}:{}),...(p.entrypoint?{entrypoint:p.entrypoint}:{})};
  let program='import json\noptions=json.loads('+JSON.stringify(JSON.stringify(options))+')\n'+programs[p.template_id];
  if(p.template_id!=='workspace-python'){
    program+=`import os,pathlib\nencoded=json.dumps(result,sort_keys=True)\n`;
    if(p.persist_results)program+=`dest=pathlib.Path(os.environ['CLOUDGPU_OUTPUT_DIR'])/${JSON.stringify(t.result_files[0])}\nwith dest.open('x',encoding='utf-8') as f: f.write(encoded+'\\n')\n`;
    program+="print(encoded)\n";
  }
  const command="set -eu\numask 077\npython3 - <<'CGPU_TASK_TEMPLATE'\n"+program+"CGPU_TASK_TEMPLATE\n";
  const draft={command,...(p.workspace_version_id?{workspace_version_id:p.workspace_version_id}:{})};
  if(p.persist_results)draft.outputs={files:p.output_files||t.result_files,max_bytes:10485760,accept_storage_charges:p.accept_storage_charges};
  return {preparation_only:true,starts_gpu:false,template_id:t.id,template_version:t.version,
    command_sha256:createHash('sha256').update(command).digest('hex'),run_job_draft:draft,
    requirements:t.requirements,missing_fields:['gpu_model or quote_id','max_spend_usd','max_hours','user_confirmed','idempotency_key'],
    next_steps:['Review the task, Workspace expiry and required dependencies; prefer local CPU execution for CSV-only work.',
      'Check live compute capabilities and request a fresh quote for a compatible GPU. Do not assume image compatibility from this draft.',
      'Ask the user to approve GPU, spending cap and time limit. Separately obtain paid-storage consent if needed; scoped keys may not enable paid storage.',
      'Call run_job only after approval with a new idempotency key; retain that key for transport retries of the SAME submission.',
      'Poll get_job until terminal, inspect output_collection if requested and verify GPU release. Do not automatically retry failed tasks.'],
    storage_note:p.persist_results?'Existing storage eligibility, quota, retention and charges apply; transfer uses the same GPU time budget. Explicit result paths are not a content-safety guarantee.':'No persistent storage requested; only the ended Job log tail remains available. GPU disk is erased at release.'};
}

export function registerTaskTemplateTools(server,{wrap,ok}){
  const annotations={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false};
  server.registerTool('list_task_templates',{title:'List reusable Job task drafts',description:'Public, local and read-only. Inspect small task recipes and requirements before quoting. Does not call an API, rent a GPU, install dependencies or reserve capacity.',inputSchema:{},annotations},wrap(async()=>ok(listTaskTemplates())));
  server.registerTool('prepare_task_template',{title:'Prepare a Job task draft',description:'Local preparation only. Returns a command and optional Workspace/output fields; never submits or spends money. Quote, explicit GPU/budget/time approval and existing storage consent are still required by run_job. No guaranteed application compatibility or automatic retry.',inputSchema:schema.shape,annotations},wrap(async input=>ok(prepareTaskTemplate(input))));
}
