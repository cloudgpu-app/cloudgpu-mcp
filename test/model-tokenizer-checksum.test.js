import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {resolveModelReference} from '../src/model-references.js';
test('bounded multi-megabyte tokenizer obtains an independent checksum so configured mirror can be used safely',async()=>{
 const body=Buffer.alloc(2*1024*1024,'x'),revision='a'.repeat(40),urls=[];
 const result=await resolveModelReference({repo_id:'Example/Model',revision:'main',name:'model',files:['tokenizer.json']},async(url,opts)=>{urls.push(url);assert.equal(opts.headers.Authorization,undefined);return url.includes('/api/models/')?new Response(JSON.stringify({sha:revision,siblings:[{rfilename:'tokenizer.json',size:body.length}]})):new Response(body);});
 assert.equal(result.files[0].sha256,createHash('sha256').update(body).digest('hex'));assert.equal(urls.length,2);assert.ok(urls[1].startsWith('https://huggingface.co/Example/Model/raw/'+revision));
});
