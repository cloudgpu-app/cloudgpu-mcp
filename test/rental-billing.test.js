import test from 'node:test';import assert from 'node:assert/strict';import {rentalBilling} from '../src/rental-billing.js';
const quote=(increment=60)=>({billingQuoteId:'synthetic',incrementSeconds:increment,minimumSeconds:increment,currency:'USD',expiresAt:2000,hourlyTotalUsd:.39,minimumChargeUsd:.39*increment/3600,preauthorizedUsd:.39});
test('same hourly rate remains minute billing for legacy sources and hourly only for the explicit quote',()=>{
 assert.equal(rentalBilling(quote(),.25,1000).estimate,.0975);
 assert.equal(rentalBilling(quote(3600),.25,1000).estimate,.39);
 assert.equal(rentalBilling(quote(3600),1,1000).estimate,.39);
 assert.equal(rentalBilling(quote(3600),1.00001,1000).estimate,.78);
 assert.equal(rentalBilling(quote(),1/3600,1000).estimate,.0065);
});
test('expiry, wrong increments and inconsistent minimums fail before a create request can be prepared',()=>{
 for(const q of [{...quote(),expiresAt:1000},{...quote(),incrementSeconds:0},{...quote(),currency:'CNY'},{...quote(),minimumChargeUsd:.39},{...quote(),hourlyTotalUsd:'NaN'},{...quote(),billingQuoteId:''}])assert.throws(()=>rentalBilling(q,.25,1000));
});

test('rental billing carries the approved GPU and disk split', () => {
 const withDisk = {...quote(), hourlyTotalUsd:.79, minimumChargeUsd:.79/60,
  preauthorizedUsd:.79, gpuHourlyUsd:.76, diskHourlyUsd:.03, diskGb:100};
 const billing = rentalBilling(withDisk, .25, 1000);
 assert.deepEqual([billing.gpuHourly, billing.diskHourly, billing.diskGb], [.76,.03,100]);
 assert.throws(() => rentalBilling({...withDisk,diskHourlyUsd:.10},.25,1000));
});
