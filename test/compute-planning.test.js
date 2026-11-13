import test from 'node:test';import assert from 'node:assert/strict';
import {compareComputeQuotes} from '../src/compute-planning.js';
const quote=(rate,increment)=>({billingQuoteId:'not-to-be-returned',currency:'USD',hourlyTotalUsd:rate,incrementSeconds:increment,minimumSeconds:increment,minimumChargeUsd:rate*increment/3600,preauthorizedUsd:rate,expiresAt:2000});
test('short jobs prefer total charged cost, not a lower hourly label; no GPU writes',async()=>{
 const calls=[];const api={offers:async()=>[{gpu_model:'cheap-hour',available:'ok'},{gpu_model:'minute',available:'low'}],rentalBillingQuote:async p=>{calls.push(p);return p.gpuModel==='cheap-hour'?quote(.39,3600):quote(.6,60);}};
 const short=await compareComputeQuotes(api,{gpu_models:['cheap-hour','minute','minute'],hours:.1,max_spend_usd:1},1000);
 assert.deepEqual(short.candidates.map(x=>x.estimated_cost_usd),[.06,.39]);assert.equal(short.candidates[0].gpu_model,'minute');assert.equal(calls.length,2);
 assert.ok(!JSON.stringify(short).includes('not-to-be-returned'));assert.equal(short.creates_gpu,false);
 const long=await compareComputeQuotes(api,{gpu_models:['cheap-hour','minute'],hours:1,max_spend_usd:1},1000);assert.equal(long.candidates[0].gpu_model,'cheap-hour');
});
test('expired quotes, unavailable inventory, count constraints and sensitive errors never become recommendations',async()=>{
 const api={offers:async()=>[{gpu_model:'expired'},{gpu_model:'error'},{gpu_model:'none',available:'none'},{gpu_model:'group',min_gpu_count:8}],rentalBillingQuote:async p=>{if(p.gpuModel==='error')throw Error('secret-token');return {...quote(.5,60),expiresAt:999};}};
 const r=await compareComputeQuotes(api,{gpu_models:['expired','error','none','group','missing'],hours:1,max_spend_usd:1},1000);
 assert.equal(r.candidates.length,0);assert.equal(r.unavailable.length,5);assert.ok(!JSON.stringify(r).includes('secret-token'));
});
test('one second over an hour charges two hours, preauthorization also must fit budget',async()=>{
 const api={offers:async()=>[{gpu_model:'hour'}],rentalBillingQuote:async()=>quote(.39,3600)};
 const r=await compareComputeQuotes(api,{gpu_models:['hour'],hours:3601/3600,max_spend_usd:.5},1000);assert.equal(r.candidates[0].estimated_cost_usd,.78);assert.equal(r.candidates[0].within_gpu_budget,false);
 const m={offers:api.offers,rentalBillingQuote:async()=>quote(1,60)};
 const s=await compareComputeQuotes(m,{gpu_models:['hour'],hours:.1,max_spend_usd:.2},1000);assert.equal(s.candidates[0].within_gpu_budget,false);
});
