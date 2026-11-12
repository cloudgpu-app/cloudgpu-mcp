import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
test('actual MCP stdio exposes diagnosis and output saving without contacting the API',async()=>{
 const transport=new StdioClientTransport({command:process.execPath,args:['src/index.js'],env:{...process.env,CLOUDGPU_API_KEY:'example-key',CLOUDGPU_BASE_URL:'http://127.0.0.1:1',CLOUDGPU_READ_ONLY:'0'},stderr:'pipe'});transport.stderr?.on('data',()=>{});
 const client=new Client({name:'job-result-startup',version:'1.0.0'});
 try{await client.connect(transport);const r=await client.listTools();for(const name of ['diagnose_job','save_job_output'])assert.ok(r.tools.some(x=>x.name===name));}
 finally{await client.close().catch(()=>{});await transport.close().catch(()=>{});}
});

test('keyless client can actually read the public catalog without an Authorization header',async()=>{
 const {createServer}=await import('node:http');const fs=await import('node:fs/promises');const os=await import('node:os');const path=await import('node:path');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cgpu-keyless-'));let requests=0,authSeen=false;
 const server=createServer((req,res)=>{requests++;authSeen=Boolean(req.headers.authorization);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({gpus:[]}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const transport=new StdioClientTransport({command:process.execPath,args:['src/index.js'],env:{...process.env,CLOUDGPU_API_KEY:'',CLOUDGPU_CONFIG_DIR:dir,CLOUDGPU_BASE_URL:`http://127.0.0.1:${server.address().port}`,CLOUDGPU_READ_ONLY:'1'},stderr:'pipe'});transport.stderr?.on('data',()=>{});const client=new Client({name:'keyless-catalog',version:'1.0.0'});
 try{await client.connect(transport);const r=await client.callTool({name:'get_compute_catalog',arguments:{}});assert.ok(!r.isError);assert.equal(requests,1);assert.equal(authSeen,false);}
 finally{await client.close().catch(()=>{});await transport.close().catch(()=>{});await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true});}
});
