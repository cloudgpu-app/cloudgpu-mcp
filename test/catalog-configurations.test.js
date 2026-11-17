import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

test('stdio list_gpus preserves exact configuration prices and unknown fleet-count semantics', async () => {
 const config={gpuCount:8,vramPerGpuGb:80,vcpu:176,memoryGb:1440,systemDiskGb:100,region:'europe',available:true,hourlyPrice:21.84,minimumBillingSeconds:60,billingIncrementSeconds:60};
 const server=http.createServer((req,res)=>{assert.equal(req.method,'GET');assert.equal(req.url,'/v1/gpu/offers');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{gpu_model:'A100 80G',vram_gb:80,hourly_usd:2.73,available:'ok',inventory_count_exact:false,configurations:[config]}]}));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const transport=new StdioClientTransport({command:process.execPath,args:['src/index.js'],env:{...process.env,CLOUDGPU_API_KEY:'example-catalog-only',CLOUDGPU_BASE_URL:`http://127.0.0.1:${server.address().port}`,CLOUDGPU_READ_ONLY:'1'},stderr:'pipe'});
 transport.stderr?.on('data',()=>{});const client=new Client({name:'catalog-contract',version:'1.0.0'});
 try {await client.connect(transport);const result=await client.callTool({name:'list_gpus',arguments:{gpu_model:'A100'}});const body=JSON.parse(result.content.find(c=>c.type==='text').text);assert.equal(body.gpus[0].inventory_count_exact,false);assert.deepEqual(body.gpus[0].configurations,[config]);assert.match(body.note,/whole|total/);}
 finally {await client.close().catch(()=>{});await transport.close().catch(()=>{});await new Promise(resolve=>server.close(resolve));}
});
