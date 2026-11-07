import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PersistentStorage, registerStorageTools } from "../src/storage.js";

test("multipart file transfer never forwards the account key to object storage", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cgpu-persist-"));
  const local = path.join(dir, "train.py"); await fs.writeFile(local, "abcdef");
  const calls = [], contents = [];
  const api = { request: async (method, url, body) => {
    calls.push({ method, url, body });
    if (url === "/v1/files") return { file_id: "file_1", part_count: 2 };
    if (url.endsWith("/complete")) return { file_id: "file_1", status: "ready" };
    return { url: "https://storage.example.invalid/part", content_length: 3 };
  } };
  const storage = new PersistentStorage(api, async (_url, request) => {
    assert.deepEqual(request.headers, { "Content-Length": "3" });
    let b = ""; for await (const c of request.body) b += c.toString(); contents.push(b);
    return { ok: true };
  });
  try {
    assert.equal((await storage.upload(local)).status, "ready");
    assert.deepEqual(contents, ["abc", "def"]);
    assert.equal(calls.filter(c => c.url.endsWith("/complete")).length, 1);
  } finally { await fs.rm(dir, { recursive: true }); }
});

test("failed upload aborts its reservation instead of becoming a ready artifact", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cgpu-persist-"));
  const local = path.join(dir, "a"); await fs.writeFile(local, "abc");
  const calls = [];
  const api = { request: async (method, url) => {
    calls.push(method + " " + url);
    if (url === "/v1/files") return { file_id: "file_x", part_count: 1 };
    return { url: "https://storage.example.invalid/part", content_length: 3 };
  } };
  try {
    await assert.rejects(() => new PersistentStorage(api, async () => ({ ok: false })).upload(local), /part upload failed/);
    assert.ok(calls.includes("DELETE /v1/files/file_x"));
    assert.ok(!calls.some(c => c.endsWith("/complete")));
  } finally { await fs.rm(dir, { recursive: true }); }
});

test("Workspace checks all nested files for secrets before uploading anything", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cgpu-persist-"));
  await fs.mkdir(path.join(dir, "project")); await fs.writeFile(path.join(dir, "project", ".env"), "SECRET=hidden");
  let called = false;
  try {
    const api = { request: async () => { called = true; } };
    await assert.rejects(() => new PersistentStorage(api).saveWorkspace(dir, "test"), /credential file/);
    assert.equal(called, false);
  } finally { await fs.rm(dir, { recursive: true }); }
});

test("download streams results, verifies size and refuses to overwrite existing files", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cgpu-persist-"));
  const api = { request: async () => ({ url: "https://storage.example.invalid/download", size_bytes: 3 }) };
  const storage = new PersistentStorage(api, async () => new Response("abc"));
  try {
    const local = path.join(dir, "a"); await storage.download("file_a", local);
    assert.equal(await fs.readFile(local, "utf8"), "abc");
    await assert.rejects(() => storage.download("file_a", local), /EEXIST/);
    const bad = new PersistentStorage(api, async () => new Response("toolong"));
    await assert.rejects(() => bad.download("file_a", path.join(dir, "bad")), /partial file/);
    await assert.rejects(() => fs.stat(path.join(dir, "bad")), /ENOENT/);
  } finally { await fs.rm(dir, { recursive: true }); }
});

test("read-only MCP mode exposes no storage writes and delete requires confirmation", async () => {
  const tools = new Map(); const server = { registerTool: (name, spec, run) => tools.set(name, { spec, run }) };
  const opts = { api: { request: () => { throw Error("must not call without confirmation"); } }, wrap: f => f, ok: x => x, fail: x => ({ error: x }), expandHome: x => x, readOnly: true };
  registerStorageTools(server, opts);
  assert.deepEqual([...tools.keys()], ["get_storage", "list_files", "list_workspaces", "list_workspace_versions", "get_workspace_version"]);
  tools.clear(); registerStorageTools(server, { ...opts, readOnly: false });
  assert.equal(tools.get("delete_file").spec.annotations.destructiveHint, true);
  assert.match((await tools.get("delete_file").run({ file_id: "x", user_confirmed: false })).error, /Ask the user/);
});

test("empty project marker files can be persisted", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cgpu-persist-"));
  const local = path.join(dir, "__init__.py"); await fs.writeFile(local, "");
  const api = { request: async (_method, url, body) => {
    if (url === "/v1/files") { assert.equal(body.size_bytes, 0); return { file_id: "file_empty", part_count: 1 }; }
    if (url.endsWith("/complete")) return { file_id: "file_empty", status: "ready" };
    return { url: "https://storage.example.invalid/part", content_length: 0 };
  } };
  try {
    const s = new PersistentStorage(api, async (_url, r) => { assert.equal(r.body.length, 0); return { ok: true }; });
    assert.equal((await s.upload(local)).status, "ready");
  } finally { await fs.rm(dir, { recursive: true }); }
});

test("storage disabled returns a clean error without touching object storage", async () => {
  const tools=new Map();let requests=0;
  const server={registerTool:(name,spec,run)=>tools.set(name,{spec,run})};
  const opts={api:{request:async()=>{requests++;throw Error('storage_not_enabled');}},wrap:fn=>async args=>{try{return await fn(args);}catch(e){return {error:e.message};}},ok:x=>x,fail:x=>({error:x}),expandHome:x=>x,readOnly:false};
  registerStorageTools(server,opts);
  assert.match((await tools.get('get_storage').run({})).error,/storage_not_enabled/);
  assert.equal(requests,1);
  // 版本删除和文件删除都必须先征得用户确认，关闭存储时也不能先请求。
  assert.match((await tools.get('delete_workspace_version').run({version_id:'wsv_test',user_confirmed:false})).error,/Ask the user/);
  assert.equal(requests,1);
});
