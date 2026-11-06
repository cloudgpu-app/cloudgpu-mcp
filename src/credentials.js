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
    const j = JSON.parse(fs.readFileSync(path.join(configDir(env), "credentials.json"), "utf8"));
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
  const dir = configDir(env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "credentials.json");
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cred, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
  return file;
}
