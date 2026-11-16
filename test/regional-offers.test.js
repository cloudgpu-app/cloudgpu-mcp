import test from "node:test";
import assert from "node:assert/strict";
import {z} from "zod";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";
import {createServer} from "node:http";
import {registerRegionalOfferTools} from "../src/regional-offers.js";

test("regional discovery encodes the owner's explicit country and never forwards a key",async()=>{
 const calls=[];let tool;
 registerRegionalOfferTools({registerTool:(name,schema,fn)=>{tool={name,schema,fn};}},{api:{request:async(...args)=>{calls.push(args);return {execution_supported:false};}},wrap:f=>f,ok:x=>x});
 const input=z.object(tool.schema.inputSchema).parse({user_country:"JP",gpu_model:"RTX 4090",gpu_count:2});
 assert.equal((await tool.fn(input)).execution_supported,false);assert.equal(calls[0][0],"GET");assert.deepEqual(calls[0][3],{noAuth:true});
 const parsed=new URL(calls[0][1],"https://example.invalid");assert.equal(parsed.searchParams.get("user_country"),"JP");assert.equal(parsed.searchParams.get("gpu_model"),"RTX 4090");assert.equal(parsed.searchParams.get("gpu_count"),"2");assert.equal(tool.schema.annotations.readOnlyHint,true);
 for(const bad of [{gpu_count:9},{user_country:"Japan"},{limit:1000},{after_id:"native-inventory-id"}])assert.equal(z.object(tool.schema.inputSchema).safeParse(bad).success,false);
});

test("actual read-only MCP stdio retrieves canonical regional facts anonymously",async()=>{
 const requests=[],contract={schema_version:"regional-offers/1",read_only:true,execution_supported:false,offers:[],coverage:{does_not_prove_global_stockout:true}};
 const server=createServer((req,res)=>{requests.push({method:req.method,url:req.url,auth:req.headers.authorization});res.setHeader("Content-Type","application/json");res.end(JSON.stringify(contract));});
 await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
 const transport=new StdioClientTransport({command:process.execPath,args:["src/index.js"],env:{...process.env,CLOUDGPU_API_KEY:"synthetic-never-send-to-public-discovery",CLOUDGPU_BASE_URL:`http://127.0.0.1:${server.address().port}`,CLOUDGPU_READ_ONLY:"1"},stderr:"pipe"});transport.stderr?.on("data",()=>{});
 const client=new Client({name:"regional-discovery-fixture",version:"1.0.0"});
 try{
  await client.connect(transport);const list=await client.listTools();assert.ok(list.tools.some(t=>t.name==="list_regional_offers"));
  const result=await client.callTool({name:"list_regional_offers",arguments:{user_country:"US",include_unavailable:true}});
  assert.ok(!result.isError);assert.deepEqual(JSON.parse(result.content[0].text),contract);
  assert.equal(requests.length,1);assert.equal(requests[0].method,"GET");assert.equal(requests[0].auth,undefined);assert.equal(new URL(requests[0].url,"http://localhost").searchParams.get("user_country"),"US");
  // Unknown constraints must not be stripped before dispatch to another tool.
  const invalid=await client.callTool({name:"list_regional_offers",arguments:{region:"must-not-be-ignored"}});
  assert.equal(invalid.isError,true);assert.equal(requests.length,1);
  const invalidQuote=await client.callTool({name:"quote_compute",arguments:{gpu_model:"RTX 4090",region:"JP"}});
  assert.equal(invalidQuote.isError,true);assert.match(invalidQuote.content[0].text,/region/);assert.equal(requests.length,1);
 }finally{await client.close().catch(()=>{});await transport.close().catch(()=>{});await new Promise(resolve=>server.close(resolve));}
});
