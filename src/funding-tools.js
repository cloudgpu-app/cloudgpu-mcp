import {z} from 'zod';
export function registerFundingTools(server,{api,wrap,ok,readOnly,sleep=ms=>new Promise(r=>setTimeout(r,ms))}){
 if(!readOnly)server.registerTool('request_top_up',{title:'Request an owner payment link',description:'Creates a short-lived link only. No checkout, card charge or transfer is made. Show the link to the human owner; never complete payment for them. Payment completion does not approve a GPU quote.',inputSchema:{amount_usd:z.number().min(1).max(10000)},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:true}},wrap(async({amount_usd})=>ok(await api.request('POST','/v1/billing/top-up-link',{amount_usd}))));
 server.registerTool('wait_for_funds',{title:'Wait for credited account funds',description:'Read-only polling of actual account balance and real-top-up signal for up to 60 seconds. No payment, job submission or authorization. If still pending, return to the owner; do not blindly repeat rentals.',inputSchema:{min_balance_usd:z.number().positive().max(100000),timeout:z.number().int().min(0).max(60).default(30)},annotations:{readOnlyHint:true,openWorldHint:true}},wrap(async({min_balance_usd,timeout=30})=>{
  const deadline=Date.now()+Math.min(60,Math.max(0,timeout))*1000;
  for(;;){const account=await api.account();const amount=Number(account.balance_usd);const funded=account.funded===true&&Number.isFinite(amount)&&amount>=min_balance_usd;
   if(funded||Date.now()>=deadline)return ok({ready:funded,balance_usd:account.balance_usd,last_top_up_at:account.last_top_up_at??null,top_up_url:account.top_up_url??null,next:funded?'Funds are credited. Obtain or recheck the exact quote and user approval before spending.':'Waiting for credited funds; ask the owner to finish payment. Do not submit a paid task.'});
   await sleep(Math.min(5000,deadline-Date.now()));
  }
 }));
}
