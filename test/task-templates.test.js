import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {listTaskTemplates,prepareTaskTemplate} from '../src/task-templates.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const version='wsv_'+'a'.repeat(32);
async function fixture(fn){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cg-task-'));try{return await fn(dir);}finally{await fs.rm(dir,{recursive:true,force:true});}}
function execute(command,cwd,env={}){return spawnSync('bash',['-c',command],{cwd,env:{...process.env,...env},encoding:'utf8',timeout:10000});}

test('preparation never assumes approval, a quote, a price or paid-storage consent',()=>{
 const t=prepareTaskTemplate({template_id:'gpu-check'});
 assert.equal(t.starts_gpu,false);assert.equal(t.run_job_draft.outputs,undefined);
 for(const key of ['gpu_model','quote_id','user_confirmed','max_hours','max_spend_usd','idempotency_key'])assert.equal(t.run_job_draft[key],undefined);
 assert.match(t.storage_note,/No persistent/);
 const saved=prepareTaskTemplate({template_id:'gpu-check',persist_results:true});assert.equal(saved.run_job_draft.outputs.accept_storage_charges,false);
 const catalogue=listTaskTemplates();catalogue.templates[0].id='changed';assert.equal(listTaskTemplates().templates[0].id,'gpu-check');
});
test('CSV task actually processes only the supplied Workspace file, without logging values',async()=>fixture(async dir=>{
 await fs.writeFile(path.join(dir,'data.csv'),'name,count\nsecret-cell,1\nsecond,2,extra\n');
 const draft=prepareTaskTemplate({template_id:'csv-summary',workspace_version_id:version,input_path:'data.csv'});
 const result=execute(draft.run_job_draft.command,dir);assert.equal(result.status,0,result.stderr);
 assert.deepEqual(JSON.parse(result.stdout),{columns:2,header_assumed:true,inconsistent_rows:1,input_bytes:40,rows:2});
 assert.doesNotMatch(result.stdout,/secret-cell|second/);assert.equal(draft.run_job_draft.workspace_version_id,version);
}));
test('persistent GPU check produces the exact named file; failure and overwrite do not silently pass',async()=>fixture(async dir=>{
 const bin=path.join(dir,'bin'),outputs=path.join(dir,'outputs');await fs.mkdir(bin);await fs.mkdir(outputs);
 const smi=path.join(bin,'nvidia-smi');await fs.writeFile(smi,"#!/bin/sh\nprintf 'Test GPU, 24576\\n'\n",{mode:0o700});
 const draft=prepareTaskTemplate({template_id:'gpu-check',persist_results:true});
 const env={PATH:bin+':'+process.env.PATH,CLOUDGPU_OUTPUT_DIR:outputs};
 let r=execute(draft.run_job_draft.command,dir,env);assert.equal(r.status,0,r.stderr);
 assert.deepEqual(JSON.parse(await fs.readFile(path.join(outputs,'gpu-check.json'),'utf8')),{gpus:[{name:'Test GPU',memory_mib:24576}]});
 assert.deepEqual(draft.run_job_draft.outputs.files,['gpu-check.json']);
 r=execute(draft.run_job_draft.command,dir,env);assert.notEqual(r.status,0);
 await fs.writeFile(smi,'#!/bin/sh\nexit 1\n',{mode:0o700});
 const noStorage=prepareTaskTemplate({template_id:'gpu-check'});r=execute(noStorage.run_job_draft.command,dir,env);assert.notEqual(r.status,0);assert.equal(r.stdout,'');
}));
test('Workspace entrypoint runs once in the restored project, preserves failure, installs nothing',async()=>fixture(async dir=>{
 await fs.writeFile(path.join(dir,'task.py'),"from pathlib import Path\nPath('ran').write_text('once')\nraise SystemExit(7)\n");
 const draft=prepareTaskTemplate({template_id:'workspace-python',workspace_version_id:version,entrypoint:'task.py'});
 const result=execute(draft.run_job_draft.command,dir);assert.equal(result.status,7);assert.equal(await fs.readFile(path.join(dir,'ran'),'utf8'),'once');
 assert.doesNotMatch(draft.run_job_draft.command,/pip install|curl|wget/);
}));
test('invalid configuration, injection and unapproved defaults cannot create executable drafts',()=>{
 for(const p of [
  {template_id:'unknown'}, {template_id:'csv-summary',input_path:'data.csv'},
  {template_id:'csv-summary',workspace_version_id:version,input_path:'../secret'},
  {template_id:'csv-summary',workspace_version_id:version,input_path:'a/../../secret'},
  {template_id:'csv-summary',workspace_version_id:version,input_path:'$(touch hacked).csv'},
  {template_id:'workspace-python',workspace_version_id:version,entrypoint:'task.py\nsh'},
  {template_id:'workspace-python',workspace_version_id:version,entrypoint:'.hidden/task.py'},
  {template_id:'workspace-python',workspace_version_id:version,entrypoint:'task.py',persist_results:true},
  {template_id:'gpu-check',accept_storage_charges:true},
  {template_id:'gpu-check',persist_results:'true'},
  {template_id:'gpu-check',user_confirmed:true},
  {template_id:'gpu-check',workspace_version_id:version},
 ])assert.throws(()=>prepareTaskTemplate(p));
});
test('CSV and entrypoint symlinks are refused; oversized CSV cannot be read as a normal result',async()=>fixture(async dir=>{
 await fs.writeFile(path.join(dir,'original.csv'),'a\nx\n');await fs.symlink('original.csv',path.join(dir,'link.csv'));
 let draft=prepareTaskTemplate({template_id:'csv-summary',workspace_version_id:version,input_path:'link.csv'});assert.notEqual(execute(draft.run_job_draft.command,dir).status,0);
 await fs.writeFile(path.join(dir,'task.py'),'print("should not run")');await fs.symlink('task.py',path.join(dir,'link.py'));
 draft=prepareTaskTemplate({template_id:'workspace-python',workspace_version_id:version,entrypoint:'link.py'});assert.notEqual(execute(draft.run_job_draft.command,dir).status,0);
 const file=await fs.open(path.join(dir,'large.csv'),'w');await file.truncate(33554433);await file.close();
 draft=prepareTaskTemplate({template_id:'csv-summary',workspace_version_id:version,input_path:'large.csv'});assert.notEqual(execute(draft.run_job_draft.command,dir).status,0);
}));
test('actual keyless read-only MCP prepares a task without any API connectivity',async()=>{
 const transport=new StdioClientTransport({command:process.execPath,args:['src/index.js'],env:{...process.env,CLOUDGPU_API_KEY:'',CLOUDGPU_BASE_URL:'http://127.0.0.1:1',CLOUDGPU_READ_ONLY:'1'},stderr:'pipe'});transport.stderr?.on('data',()=>{});
 const client=new Client({name:'template-acceptance',version:'1.0.0'});
 try{await client.connect(transport);const {tools}=await client.listTools();
  for(const name of ['list_task_templates','prepare_task_template','compare_compute_costs','prepare_task_pipeline'])assert.equal(tools.find(t=>t.name===name)?.annotations.readOnlyHint,true);
  const pipeline=await client.callTool({name:'prepare_task_pipeline',arguments:{steps:[{id:'check',command:'true'}]}});assert.ok(!pipeline.isError);assert.equal(JSON.parse(pipeline.content[0].text).starts_gpu,false);
  const c=await client.callTool({name:'list_task_templates',arguments:{}});assert.ok(!c.isError);assert.equal(JSON.parse(c.content[0].text).templates.length,5);
  const p=await client.callTool({name:'prepare_task_template',arguments:{template_id:'gpu-check'}});assert.ok(!p.isError);assert.equal(JSON.parse(p.content[0].text).starts_gpu,false);
 }finally{await client.close().catch(()=>{});await transport.close().catch(()=>{});}
});
