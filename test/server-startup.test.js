import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

test('MCP executable starts and reports its version', () => {
  const result=spawnSync(process.execPath,['src/index.js','--version'],{encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout.trim(),/^\d+\.\d+\.\d+$/);
});

test('actual stdio server initializes and exposes model tools without making API calls',async () => {
  const transport=new StdioClientTransport({command:process.execPath,args:['src/index.js'],
    env:{...process.env,CLOUDGPU_API_KEY:'example-startup-key',CLOUDGPU_BASE_URL:'http://127.0.0.1:1',CLOUDGPU_READ_ONLY:'0'},stderr:'pipe'});
  transport.stderr?.on('data',()=>{});
  const client=new Client({name:'startup-regression',version:'1.0.0'});
  try {
    await client.connect(transport);
    const {tools}=await client.listTools();
    for(const name of ['run_job','resolve_model_reference','prepare_model_deployment','prepare_job_rerun'])
      assert.ok(tools.some(t=>t.name===name),name);
    const run=tools.find(t=>t.name==='run_job');
    assert.ok(run.inputSchema.properties.outputs);
    assert.equal(run.inputSchema.properties.outputs.properties.files.maxItems,16);
    assert.equal(run.inputSchema.properties.outputs.properties.max_bytes.maximum,104857600);
  } finally {await client.close().catch(()=>{});await transport.close().catch(()=>{});}
});
