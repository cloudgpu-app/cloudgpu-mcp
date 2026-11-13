import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {registerFundingTools} from '../src/funding-tools.js';
import {loadPendingConnect,savePendingConnect,clearPendingConnect} from '../src/credentials.js';
test('pending connection survives restart, stays private, and is bound to origin and expiry',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cgpu-connect-test-')),env={CLOUDGPU_CONFIG_DIR:dir};
 try{const pending={device_code:'a'.repeat(64),base_url:'https://cloudgpu.app',until:Date.now()+10000,interval:5};savePendingConnect(pending,env);assert.deepEqual(loadPendingConnect('https://cloudgpu.app',env),pending);assert.equal(fs.statSync(path.join(dir,'pending-connect.json')).mode&0o777,0o600);assert.equal(loadPendingConnect('https://other.invalid',env),null);savePendingConnect({...pending,until:Date.now()-1},env);assert.equal(loadPendingConnect('https://cloudgpu.app',env),null);clearPendingConnect(env);assert.equal(fs.existsSync(path.join(dir,'pending-connect.json')),false);}finally{fs.rmSync(dir,{recursive:true});}
});
test('top-up tool generates link only; credited funds do not submit a job',async()=>{
 const tools=new Map(),calls=[];registerFundingTools({registerTool:(n,s,f)=>tools.set(n,{s,f})},{api:{request:async(...a)=>{calls.push(a);return{url:'https://cloudgpu.app/billing?amount=5'};},account:async()=>({balance_usd:5,funded:true,last_top_up_at:'2026-11-13T10:00:00Z'})},wrap:f=>f,ok:x=>x,readOnly:false});
 await tools.get('request_top_up').f({amount_usd:5});assert.equal(calls.length,1);assert.equal(calls[0][1],'/v1/billing/top-up-link');assert.equal((await tools.get('wait_for_funds').f({min_balance_usd:5,timeout:0})).ready,true);assert.equal(calls.length,1);
});
test('read-only mode cannot create a payment link and bonus balance is not credited top-up proof',async()=>{
 const tools=new Map();registerFundingTools({registerTool:(n,s,f)=>tools.set(n,{s,f})},{api:{account:async()=>({balance_usd:100,funded:false})},wrap:f=>f,ok:x=>x,readOnly:true});assert.equal(tools.has('request_top_up'),false);assert.equal((await tools.get('wait_for_funds').f({min_balance_usd:5,timeout:0})).ready,false);
});
