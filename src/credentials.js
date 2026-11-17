// Where a key obtained through "connect_account" is kept, so the user does not have to paste it anywhere.
// File: ~/.config/cloudgpu/credentials.json (or $CLOUDGPU_CONFIG_DIR), readable only by the user.
// CLOUDGPU_API_KEY in the environment always wins over the file.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function configDir(env = process.env) {
  return env.CLOUDGPU_CONFIG_DIR || path.join(os.homedir(), ".config", "cloudgpu");
}

export function loadStoredKey(env = process.env) {
  try {
    const file=path.join(configDir(env),"credentials.json"),stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)||(process.getuid&&stat.uid!==process.getuid()))return null;
    const j = JSON.parse(fs.readFileSync(file,"utf8"));
    if(j.base_url!==(env.CLOUDGPU_BASE_URL||"https://cloudgpu.app"))return null;
    if (j && typeof j.api_key === "string" && j.api_key.trim()) {
      if (j.expires_at && Number(j.expires_at) * 1000 < Date.now()) return null;
      return j;
    }
  } catch {
    // no file or unreadable: no stored key
  }
  return null;
}

export function saveStoredKey(cred, env = process.env) {
  cred={...cred,base_url:cred.base_url||(env.CLOUDGPU_BASE_URL||"https://cloudgpu.app")};
  const dir = configDir(env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info=fs.lstatSync(dir);
  if(!info.isDirectory()||info.isSymbolicLink()||(process.getuid&&info.uid!==process.getuid())||(info.mode&0o077))throw new Error('Credential directory must be private and owned by this user.');
  const file = path.join(dir, "credentials.json");
  const tmp = file + "."+process.pid+"."+Date.now()+".tmp";
  try{fs.writeFileSync(tmp,JSON.stringify(cred,null,2),{flag:'wx',mode:0o600});fs.renameSync(tmp,file);fs.chmodSync(file,0o600);}finally{try{fs.unlinkSync(tmp);}catch{}}
  return file;
}

export function loadPendingConnect(baseUrl,env=process.env){
  try{
    const file=path.join(configDir(env),'pending-connect.json'),stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)||(process.getuid&&stat.uid!==process.getuid()))return null;
    const value=JSON.parse(fs.readFileSync(file,'utf8'));
    return value.base_url===baseUrl&&/^[a-f0-9]{64}$/.test(value.device_code)&&Number.isFinite(value.until)&&value.until>Date.now()&&value.until<=Date.now()+1801000&&Number.isFinite(value.interval)&&value.interval>=5?value:null;
  }catch{return null;}
}
export function savePendingConnect(value,env=process.env){
  const dir=configDir(env);fs.mkdirSync(dir,{recursive:true,mode:0o700});
  if(fs.lstatSync(dir).isSymbolicLink())throw new Error('Credential directory must not be a symlink.');
  const file=path.join(dir,'pending-connect.json'),tmp=file+'.'+process.pid+'.'+Date.now()+'.tmp';
  try{fs.writeFileSync(tmp,JSON.stringify(value),{flag:'wx',mode:0o600});fs.renameSync(tmp,file);fs.chmodSync(file,0o600);}finally{try{fs.unlinkSync(tmp);}catch{}}
}
export function clearPendingConnect(env=process.env){try{fs.unlinkSync(path.join(configDir(env),'pending-connect.json'));}catch{}}
