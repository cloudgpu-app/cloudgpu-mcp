// 重跑发布时先核对不可变版本，不能把“同版本已存在”误报成同步失败。
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
const origin='https://registry.modelcontextprotocol.io/v0.1/servers/';
function project(server){
  return {
    name:server?.name,version:server?.version,description:server?.description,
    repository:server?.repository?.url,website:server?.websiteUrl,
    packages:(server?.packages||[]).map(p=>({registry:p.registryType,base:p.registryBaseUrl,identifier:p.identifier,version:p.version,runtime:p.runtimeHint,transport:p.transport?.type,env:(p.environmentVariables||[]).map(e=>({name:e.name,secret:!!e.isSecret,required:!!e.isRequired})).sort((a,b)=>a.name.localeCompare(b.name))})),
    remotes:(server?.remotes||[]).map(r=>({type:r.type,url:r.url})),
  };
}
export function publicationMatches(manifest,published){return JSON.stringify(project(manifest))===JSON.stringify(project(published));}
export async function registryPublication(manifest,{fetchImpl=fetch}={}){
  const base=origin+encodeURIComponent(manifest.name)+'/versions/';
  const get=async version=>{
    const r=await fetchImpl(base+encodeURIComponent(version),{headers:{'Cache-Control':'no-cache','User-Agent':'CloudGPU-Registry-Publication-Check/1'},signal:AbortSignal.timeout(15000)});
    if(r.status===404)return null;
    if(!r.ok)throw Error(`Registry lookup unavailable: HTTP ${r.status}`);
    const d=await r.json();return d.server||d;
  };
  const existing=await get(manifest.version);
  if(!existing)return false;
  if(!publicationMatches(manifest,existing))throw Error('Registry immutable version exists with different release metadata; refusing overwrite');
  const latest=await get('latest');
  if(!latest||!publicationMatches(manifest,latest))throw Error('Expected immutable version exists but latest alias differs; Registry review needed');
  return true;
}
async function main(){
  const m=JSON.parse(fs.readFileSync('server.json','utf8')),p=JSON.parse(fs.readFileSync('package.json','utf8'));
  if(m.name!==p.mcpName||m.version!==p.version||!m.packages?.some(x=>x.identifier===p.name&&x.version===p.version))throw Error('npm/Registry release identity mismatch');
  const published=await registryPublication(m);
  if(process.argv.includes('--required')&&!published)throw Error('Registry publication not yet visible');
  if(process.env.GITHUB_OUTPUT)fs.appendFileSync(process.env.GITHUB_OUTPUT,`published=${published}\n`);
  const summary=`Registry ${m.name}@${m.version}: ${published?'matching immutable version and latest alias verified':'not published yet'}\n`;
  if(process.env.GITHUB_STEP_SUMMARY)fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,summary);
  console.log(summary.trim());
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.error('Registry verification failed; no existing version overwritten and no credentials logged');process.exitCode=1;});
