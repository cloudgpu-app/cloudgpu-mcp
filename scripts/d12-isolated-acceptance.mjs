// Explicit isolated acceptance only: localhost backend, synthetic keys and files.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CloudGpuApi } from '../src/api.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const base=process.env.CGPU_ISOLATED_BASE;
assert.equal(new URL(base).hostname,'127.0.0.1');
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cgpu-d12-http-'));
const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve('src/index.js')],env:{...process.env,CLOUDGPU_BASE_URL:base,CLOUDGPU_API_KEY:process.env.CGPU_ISOLATED_KEY},stderr:'pipe'});
const client=new Client({name:'d12-isolated-acceptance',version:'1.0.0'});
const results=[];const files=[];let version;
async function tool(name,args={}){
 const r=await client.callTool({name,arguments:args});
 assert.ok(!r.isError,'tool_failed_'+name);
 const text=(r.content||[]).filter(x=>x.type==='text').map(x=>x.text).join('');
 return JSON.parse(text);
}
try {
 await client.connect(transport);
 const api=new CloudGpuApi({apiKey:process.env.CGPU_ISOLATED_KEY,baseUrl:base});
 const other=new CloudGpuApi({apiKey:process.env.CGPU_ISOLATED_OTHER_KEY,baseUrl:base});
 const revoked=new CloudGpuApi({apiKey:process.env.CGPU_ISOLATED_REVOKED_KEY,baseUrl:base});
 await assert.rejects(()=>revoked.request('GET','/v1/storage'),e=>e.status===401);results.push('revoked_key_denied');
 const account=await tool('get_storage');assert.equal(account.used_bytes,0);assert.equal(account.reserved_bytes,0);
 const project=path.join(dir,'project');await fs.mkdir(project);const contents=Buffer.from('print("CloudGPU synthetic workspace restored")\n');await fs.writeFile(path.join(project,'main.py'),contents);
 const saved=await tool('save_workspace',{local_dir:project,name:'synthetic acceptance'});version=saved.workspace_version_id||saved.version_id;assert.ok(version);const manifest=await tool('get_workspace_version',{version_id:version});const id=Object.values(manifest.files)[0];files.push(id);
 await assert.rejects(()=>other.request('POST',`/v1/files/${id}/download`,{}),e=>e.status===400);await assert.rejects(()=>other.request('GET',`/v1/workspace-versions/${version}`),e=>e.status===400);results.push('cross_user_file_and_version_denied');
 const output=path.join(dir,'restored.py');await tool('download_artifact',{file_id:id,local_path:output});assert.equal(crypto.createHash('sha256').update(await fs.readFile(output)).digest('hex'),crypto.createHash('sha256').update(contents).digest('hex'));results.push('actual_mcp_stdio_http_r2_workspace_sha256');
 // Cross the actual product 64MiB part boundary; use only synthetic bytes.
 const large=path.join(dir,'multipart.bin');const h=await fs.open(large,'w');const chunk=Buffer.alloc(1024*1024,17);for(let i=0;i<64;i++)await h.write(chunk);await h.write(Buffer.from('synthetic-tail'));await h.close();
 const uploaded=await tool('upload_artifact',{local_path:large});files.push(uploaded.file_id);const downloaded=path.join(dir,'multipart.download');await tool('download_artifact',{file_id:uploaded.file_id,local_path:downloaded});
 const hash=async p=>crypto.createHash('sha256').update(await fs.readFile(p)).digest('hex');assert.equal(await hash(large),await hash(downloaded));results.push('actual_mcp_64MiB_multipart_sha256');
 // Interrupt a real upload after putting a part. Explicit cancellation must free quota.
 const ticket=await api.request('POST','/v1/files',{name:'interrupted.bin',purpose:'artifact',size_bytes:4096});files.push(ticket.file_id);const part=await api.request('POST',`/v1/files/${ticket.file_id}/parts/1`,{});const put=await fetch(part.url,{method:'PUT',body:Buffer.alloc(4096,1),headers:{'Content-Length':'4096'},redirect:'error'});assert.ok(put.ok);await put.body?.cancel();await api.request('DELETE',`/v1/files/${ticket.file_id}`);results.push('real_interrupted_upload_cancelled');
 await tool('delete_workspace_version',{version_id:version,user_confirmed:true});version=null;
 for(const id of files)await tool('delete_file',{file_id:id,user_confirmed:true});files.length=0;
 const final=await tool('get_storage');assert.equal(final.used_bytes,0);assert.equal(final.reserved_bytes,0);assert.equal((await tool('list_files')).data.length,0);results.push('final_objects_and_quota_clean');
 console.log(JSON.stringify({status:'passed',cases:results,production_requests:0,gpu_requests:0}));
} catch(e) {
 console.log(JSON.stringify({status:'failed',cases:results,error_type:e.constructor.name,code:typeof e.code==='string'&&/^[a-z_]+$/.test(e.code)?e.code:undefined}));process.exitCode=1;
} finally {
 try{if(version)await tool('delete_workspace_version',{version_id:version,user_confirmed:true});for(const id of files)await tool('delete_file',{file_id:id,user_confirmed:true});}catch{console.log(JSON.stringify({cleanup:'failed_keep_evidence'}));process.exitCode=1;}
 await client.close().catch(()=>{});await transport.close().catch(()=>{});await fs.rm(dir,{recursive:true,force:true});
}
