import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';import {prepareTaskTemplate} from '../src/task-templates.js';
const ref={name:'base',repo_id:'example/model',revision:'a'.repeat(40),files:[{path:'model.safetensors',size_bytes:1,sha256:'b'.repeat(64)}]};
const common={workspace_version_id:'wsv_'+'a'.repeat(32),persist_results:true,model_reference:ref,input_path:'input.txt'};
test('inference drafts require fixed weights, safe inputs, persistence and bounded tokens; never execute during preparation',()=>{
 for(const id of ['causal-lm-inference','whisper-transcription']){
  const p=prepareTaskTemplate({...common,template_id:id});assert.equal(p.starts_gpu,false);assert.equal(p.run_job_draft.outputs.accept_storage_charges,false);assert.deepEqual(p.run_job_draft.model_references,[ref]);assert.match(p.validation,/real GPU acceptance pending/);assert.doesNotMatch(p.run_job_draft.command,/pip install|git clone|urlopen/);
  for(const bad of [{persist_results:false},{input_path:'../secret'},{max_new_tokens:257},{max_new_tokens:0},{model_reference:{...ref,revision:'main'}},{steps:2},{workflow_path:'x.json'}])assert.throws(()=>prepareTaskTemplate({...common,template_id:id,...bad}));
 }
 assert.throws(()=>prepareTaskTemplate({...common,template_id:'causal-lm-inference',language:'en'}));assert.throws(()=>prepareTaskTemplate({template_id:'gpu-check',max_new_tokens:10}));
});
test('prepared inference executes offline, enforces token bounds, persists results and keeps prompt out of logs',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'cg-inference-'));
 try{
  for(const d of ['fake','out','models/base'])await fs.mkdir(path.join(root,d),{recursive:true});
  await fs.writeFile(path.join(root,'input.txt'),'private-synthetic-prompt');
  await fs.writeFile(path.join(root,'fake/torch.py'),`import types,contextlib\ncuda=types.SimpleNamespace(is_available=lambda: True)\ndef manual_seed(n):assert n==0\nno_grad=contextlib.nullcontext\n`);
  await fs.writeFile(path.join(root,'fake/transformers.py'),`import os\nclass Tensor:\n shape=(1,3)\n def to(self,d):assert d=='cuda';return self\n def __getitem__(self,key):return [7,8]\nclass AutoTokenizer:\n eos_token_id=0\n @classmethod\n def from_pretrained(cls,p,**kw):\n  assert kw=={'local_files_only':True,'trust_remote_code':False};assert os.environ['HF_HUB_OFFLINE']=='1';return cls()\n def __call__(self,text,**kw):\n  assert text=='private-synthetic-prompt' and kw=={'return_tensors':'pt','truncation':True,'max_length':2048};return {'input_ids':Tensor()}\n def decode(self,v,**kw):assert v==[7,8] and kw=={'skip_special_tokens':True};return 'synthetic-result'\nclass AutoModelForCausalLM:\n @classmethod\n def from_pretrained(cls,p,**kw):assert kw=={'local_files_only':True,'trust_remote_code':False};return cls()\n def to(self,d):assert d=='cuda';return self\n def eval(self):return self\n def generate(self,**kw):assert kw['max_new_tokens']==2 and kw['do_sample']==False;return Tensor()\n`);
  const p=prepareTaskTemplate({...common,template_id:'causal-lm-inference',max_new_tokens:2});
  const r=spawnSync('bash',['-c',p.run_job_draft.command],{cwd:root,encoding:'utf8',timeout:10000,env:{...process.env,PYTHONPATH:path.join(root,'fake'),CLOUDGPU_MODEL_DIR:path.join(root,'models'),CLOUDGPU_OUTPUT_DIR:path.join(root,'out')}});assert.equal(r.status,0,r.stderr);assert.doesNotMatch(r.stdout+r.stderr,/private-synthetic-prompt|synthetic-result/);assert.equal(JSON.parse(await fs.readFile(path.join(root,'out/generation.json'))).text,'synthetic-result');
  const summary=JSON.parse(await fs.readFile(path.join(root,'out/task-summary.json')));assert.equal(summary.max_new_tokens,2);assert.equal(summary.revision,ref.revision);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
