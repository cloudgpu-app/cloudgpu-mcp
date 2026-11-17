import {z} from "zod";

/** Discovery only; no implicit owner geolocation, quote, procurement or data migration. */
export const CONTINENTS=["asia","europe","north_america","oceania","south_america","africa"];
export function registerRegionalOfferTools(server,{api,wrap,ok}){
  server.registerTool("list_rental_regions",{
    title:"List rentable GPUs by continent",
    description:"Read-only qualified continent catalog shared with the rental UI. Use enabled and inventory/capability/count constraints. Request estimate_cost with the same continent before renting. Countries and individual datacenters are not selectable. Empty inventory does not authorize renting in another continent.",
    inputSchema:{continent:z.enum(CONTINENTS).optional()},
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true},
  },wrap(async ({continent})=>ok(await api.request("GET","/v1/public/rental-regions"+(continent?"?continent="+encodeURIComponent(continent):""),undefined,{noAuth:true}))));

  server.registerTool("list_regional_offers",{
    title:"Inspect regional compute observations",
    description:"Anonymous, read-only native regional stock observations, independent price evidence ages, billing references and known/unknown limits. Supply the human owner's country explicitly; the Agent server IP is not its owner's location. Counts are not reservations or verified single-host multi-GPU allocations. Published SKU references are not region-bound executable quotes; dynamic regional pricing and exact-region execution are not activated. Unsupported, stale or failed observations do not prove global stockout. Follow has_more/next_after_id; pagination is a live view, not a frozen snapshot.",
    inputSchema:{user_country:z.string().regex(/^[A-Za-z]{2}$/).optional(),country_code:z.string().regex(/^[A-Za-z]{2}$/).optional(),gpu_model:z.string().max(100).optional(),gpu_count:z.number().int().min(1).max(8).default(1),include_unavailable:z.boolean().default(false),limit:z.number().int().min(1).max(200).default(100),after_id:z.string().regex(/^offer_[a-f0-9]{32}$/).optional()},
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true},
  },wrap(async input=>{
    const query=new URLSearchParams();
    for(const field of ["user_country","country_code","gpu_model","gpu_count","include_unavailable","limit","after_id"])
      if(input[field]!==undefined)query.set(field,String(input[field]));
    const encoded=query.toString();
    return ok(await api.request("GET","/v1/public/compute-offers"+(encoded?"?"+encoded:""),undefined,{noAuth:true}));
  }));
}
