// 持久文件直接流向对象存储；长期 key 只发给 CloudGPU，不发给签名 URL 的主机。
import fs from "node:fs";
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { Readable } from "node:stream";
import { sensitiveReason } from "./guards.js";
import { z } from "zod";

export class PersistentStorage {
  constructor(api, fetchImpl = globalThis.fetch) { this.api = api; this.fetch = fetchImpl; }
  async digest(local) {
    const hash = createHash("sha256");
    for await (const chunk of fs.createReadStream(local)) hash.update(chunk);
    return hash.digest("hex");
  }
  async upload(local, purpose = "artifact", name = path.basename(local), acceptStorageCharges = false, resume) {
    const stat = await fsp.lstat(local);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Upload needs a regular file.");
    const digest = await this.digest(local);
    if (resume && digest !== resume.sha256) throw new Error("Local file differs from the original upload; do not mix file versions.");
    const file = resume
      ? await this.api.request("GET", `/v1/files/${encodeURIComponent(resume.file_id)}/upload`)
      : await this.api.request("POST", "/v1/files", { name, purpose, size_bytes: stat.size, accept_storage_charges: acceptStorageCharges === true });
    if (resume && (Number(file.size_bytes) !== stat.size || file.name !== name)) throw new Error("Upload reservation differs from local file.");
    const uploaded = new Set((file.uploaded_parts || []).map(p => Number(p.part_number)));
    let offset = 0;
    for (let i = 1; i <= file.part_count; i++) {
      const expected = Math.min(Number(file.part_size_bytes), stat.size - offset);
      if (!uploaded.has(i)) {
        let done = false;
        for (let attempt = 0; attempt < 3 && !done; attempt++) {
          try {
            const part = await this.api.request("POST", `/v1/files/${file.file_id}/parts/${i}`, {});
            if (!String(part.url).startsWith("https://") || Number(part.content_length) !== expected) throw new Error("Invalid upload reservation.");
            const stream = expected === 0 ? Buffer.alloc(0) : fs.createReadStream(local, { start: offset, end: offset + expected - 1 });
            try {
              const response = await this.fetch(part.url, { method: "PUT", headers: { "Content-Length": String(expected) }, body: stream, duplex: "half", redirect: "error", signal: AbortSignal.timeout(300000) });
              if (response.body) await response.body.cancel();
              if (!response.ok) throw new Error("Part failed.");
              done = true;
            } finally { if (stream.destroy) stream.destroy(); }
          } catch { /* Renew only this part; never allocate a second reservation. */ }
        }
        if (!done) throw new Error(`Upload paused. Resume file_id=${file.file_id}, sha256=${digest}; reservation expires after 24 hours. No signed URL is retained.`);
      }
      offset += expected;
    }
    const after = await fsp.stat(local);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || await this.digest(local) !== digest) {
      await this.api.request("DELETE", `/v1/files/${file.file_id}`).catch(() => {});
      throw new Error("File changed during upload; snapshot was not saved.");
    }
    try { return await this.api.request("POST", `/v1/files/${file.file_id}/complete`, {}); }
    catch { throw new Error(`Upload completion uncertain for file_id=${file.file_id}. Check list_files and retry completion; do not delete or create another upload.`); }
  }
  async download(id, local) {
    await fsp.mkdir(path.dirname(local), { recursive: true });
    const handle = await fsp.open(local, "wx", 0o600);
    let received = 0, expected;
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const transfer = await this.api.request("POST", `/v1/files/${encodeURIComponent(id)}/download`, {});
          if (!String(transfer.url).startsWith("https://")) throw new Error("HTTPS required.");
          const size = Number(transfer.size_bytes);
          if (!Number.isSafeInteger(size) || size < 0 || (expected !== undefined && expected !== size)) throw new Error("Invalid immutable file size.");
          expected = size;
          const response = await this.fetch(transfer.url, { redirect: "error", headers: received ? { Range: `bytes=${received}-` } : {}, signal: AbortSignal.timeout(300000) });
          try {
            if (!response.ok || !response.body) throw new Error("Download failed.");
            if (received && (response.status !== 206 || response.headers.get("content-range") !== `bytes ${received}-${expected - 1}/${expected}`)) throw new Error("Invalid resume range.");
            for await (const chunk of Readable.fromWeb(response.body)) {
              if (received + chunk.length > expected) throw new Error("Excess file bytes.");
              let written = 0;
              while (written < chunk.length) {
                const result = await handle.write(chunk, written, chunk.length - written, received + written);
                if (!result.bytesWritten) throw new Error("Local write failed.");
                written += result.bytesWritten;
              }
              received += chunk.length;
            }
          } finally { if (response.body && !response.body.locked) await response.body.cancel().catch(() => {}); }
          if (received !== expected) throw new Error("Incomplete download.");
          await handle.close();
          return { local_path: local, bytes: expected };
        } catch { if (attempt === 3) throw new Error("Transfer failed."); }
      }
    } catch {
      await handle.close().catch(() => {}); await fsp.unlink(local).catch(() => {});
      throw new Error("Storage download failed after bounded resume attempts; the partial file was removed.");
    }
  }
  async saveWorkspace(localDir, name, workspaceId, acceptStorageCharges = false) {
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
        const saved = await this.upload(file.full, "workspace", file.rel, acceptStorageCharges);
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
  server.registerTool("list_workspace_instances", { title: "Running GPUs for Workspace restore", description: "Lists your running GPUs that this key may access. Budgeted Agent keys only see instances created by the same key.", inputSchema: {}, annotations: { readOnlyHint: true } }, wrap(async () => ok(await api.request("GET", "/v1/workspace-instances"))));
  server.registerTool("get_workspace_application", { title: "Workspace application status", description: "Check file restoration on an existing GPU. This does not create, stop or restart a GPU. An uncertain result must be checked, never automatically resubmitted.", inputSchema: { version_id: z.string(), instance_id: z.string().regex(/^[0-9]{1,32}$/) }, annotations: { readOnlyHint: true } }, wrap(async ({ version_id, instance_id }) => ok(await api.request("GET", `/v1/workspace-versions/${encodeURIComponent(version_id)}/applications/${encodeURIComponent(instance_id)}`))));
  if (readOnly) return;
  server.registerTool("quote_storage_budget", {
    title: "Quote separate storage budget", description: "Quote reserving GPU wallet funds for persistent storage, or returning unused surplus. No transfer yet. Shows USD rate, budget-based capacity and 30-day file expiry. Budget-limited keys cannot move funds; ask owner to use Web or unrestricted key.",
    inputSchema: { action: z.enum(["reserve", "release"]), amount_usd: z.number().positive().max(1000000) }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, wrap(async ({ action, amount_usd }) => ok(await api.request("POST", "/v1/storage/budget/quotes", { action, amount_usd }))));
  server.registerTool("confirm_storage_budget", {
    title: "Confirm storage budget transfer", description: "Moves wallet funds only after the user approves the exact quote. Retrying the same quote cannot transfer twice. Reservation is not billed usage; daily actual peak consumes the budget. Never approve automatically.",
    inputSchema: { quote_id: z.string().regex(/^sbq_[a-f0-9]{32}$/), user_confirmed: z.boolean() }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, wrap(async ({ quote_id, user_confirmed }) => user_confirmed === true ? ok(await api.request("POST", `/v1/storage/budget/quotes/${quote_id}/confirm`, { user_confirmed })) : fail("Ask the user to approve the exact storage quote first.")));
  server.registerTool("resume_artifact_upload", {
    title: "Resume interrupted file upload", description: "Resume the same unexpired multipart reservation. Requires the original SHA-256 reported when upload paused. Skips completed parts; renews expiring URLs. Never mixes changed files or creates another reservation.",
    inputSchema: { local_path: z.string(), file_id: z.string().regex(/^file_[a-f0-9]{32}$/), sha256: z.string().regex(/^[a-f0-9]{64}$/) }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, wrap(async ({ local_path, file_id, sha256 }) => { const local = path.resolve(expandHome(local_path)); if (sensitiveReason(local)) return fail("Credential files cannot be uploaded."); return ok(await client.upload(local, "artifact", path.basename(local), false, { file_id, sha256 })); }));
  server.registerTool("apply_workspace", {
    title: "Apply Workspace to running GPU", description: "Restore project files to a new private directory on your existing running GPU. Does not install dependencies, execute code, overwrite existing files, rent, restart or stop a GPU. GPU rental billing continues; transfer consumes its network and disk. Ask the user before applying. Repeat requests for the same version and instance return the existing result; failures require inspection, not automatic retries.",
    inputSchema: { version_id: z.string(), instance_id: z.string().regex(/^[0-9]{1,32}$/), user_confirmed: z.boolean() }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, wrap(async ({ version_id, instance_id, user_confirmed }) => user_confirmed === true ? ok(await api.request("POST", `/v1/workspace-versions/${encodeURIComponent(version_id)}/applications/${encodeURIComponent(instance_id)}`, {})) : fail("Ask the user before applying files to their running GPU.")));
  server.registerTool("delete_workspace_version", {
    title: "Delete Workspace version", description: "Deletes a saved version, releasing its file references. Refuses versions pinned by active Jobs. Ask the user first.",
    inputSchema: { version_id: z.string(), user_confirmed: z.boolean() }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  }, wrap(async ({ version_id, user_confirmed }) => user_confirmed === true ? ok(await api.request("DELETE", `/v1/workspace-versions/${encodeURIComponent(version_id)}`)) : fail("Ask the user before deleting the Workspace version.")));

  server.registerTool("upload_artifact", {
    title: "Save a persistent artifact", description: "Uploads a local regular file in resumable-sized parts. Consumes storage quota; retention and pricing depend on the account policy. Credential files are refused.",
    inputSchema: { local_path: z.string(), purpose: z.enum(["artifact", "model", "dataset"]).default("artifact"), accept_storage_charges: z.boolean().default(false).describe("Read get_storage pricing first. Set true only after the user agrees to paid storage above the included allowance.") },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, wrap(async ({ local_path, purpose = "artifact", accept_storage_charges = false }) => {
    const local = path.resolve(expandHome(local_path));
    if (sensitiveReason(local)) return fail("Credential files cannot be saved as artifacts.");
    if ((await fsp.lstat(local)).isSymbolicLink()) return fail("Choose a regular file, not a symlink.");
    return ok(await client.upload(local, purpose, path.basename(local), accept_storage_charges));
  }));
  server.registerTool("download_artifact", {
    title: "Download a persistent file", description: "Streams a persistent file to this computer. Never overwrites an existing local file.",
    inputSchema: { file_id: z.string(), local_path: z.string() }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, wrap(async ({ file_id, local_path }) => ok(await client.download(file_id, path.resolve(expandHome(local_path))))));
  server.registerTool("save_workspace", {
    title: "Save a project Workspace", description: "Saves 1–100 regular project files as an immutable version. Refuses secrets and symlinks; skips .git, node_modules, __pycache__ and .venv. Save dependency manifests, not the operating system. Pass the returned workspace_version_id to run_job.",
    inputSchema: { local_dir: z.string(), name: z.string().min(1).max(120), workspace_id: z.string().optional(), accept_storage_charges: z.boolean().default(false).describe("Read get_storage pricing and obtain user agreement before enabling paid storage.") },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, wrap(async ({ local_dir, name, workspace_id, accept_storage_charges = false }) => ok(await client.saveWorkspace(expandHome(local_dir), name, workspace_id, accept_storage_charges))));
  server.registerTool("delete_file", {
    title: "Delete a persistent file", description: "Permanently deletes a persistent file or cancels an unfinished upload. Files pinned by a Workspace version cannot be deleted.",
    inputSchema: { file_id: z.string(), user_confirmed: z.boolean() }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, wrap(async ({ file_id, user_confirmed }) => user_confirmed === true ? ok(await api.request("DELETE", `/v1/files/${encodeURIComponent(file_id)}`)) : fail("Ask the user before deleting the file.")));
}
