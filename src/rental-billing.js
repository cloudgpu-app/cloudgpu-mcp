// 验证服务端的计费契约，不从小时单价猜测最低收费。
export function rentalBilling(b,hours,now=Date.now()){
 if(!b||!['number','string'].includes(typeof b.hourlyTotalUsd)||![60,3600].includes(b.incrementSeconds)||b.minimumSeconds!==b.incrementSeconds||b.currency!=='USD'||typeof b.billingQuoteId!=='string'||!b.billingQuoteId||!Number.isFinite(b.expiresAt)||b.expiresAt<=now||!Number.isFinite(hours)||hours<=0)throw new Error('A current server billing quote is required before renting.');
 const rate=Number(b.hourlyTotalUsd),minimum=Number(b.minimumChargeUsd),prepaid=Number(b.preauthorizedUsd);
 if(!Number.isFinite(rate)||rate<=0||!Number.isFinite(minimum)||minimum<=0||!Number.isFinite(prepaid)||prepaid<minimum||Math.abs(minimum-rate*b.incrementSeconds/3600)>0.0000001)throw new Error('Invalid rental billing amounts.');
 const billedSeconds=Math.max(b.incrementSeconds,Math.ceil(hours*3600/b.incrementSeconds)*b.incrementSeconds);
 return {hourly:rate,increment:b.incrementSeconds,estimate:Math.ceil(rate*billedSeconds/3600*10000-1e-9)/10000,minimum,prepaid};
}
