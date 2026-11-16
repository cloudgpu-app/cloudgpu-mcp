import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createServer} from 'node:http';

test('actual MCP binds continent through discovery, approved quote and create; country constraints never disappear',async()=>{
 const calls=[];
 const server=createServer(async(req,res)=>{
  const parts=[];for await(const part of req)parts.push(part);const raw=Buffer.concat(parts).toString();const body=raw?JSON.parse(raw):null;
  calls.push({url:req.url,auth:req.headers.authorization,body});res.setHeader('Content-Type','application/json');
  let data={};
  if(req.url.startsWith('/v1/public/rental-regions'))data={enabled:true,continent:'asia',inventory:[]};
  else if(req.url==='/v1/gpu/offers')data={data:[{gpu_model:'RTX 4090',usd_per_hour:.39,min_gpu_count:1,available:'high'}]};
  else if(req.url==='/v1/gpu/account')data={balance_usd:20};
  else if(req.url==='/v1/gpu/billing-quote')data={billingQuoteId:'fixture-quote',continent:body.continent,gpuModel:'RTX 4090',gpuCount:1,incrementSeconds:3600,minimumSeconds:3600,hourlyTotalUsd:.39,minimumChargeUsd:.39,preauthorizedUsd:.39,currency:'USD',expiresAt:Date.now()+60000};
  else if(req.url==='/v1/gpu/instances')data={id:'fixture-only',status:'creating'};
  else {res.statusCode=404;data={error:{code:'unexpected_fixture_path'}};}
  res.end(JSON.stringify(data));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const transport=new StdioClientTransport({command:process.execPath,args:['src/index.js'],env:{...process.env,CLOUDGPU_API_KEY:'synthetic-fixture-only',CLOUDGPU_BASE_URL:`http://127.0.0.1:${server.address().port}`,CLOUDGPU_READ_ONLY:'0'},stderr:'pipe'});transport.stderr?.on('data',()=>{});
 const client=new Client({name:'continent-rental-fixture',version:'1'});
 try{
  await client.connect(transport);
  const discovery=await client.callTool({name:'list_rental_regions',arguments:{continent:'asia'}});assert.ok(!discovery.isError);assert.equal(calls[0].auth,undefined);
  const invalid=await client.callTool({name:'list_rental_regions',arguments:{continent:'CN'}});assert.equal(invalid.isError,true);assert.equal(calls.length,1);
  const unknown=await client.callTool({name:'estimate_cost',arguments:{gpu_model:'RTX 4090',hours:.25,country_code:'CN'}});assert.equal(unknown.isError,true);assert.equal(calls.length,1);
  const quoteResult=await client.callTool({name:'estimate_cost',arguments:{gpu_model:'RTX 4090',hours:.25,continent:'asia'}});assert.ok(!quoteResult.isError,quoteResult.content[0].text);
  const quote=JSON.parse(quoteResult.content[0].text);assert.equal(quote.continent,'asia');assert.equal(quote.minimum_charge_usd,.39);
  const create=await client.callTool({name:'create_instance',arguments:{quote_id:quote.quote_id,user_confirmed:true,max_spend_usd:1,max_hours:1}});assert.ok(!create.isError,create.content[0].text);
  const writes=calls.filter(c=>c.url==='/v1/gpu/instances');assert.equal(writes.length,1);assert.equal(writes[0].body.continent,'asia');assert.equal(writes[0].body.billing_quote_id,'fixture-quote');assert.equal(writes[0].body.billing_accepted,true);
 }finally{await client.close().catch(()=>{});await transport.close().catch(()=>{});await new Promise(r=>server.close(r));}
});
