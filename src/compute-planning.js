import {z} from 'zod';
import {rentalBilling} from './rental-billing.js';

// Quotes do not reserve capacity. Compare charged periods, never hourly labels.
export async function compareComputeQuotes(api,{gpu_models,gpu_count=1,hours,max_spend_usd,template},now=Date.now()) {
 const offers=await api.offers(), candidates=[],unavailable=[];
 for(const name of [...new Set(gpu_models)]) {
  const offer=offers.find(o=>o.gpu_model===name);
  if(!offer||offer.available==='none'||gpu_count<(offer.min_gpu_count||1)) {
   unavailable.push({gpu_model:name,reason:'No compatible live offer'});continue;
  }
  try {
   const quote=await api.rentalBillingQuote({gpuModel:name,gpuCount:gpu_count,...(template?{templateId:template}:{})});
   const b=rentalBilling(quote,hours,now);
   candidates.push({gpu_model:name,gpu_count,estimated_cost_usd:b.estimate,
    minimum_charge_usd:b.minimum,preauthorized_usd:b.prepaid,
    billing_increment_seconds:b.increment,expires_at:quote.expiresAt,
    within_gpu_budget:b.estimate<=max_spend_usd&&b.prepaid<=max_spend_usd,
    billing_description:b.increment===3600?'Minimum one hour; each started hour charged in full. Unused charged time is not refunded on voluntary stop.':'Per-minute billing; one-minute minimum.'});
  } catch {
   // Provider errors may contain secrets: expose a fixed reason only.
   unavailable.push({gpu_model:name,reason:'A valid current billing quote could not be obtained'});
  }
 }
 candidates.sort((a,b)=>Number(b.within_gpu_budget)-Number(a.within_gpu_budget)||a.estimated_cost_usd-b.estimated_cost_usd||a.gpu_model.localeCompare(b.gpu_model));
 return {candidates,unavailable,selection_basis:'Estimated billed GPU cost for the supplied duration only',
  performance_verified:false,capacity_reserved:false,creates_gpu:false,
  next:'Check VRAM, image and task compatibility. For the selected rental call estimate_cost again and obtain explicit approval of its billing period, minimum charge, budget and time limit before create_instance. This comparison is not a creation quote or Job compatibility proof.',
  limitations:['Include environment preparation, downloads and result collection in the expected duration.','Execution speed, startup latency, storage, transfer and other ancillary costs are not measured here.','Hourly billing is not supported by every Job or template path; do not substitute a rental quote for a Job quote.']};
}

export function registerComputePlanningTools(server,{api,wrap,ok}) {
 server.registerTool('compare_compute_costs',{
  title:'Compare GPU billing periods and estimated task costs',
  description:'Read-only live quote comparison for up to eight explicit compatible GPU candidates. Accounts for minimum one-hour versus per-minute billing. No capacity reservation, GPU creation, benchmark, automatic selection or approval. Run estimate_cost for the selected rental afterward.',
  inputSchema:{gpu_models:z.array(z.string().min(1).max(120)).min(1).max(8),gpu_count:z.number().int().min(1).max(8).default(1),hours:z.number().positive().max(168),max_spend_usd:z.number().positive(),template:z.string().optional()},
  annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true}
 },wrap(async p=>ok(await compareComputeQuotes(api,p))));
}
