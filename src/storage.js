// 持久文件直接流向对象存储；长期 key 只发给 CloudGPU，不发给签名 URL 的主机。
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { sensitiveReason } from "./guards.js";
import { z } from "zod";

export class PersistentStorage {
  constructor(api, fetchImpl = globalThis.fetch) { this.api = api; this.fetch = fetchImpl; }
  async upload(local, purpose = "artifact", name = path.basename(local)) {
    const stat = await fsp.stat(local);
    if (!stat.isFile()) throw new Error("Upload needs a regular file.");
    const file = await this.api.request("POST", "/v1/files", { name, purpose, size_bytes: stat.size });
    try {
      for (let i = 1, offset = 0; i <= file.part_count; i++) {
        const part = await this.api.request("POST", `/v1/files/${file.file_id}/parts/${i}`, {});
        if (!String(part.url).startsWith("https://")) throw new Error("Storage must use HTTPS.");
        const len = Number(part.content_length);
        if (!Number.isSafeInteger(len) || len < 0 || offset + len > stat.size || (len === 0 && stat.size !== 0)) throw new Error("Invalid upload reservation.");
        const stream = len === 0 ? Buffer.alloc(0) : fs.createReadStream(local, { start: offset, end: offset + len - 1 });
        try {
          const res = await this.fetch(part.url, { method: "PUT", headers: { "Content-Length": String(len) }, body: stream, duplex: "half", redirect: "error" });
          if (!res.ok) throw new Error("Part upload failed.");
          if (res.body) await res.body.cancel();
        } catch { throw new Error("Storage part upload failed; no credentials were sent to the API response."); }
        finally { if (stream.destroy) stream.destroy(); }
        offset += len;
      }
      const after = await fsp.stat(local);
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error("File changed during upload; snapshot was not saved.");
      return await this.api.request("POST", `/v1/files/${file.file_id}/complete`, {});
    } catch (e) {
      await this.api.request("DELETE", `/v1/files/${file.file_id}`).catch(() => {});
      throw e;
    }
  }
  async download(id, local) {
    const transfer = await this.api.request("POST", `/v1/files/${encodeURIComponent(id)}/download`, {});
    if (!String(transfer.url).startsWith("https://")) throw new Error("Storage must use HTTPS.");
    const expected = Number(transfer.size_bytes);
    if (!Number.isSafeInteger(expected) || expected < 0) throw new Error("Invalid file size.");
    await fsp.mkdir(path.dirname(local), { recursive: true });
    const handle = await fsp.open(local, "wx", 0o600); // 不覆盖已有结果。
    try {
      const res = await this.fetch(transfer.url, { redirect: "error" });
      if (!res.ok || !res.body) throw new Error("Download failed.");
      let received = 0;
      const bounded = new Transform({ transform(chunk, _encoding, done) {
        received += chunk.length;
        done(received > expected ? new Error("Storage returned excess bytes.") : null, received > expected ? undefined : chunk);
      } });
      await pipeline(Readable.fromWeb(res.body), bounded, handle.createWriteStream());
      if ((await fsp.stat(local)).size !== Number(transfer.size_bytes)) throw new Error("Downloaded size mismatch.");
      return { local_path: local, bytes: transfer.size_bytes };
    } catch {
      await handle.close().catch(() => {}); await fsp.unlink(local).catch(() => {});
      throw new Error("Storage download failed; the partial file was removed.");
    }
  }
  async saveWorkspace(localDir, name, workspaceId) {
    const root = path.resolve(localDir), selected = [];
    const walk = async dir => {
      for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
        if ([".git", "node_modules", "__pycache__", ".venv"].includes(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isSymbolicLink()) throw new Error("Workspace contains a symlink; choose regular project files.");
        if (sensitiveReason(full)) throw new Error("Workspace contains a credential file. Remove it before saving.");
        if (e.isDirectory()) await walk(full);
        else if (e.isFile()) selected.push({ full, rel: path.relative(root, full).split(path.sep).join("/") });
      }
    };
    await walk(root);
    // Job runner 当前一次恢复最多 100 个文件；不悄悄保存一个不能用的工作区。
    if (selected.length < 1 || selected.length > 100) throw new Error("Workspace must contain 1–100 regular files; binary environments and full disk images are not supported.");
    const created = [], manifest = {};
    try {
      for (const file of selected) {
        const saved = await this.upload(file.full, "workspace", file.rel);
        created.push(saved.file_id); manifest[file.rel] = saved.file_id;
      }
      const ws = workspaceId ? { workspace_id: workspaceId } : await this.api.request("POST", "/v1/workspaces", { name });
      const version = await this.api.request("POST", `/v1/workspaces/${encodeURIComponent(ws.workspace_id)}/versions`, manifest);
      return { ...version, workspace_version_id: version.version_id };
    } catch (e) {
      for (const id of created) await this.api.request("DELETE", `/v1/files/${id}`).catch(() => {});
      throw e;
    }
  }
}

export function registerStorageTools(server, { api, wrap, ok, fail, readOnly, expandHome }) {
  const client = new PersistentStorage(api);
  server.registerTool("get_storage", { title: "Persistent storage quota", description: "Storage availability, used bytes, reserved uploads and account quota. No money is spent.", inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: true } }, wrap(async () => ok(await api.request("GET", "/v1/storage"))));
  server.registerTool("list_files", { title: "List persistent files", description: "Persistent artifacts, model/data files and Workspace files. Availability depends on storage being enabled.", inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: true } }, wrap(async () => ok(await api.request("GET", "/v1/files"))));
  server.registerTool("list_workspaces", { title: "List Workspaces", description: "Saved project Workspaces; versions are immutable file manifests.", inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: true } }, wrap(async () => ok(await api.request("GET", "/v1/workspaces"))));
  server.registerTool("list_workspace_versions", { title: "List Workspace versions", description: "List saved immutable versions of an owned Workspace.", inputSchema: { workspace_id: z.string() }, annotations: { readOnlyHint: true } }, wrap(async ({ workspace_id }) => ok(await api.request("GET", `/v1/workspaces/${encodeURIComponent(workspace_id)}/versions`))));
  server.registerTool("get_workspace_version", { title: "Read Workspace version", description: "Read the path-to-file manifest for an owned version.", inputSchema: { version_id: z.string() }, annotations: { readOnlyHint: true } }, wrap(async ({ version_id }) => ok(await api.request("GET", `/v1/workspace-versions/${encodeURIComponent(version_id)}`))));
  if (readOnly) return;
  server.registerTool("delete_workspace_version", {
    title: "Delete Workspace version", description: "Deletes a saved version, releasing its file references. Refuses versions pinned by active Jobs. Ask the user first.",
    inputSchema: { version_id: z.string(), user_confirmed: z.boolean() }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  }, wrap(async ({ version_id, user_confirmed }) => user_confirmed === true ? ok(await api.request("DELETE", `/v1/workspace-versions/${encodeURIComponent(version_id)}`)) : fail("Ask the user before deleting the Workspace version.")));

  server.registerTool("upload_artifact", {
    title: "Save a persistent artifact", description: "Uploads a local regular file in resumable-sized parts. Consumes storage quota; retention and pricing depend on the account policy. Credential files are refused.",
    inputSchema: { local_path: z.string(), purpose: z.enum(["artifact", "model", "dataset"]).default("artifact") },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, wrap(async ({ local_path, purpose = "artifact" }) => {
    const local = path.resolve(expandHome(local_path));
    if (sensitiveReason(local)) return fail("Credential files cannot be saved as artifacts.");
    if ((await fsp.lstat(local)).isSymbolicLink()) return fail("Choose a regular file, not a symlink.");
    return ok(await client.upload(local, purpose));
  }));
  server.registerTool("download_artifact", {
    title: "Download a persistent file", description: "Streams a persistent file to this computer. Never overwrites an existing local file.",
    inputSchema: { file_id: z.string(), local_path: z.string() }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, wrap(async ({ file_id, local_path }) => ok(await client.download(file_id, path.resolve(expandHome(local_path))))));
  server.registerTool("save_workspace", {
    title: "Save a project Workspace", description: "Saves 1–100 regular project files as an immutable version. Refuses secrets and symlinks; skips .git, node_modules, __pycache__ and .venv. Save dependency manifests, not the operating system. Pass the returned workspace_version_id to run_job.",
    inputSchema: { local_dir: z.string(), name: z.string().min(1).max(120), workspace_id: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, wrap(async ({ local_dir, name, workspace_id }) => ok(await client.saveWorkspace(expandHome(local_dir), name, workspace_id))));
  server.registerTool("delete_file", {
    title: "Delete a persistent file", description: "Permanently deletes a persistent file or cancels an unfinished upload. Files pinned by a Workspace version cannot be deleted.",
    inputSchema: { file_id: z.string(), user_confirmed: z.boolean() }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, wrap(async ({ file_id, user_confirmed }) => user_confirmed === true ? ok(await api.request("DELETE", `/v1/files/${encodeURIComponent(file_id)}`)) : fail("Ask the user before deleting the file.")));
}
