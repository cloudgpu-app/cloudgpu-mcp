import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {publicationMatches,registryPublication} from '../scripts/registry-publication.mjs';
const manifest=JSON.parse(fs.readFileSync('server.json'));
const response=(server,status=200)=>({status,ok:status===200,json:async()=>({server})});
test('matching immutable record and latest alias are safe to replay',async()=>{
 let calls=0;assert.equal(await registryPublication(manifest,{fetchImpl:async()=>{calls++;return response({...manifest,_meta:{extra:true}})}}),true);assert.equal(calls,2);
});
test('missing version permits initial publication but unavailable lookup does not',async()=>{
 assert.equal(await registryPublication(manifest,{fetchImpl:async()=>response(null,404)}),false);
 await assert.rejects(registryPublication(manifest,{fetchImpl:async()=>response(null,503)}));
});
test('wrong namespace or package version cannot impersonate current release',()=>{
 for(const modify of [s=>s.name='io.github.old/cloudgpu-mcp',s=>s.packages[0].version='0.13.1',s=>s.remotes=[]]){const other=structuredClone(manifest);modify(other);assert.equal(publicationMatches(manifest,other),false);}
});
test('different immutable content and stale latest alias fail closed',async()=>{
 await assert.rejects(registryPublication(manifest,{fetchImpl:async()=>response({...manifest,description:'different'})}));
 let calls=0;await assert.rejects(registryPublication(manifest,{fetchImpl:async()=>response(++calls===1?manifest:{...manifest,version:'0.13.1'})}));
});
