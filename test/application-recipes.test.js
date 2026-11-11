import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {prepareTaskTemplate,listTaskTemplates} from '../src/task-templates.js';
const workspace='wsv_'+'a'.repeat(32);
const reference={name:'base',repo_id:'example/public-model',revision:'a'.repeat(40),files:[{path:'model.safetensors',size_bytes:10,sha256:'b'.repeat(64)}]};
function execute(command,cwd,output,env={}){return new Promise((resolve,reject)=>{const child=spawn('bash',['-c',command],{cwd,env:{...process.env,CLOUDGPU_OUTPUT_DIR:output,...env}});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));const timer=setTimeout(()=>child.kill('SIGKILL'),15000);child.once('close',()=>clearTimeout(timer));});}
async function fixture(mode,fn){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'cg-app-recipe-'));const output=path.join(root,'output');await fs.mkdir(output);
 const prompt={1:{class_type:'SaveImage',inputs:{filename_prefix:'private-project-text'}}};await fs.writeFile(path.join(root,'workflow.json'),JSON.stringify(prompt));
 const state={prompts:0,paths:[],received:null};
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY1cAAAAASUVORK5CYII=','base64');
 const server=http.createServer(async(req,res)=>{
  state.paths.push(req.url);
  if(req.url==='/system_stats'){
   if(mode==='redirect'){res.writeHead(302,{Location:'https://example.invalid/collect'});res.end();return;}
   res.end(JSON.stringify({system:{os:'fixture'},devices:[]}));return;
  }
  if(req.url==='/prompt'){
   state.prompts++;let b='';for await(const part of req)b+=part;state.received=JSON.parse(b);
   if(mode==='uncertain'){req.socket.destroy();return;}
   res.end(JSON.stringify({prompt_id:'fixture',...(mode==='node-error'?{node_errors:{1:{errors:['private-error-text']}}}:{})}));return;
  }
  if(req.url==='/history/fixture'){
   if(mode==='oversized'){res.end('x'.repeat(1048577));return;}
   const images=mode==='bad-path'?[{filename:'../secret.png',type:'output'}]:mode==='count'?[]:[{filename:'generated.png',subfolder:'task',type:'output'}];
   res.end(JSON.stringify({fixture:{status:{completed:true,status_str:mode==='execution-error'?'error':'success'},outputs:{1:{images}}}}));return;
  }
  if(req.url.startsWith('/view?')){res.end(mode==='not-png'?Buffer.from('private-error-text'):png);return;}
  res.writeHead(404);res.end();
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const draft=prepareTaskTemplate({template_id:'comfyui-workflow',workspace_version_id:workspace,persist_results:true,workflow_path:'workflow.json',comfy_port:server.address().port});await fn({root,output,state,prompt,png,draft});}
 finally{server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(root,{recursive:true,force:true});}
}
test('ComfyUI recipe really submits once, polls and copies explicit PNG outputs without logging prompts',()=>fixture('success',async f=>{
 const r=await execute(f.draft.run_job_draft.command,f.root,f.output);assert.equal(r.code,0,r.stderr);assert.equal(f.state.prompts,1);assert.deepEqual(f.state.received.prompt,f.prompt);
 assert.deepEqual(await fs.readFile(path.join(f.output,'image-0.png')),f.png);
 const summary=JSON.parse(await fs.readFile(path.join(f.output,'task-summary.json'),'utf8'));assert.equal(summary.image_count,1);assert.equal(summary.files[0].bytes,f.png.length);
 assert.doesNotMatch(r.stdout+r.stderr,/private-project|private-error/);assert.deepEqual(f.draft.run_job_draft.outputs.files,['image-0.png','task-summary.json']);assert.equal(f.draft.run_job_draft.outputs.accept_storage_charges,false);
 assert.equal(f.draft.run_job_draft.user_confirmed,undefined);assert.equal(f.draft.run_job_draft.max_spend_usd,undefined);
}));
for(const mode of ['redirect','uncertain','node-error','execution-error','count','bad-path','oversized','not-png'])test('ComfyUI refuses '+mode+' without a second submission or raw errors',()=>fixture(mode,async f=>{
 const r=await execute(f.draft.run_job_draft.command,f.root,f.output);assert.equal(r.code,2);assert.ok(f.state.prompts<=1);assert.doesNotMatch(r.stdout+r.stderr,/private-project|private-error|Traceback/);assert.equal(await fs.stat(path.join(f.output,'task-summary.json')).then(()=>true,()=>false),false);
 if(mode==='redirect')assert.deepEqual(f.state.paths,['/system_stats']);
}));
test('ComfyUI refuses symlink inputs and existing outputs before submitting',()=>fixture('success',async f=>{
 await fs.rename(path.join(f.root,'workflow.json'),path.join(f.root,'original.json'));await fs.symlink('original.json',path.join(f.root,'workflow.json'));
 let r=await execute(f.draft.run_job_draft.command,f.root,f.output);assert.equal(r.code,2);assert.equal(f.state.prompts,0);
 await fs.unlink(path.join(f.root,'workflow.json'));await fs.rename(path.join(f.root,'original.json'),path.join(f.root,'workflow.json'));await fs.writeFile(path.join(f.output,'existing'),'keep');
 r=await execute(f.draft.run_job_draft.command,f.root,f.output);assert.equal(r.code,2);assert.equal(f.state.prompts,0);assert.equal(await fs.readFile(path.join(f.output,'existing'),'utf8'),'keep');
}));
test('LoRA draft binds the pinned model, limits and exact adapter outputs; Python is syntactically valid',async()=>{
 const p=prepareTaskTemplate({template_id:'causal-lm-lora',workspace_version_id:workspace,persist_results:true,model_reference:reference,dataset_path:'train.jsonl',target_modules:['q_proj','v_proj'],steps:2});
 assert.deepEqual(p.run_job_draft.model_references,[reference]);assert.deepEqual(p.run_job_draft.outputs.files,['adapter_config.json','adapter_model.safetensors','task-summary.json']);
 assert.match(p.run_job_draft.command,/local_files_only=True,trust_remote_code=False/);assert.match(p.run_job_draft.command,/HF_HUB_OFFLINE/);assert.doesNotMatch(p.run_job_draft.command,/pip install|git clone/);
 const source=p.run_job_draft.command.split("python3 - <<'CGPU_APPLICATION_RECIPE'\n")[1].split('CGPU_APPLICATION_RECIPE\n')[0];
 const child=spawn('python3',['-c','import ast,sys;ast.parse(sys.stdin.read())']);child.stdin.end(source);const code=await new Promise(r=>child.on('close',r));assert.equal(code,0);
 assert.match(p.validation,/real GPU training.*not yet accepted/);assert.equal(listTaskTemplates().templates.length,5);
});
test('Recipe-specific inputs, injection, missing storage choice and unpinned weights fail before execution',()=>{
 const common={template_id:'comfyui-workflow',workspace_version_id:workspace,persist_results:true,workflow_path:'workflow.json'};
 for(const p of [{...common,persist_results:false},{...common,workspace_version_id:undefined},{...common,workflow_path:'../workflow.json'},{...common,workflow_path:'$(touch pwn).json'},{...common,model_reference:reference},{...common,image_count:5},{...common,comfy_port:80},{...common,output_files:['secret']},{template_id:'gpu-check',workflow_path:'workflow.json'},{template_id:'causal-lm-lora',workspace_version_id:workspace,persist_results:true,model_reference:{...reference,revision:'main'},dataset_path:'data.jsonl',target_modules:['q_proj']}])assert.throws(()=>prepareTaskTemplate(p));
});
test('LoRA orchestration fixture verifies offline loading, exactly bounded training steps and adapter metadata (not GPU training)',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'cg-lora-fixture-'));
 try{
  const fake=path.join(root,'fake'),models=path.join(root,'models'),output=path.join(root,'output');await fs.mkdir(fake);await fs.mkdir(path.join(models,'base'),{recursive:true});await fs.mkdir(output);
  await fs.writeFile(path.join(root,'train.jsonl'),JSON.stringify({text:'private-training-example'})+'\n');
  await fs.writeFile(path.join(fake,'safetensors.py'),'# Protocol fixture only\n');
  await fs.writeFile(path.join(fake,'torch.py'),`import types
float32='float32';bfloat16='bfloat16';steps=0;backward=0
cuda=types.SimpleNamespace(is_available=lambda: True,is_bf16_supported=lambda: False)
def manual_seed(value): assert value==0
class AdamW:
 def __init__(self,params,lr): assert len(list(params))==1 and lr==0.0002
 def zero_grad(self,**kw): assert kw=={'set_to_none':True}
 def step(self):
  global steps
  steps+=1
optim=types.SimpleNamespace(AdamW=AdamW)
nn=types.SimpleNamespace(utils=types.SimpleNamespace(clip_grad_norm_=lambda params,value: None))
class Tensor:
 shape=(1,3)
 def to(self,device): assert device=='cuda';return self
 def clone(self): return Tensor()
class Loss:
 def detach(self): return self
 def float(self): return self
 def cpu(self): return self
 def __float__(self): return 0.5
 def backward(self):
  global backward
  backward+=1
`);
  await fs.writeFile(path.join(fake,'transformers.py'),`import os,pathlib,torch
class AutoTokenizer:
 @classmethod
 def from_pretrained(cls,p,**kw):
  assert kw=={'local_files_only':True,'trust_remote_code':False};assert os.environ['HF_HUB_OFFLINE']=='1';return cls()
 def __call__(self,text,**kw):
  assert text=='private-training-example' and kw['max_length']==256;return {'input_ids':torch.Tensor(),'attention_mask':torch.Tensor()}
class AutoModelForCausalLM:
 @classmethod
 def from_pretrained(cls,p,**kw):
  assert kw=={'local_files_only':True,'trust_remote_code':False,'torch_dtype':'float32'};return cls()
 def to(self,device): assert device=='cuda';return self
`);
  await fs.writeFile(path.join(fake,'peft.py'),`import types,pathlib,json,torch
class LoraConfig:
 def __init__(self,**kw):
  assert kw['r']==4 and kw['target_modules']==['q_proj'] and kw['task_type']=='CAUSAL_LM';self.options=kw
class Model:
 def __init__(self,config): self.peft_config={'default':config};self.calls=0
 def train(self): pass
 def parameters(self): return [types.SimpleNamespace(requires_grad=True)]
 def __call__(self,**kw):
  assert 'labels' in kw;self.calls+=1;return types.SimpleNamespace(loss=torch.Loss())
 def save_pretrained(self,p,**kw):
  assert kw=={'safe_serialization':True};p=pathlib.Path(p);c=self.peft_config['default']
  (p/'adapter_config.json').write_text(json.dumps({'base_model_name_or_path':c.base_model_name_or_path,'revision':c.revision,'fixture_forwards':self.calls,'fixture_backward':torch.backward,'fixture_optimizer_steps':torch.steps}))
  (p/'adapter_model.safetensors').write_bytes(b'fixture-only-not-real-weights')
def get_peft_model(base,config): return Model(config)
`);
  const p=prepareTaskTemplate({template_id:'causal-lm-lora',workspace_version_id:workspace,persist_results:true,model_reference:reference,dataset_path:'train.jsonl',target_modules:['q_proj'],steps:2});
  const result=await execute(p.run_job_draft.command,root,output,{PYTHONPATH:fake,CLOUDGPU_MODEL_DIR:models});assert.equal(result.code,0,result.stderr);
  const config=JSON.parse(await fs.readFile(path.join(output,'adapter_config.json'),'utf8'));assert.equal(config.fixture_forwards,2);assert.equal(config.fixture_backward,2);assert.equal(config.fixture_optimizer_steps,2);assert.equal(config.base_model_name_or_path,reference.repo_id);assert.equal(config.revision,reference.revision);
  const summary=JSON.parse(await fs.readFile(path.join(output,'task-summary.json'),'utf8'));assert.equal(summary.steps_completed,2);assert.equal(summary.last_loss,0.5);assert.doesNotMatch(result.stdout+result.stderr,/private-training-example/);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
