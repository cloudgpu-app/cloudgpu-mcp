import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {loadStoredKey,saveStoredKey,savePendingConnect,loadPendingConnect} from '../src/credentials.js';
test('stored credentials bind to origin and reject public or symlink files',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cgpu-credentials-')),env={CLOUDGPU_CONFIG_DIR:dir};
 try{
 const cred={api_key:'fixture-only',base_url:'https://cloudgpu.app',expires_at:Math.floor(Date.now()/1000)+60};
 const file=saveStoredKey(cred,env);assert.equal(loadStoredKey(env).api_key,cred.api_key);
 assert.equal(loadStoredKey({...env,CLOUDGPU_BASE_URL:'https://other.example'}),null);
 fs.chmodSync(file,0o644);assert.equal(loadStoredKey(env),null);fs.unlinkSync(file);
 const outside=path.join(dir,'other.json');fs.writeFileSync(outside,JSON.stringify(cred),{mode:0o600});fs.symlinkSync(outside,file);assert.equal(loadStoredKey(env),null);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('pending connect survives reload, expires and stays on its original server',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cgpu-pending-')),env={CLOUDGPU_CONFIG_DIR:dir};
 try{const p={base_url:'https://cloudgpu.app',device_code:'a'.repeat(64),until:Date.now()+60000,interval:5};savePendingConnect(p,env);assert.deepEqual(loadPendingConnect(p.base_url,env),p);assert.equal(loadPendingConnect('https://other.example',env),null);savePendingConnect({...p,until:Date.now()-1},env);assert.equal(loadPendingConnect(p.base_url,env),null);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
