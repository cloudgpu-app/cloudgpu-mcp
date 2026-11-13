import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {spawnSync} from 'node:child_process';
import {prepareTaskPipeline} from '../src/task-pipelines.js';
async function fixture(fn){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cg-pipeline-'));try{return await fn(dir);}finally{await fs.rm(dir,{recursive:true,force:true});}}
function run(p,dir,env={}){return spawnSync('bash',['-c',p.run_job_draft.command],{cwd:dir,env:{...process.env,...env},encoding:'utf8',timeout:10000});}
test('sequential tasks share files, summary is explicit and contains no commands or raw output',()=>fixture(async dir=>{
 const out=path.join(dir,'outputs');await fs.mkdir(out);
 const p=prepareTaskPipeline({steps:[{id:'first',command:"printf 'private-data' > result.txt"},{id:'second',command:'test -s result.txt'}],persist_summary:true});
 assert.equal(p.starts_gpu,false);assert.equal(p.run_job_draft.outputs.accept_storage_charges,false);
 const r=run(p,dir,{CLOUDGPU_OUTPUT_DIR:out});assert.equal(r.status,0,r.stderr);
 const saved=await fs.readFile(path.join(out,'pipeline-summary.json'),'utf8');const report=JSON.parse(saved);
 assert.equal(report.state,'succeeded');assert.deepEqual(report.steps,[{id:'first',exit_code:0},{id:'second',exit_code:0}]);assert.doesNotMatch(saved,/private-data|printf|result.txt/);
 assert.equal(run(p,dir,{CLOUDGPU_OUTPUT_DIR:out}).status,1,'existing summary cannot be overwritten');
}));
test('a failure prevents later side effects and preserves the nonzero exit status',()=>fixture(async dir=>{
 const p=prepareTaskPipeline({steps:[{id:'fail',command:'exit 17'},{id:'must_not_run',command:'touch forbidden'}]});
 const r=run(p,dir);assert.equal(r.status,17);await assert.rejects(fs.stat(path.join(dir,'forbidden')));
 const report=JSON.parse(r.stdout.trim());assert.equal(report.state,'failed');assert.equal(report.steps.length,1);assert.equal(p.run_job_draft.outputs,undefined);
}));
test('preparation supplies no approval, GPU selection, budget, quote or submission key',()=>{
 const p=prepareTaskPipeline({steps:[{id:'one',command:'true'}],workspace_version_id:'wsv_'+'a'.repeat(32)});
 for(const k of ['user_confirmed','gpu_model','quote_id','idempotency_key','max_hours','max_spend_usd'])assert.equal(p.run_job_draft[k],undefined);
 assert.equal(p.run_job_draft.workspace_version_id,'wsv_'+'a'.repeat(32));
 assert.equal(p.pipeline_sha256,prepareTaskPipeline({steps:[{id:'one',command:'true'}],workspace_version_id:'wsv_'+'a'.repeat(32)}).pipeline_sha256);
 assert.notEqual(p.pipeline_sha256,prepareTaskPipeline({steps:[{id:'one',command:'false'}]}).pipeline_sha256);
});
test('invalid IDs, duplicate IDs, unsafe monitoring commands and recognizable credentials are refused',()=>{
 for(const raw of [{steps:[]},{steps:[{id:'trailing\n',command:'true'}]},{steps:[{id:'../bad',command:'true'}]},{steps:[{id:'same',command:'true'},{id:'same',command:'true'}]},{steps:[{id:'one',command:'systemctl stop ssh'}]},{steps:[{id:'one',command:'echo "password=synthetic"'}]},{steps:[{id:'one',command:'echo sk-abcdefghijklmnop123456'}]}])assert.throws(()=>prepareTaskPipeline(raw));
 assert.throws(()=>prepareTaskPipeline({steps:[{id:'one',command:'echo current-credential'}]},'current-credential'));
});
test('storage preflight failure and symlink summary never run commands',()=>fixture(async dir=>{
 const p=prepareTaskPipeline({steps:[{id:'one',command:'touch forbidden'}],persist_summary:true});
 assert.notEqual(run(p,dir,{CLOUDGPU_OUTPUT_DIR:''}).status,0);await assert.rejects(fs.stat(path.join(dir,'forbidden')));
 const victim=path.join(dir,'victim');await fs.writeFile(victim,'preserve');await fs.symlink(victim,path.join(dir,'pipeline-summary.json'));
 assert.notEqual(run(p,dir,{CLOUDGPU_OUTPUT_DIR:dir}).status,0);assert.equal(await fs.readFile(victim,'utf8'),'preserve');await assert.rejects(fs.stat(path.join(dir,'forbidden')));
}));

test('failed compound commands and shell pipelines cannot run a later step',()=>fixture(async dir=>{
 for(const command of ['false; touch forbidden','false | true']){
  const p=prepareTaskPipeline({steps:[{id:'first',command},{id:'later',command:'touch forbidden'}]});
  assert.notEqual(run(p,dir).status,0);await assert.rejects(fs.stat(path.join(dir,'forbidden')));
 }
}));
