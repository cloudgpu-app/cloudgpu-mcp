// 只向 Hugging Face 的固定公开 API 解析引用，不携带 CloudGPU key 或用户 token。
import {createHash} from 'node:crypto';
export async function resolveModelReference({repo_id, revision = "main", name, files}, fetchImpl = globalThis.fetch) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(repo_id)
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(revision)
    || !/^[A-Za-z][A-Za-z0-9_-]{0,47}$/.test(name)
    || !Array.isArray(files) || !files.length || files.length > 32 || new Set(files).size !== files.length
    || files.some(p => typeof p !== "string" || p.length > 240 || !/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(p) || p.split("/").some(s => !s || s === "." || s === ".."))) throw new Error("Invalid public model reference");
  const url = `https://huggingface.co/api/models/${repo_id}/revision/${encodeURIComponent(revision)}?blobs=true`;
  const response = await fetchImpl(url, {headers:{"User-Agent":"CloudGPU-model-reference/1"}, redirect:"error", signal:AbortSignal.timeout(15000)});
  if (!response.ok) throw new Error("Public model metadata unavailable; check repository, revision and public access");
  const reader=response.body.getReader();const chunks=[];let bytes=0;
  try {while(true){const r=await reader.read();if(r.done)break;bytes+=r.value.byteLength;if(bytes>2*1024*1024)throw new Error("Model metadata exceeds limit; use a smaller repository or supply a pinned manifest");chunks.push(r.value);}}
  finally {await reader.cancel();}
  let data;try{data=JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{throw new Error("Invalid public model metadata");}
  if (data.private || data.gated) throw new Error("Private or gated models are not supported; select a public model without an access gate");
  if (!/^[0-9a-f]{40}$/.test(data.sha)) throw new Error("Model revision could not be pinned");
  const selected=files.map(path=>{
    const file=data.siblings?.find(f=>f.rfilename===path);const size=file?.lfs?.size ?? file?.size;
    if(!Number.isSafeInteger(size)||size<1)throw new Error("Requested file metadata missing or empty");
    const sha=file?.lfs?.sha256;
    if(sha!==undefined&&!/^[0-9a-f]{64}$/.test(sha))throw new Error("Invalid file checksum metadata");
    return {path,size_bytes:size,...(sha?{sha256:sha}:{})};
  });
  if(selected.reduce((n,f)=>n+f.size_bytes,0)>100_000_000_000)throw new Error("Model exceeds the first-version 100 GB job limit");
  // Git-backed config files have no LFS SHA. Hash bounded public JSON metadata
  // on the origin so the GPU can verify it even when using its existing mirror.
  const configs=selected.filter(f=>!f.sha256&&f.path.endsWith('.json')&&f.size_bytes<=65536);
  if(configs.length>8)throw new Error('Too many unhashed JSON metadata files; supply an independently verified manifest');
  const deadline=Date.now()+15000;
  for(const file of configs){
    const remaining=deadline-Date.now();
    if(remaining<=0)throw new Error('Model config metadata deadline exceeded');
    const config=await fetchImpl(`https://huggingface.co/${repo_id}/raw/${data.sha}/${file.path.split('/').map(encodeURIComponent).join('/')}`,
      {headers:{'User-Agent':'CloudGPU-model-reference/1'},redirect:'error',signal:AbortSignal.timeout(remaining)});
    if(!config.ok)throw new Error('Public model config metadata unavailable');
    const stream=config.body.getReader();const content=[];let size=0;
    try{while(true){const r=await stream.read();if(r.done)break;size+=r.value.byteLength;if(size>file.size_bytes)throw new Error('Model config metadata size mismatch');content.push(r.value);}}
    finally{await stream.cancel();}
    if(size!==file.size_bytes)throw new Error('Model config metadata size mismatch');
    file.sha256=createHash('sha256').update(Buffer.concat(content)).digest('hex');
  }
  return {name,repo_id,revision:data.sha,files:selected};
}
