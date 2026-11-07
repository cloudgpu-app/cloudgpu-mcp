import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CloudGpuApi, ApiError } from "../src/api.js";
import { loadStoredKey, saveStoredKey } from "../src/credentials.js";

function fakeFetch(responses, calls) {
  return async (url, init) => {
    calls.push({ url, init });
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return { ok: r.status < 400, status: r.status, text: async () => JSON.stringify(r.body) };
  };
}

test("createJob sends the Idempotency-Key and retries a network error with the same key", async () => {
  const calls = [];
  const api = new CloudGpuApi({
    apiKey: "cgw-sk-x",
    fetchImpl: fakeFetch([new Error("socket hang up"), { status: 202, body: { id: "job_1", status: "queued" } }], calls),
  });
  const job = await api.createJob({ command: "echo" }, "idem-123");
  assert.equal(job.id, "job_1");
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.equal(c.init.headers["Idempotency-Key"], "idem-123");
    assert.equal(c.init.method, "POST");
  }
});

test("a POST without an Idempotency-Key is never retried", async () => {
  const calls = [];
  const api = new CloudGpuApi({ apiKey: "k", fetchImpl: fakeFetch([new Error("reset"), { status: 202, body: {} }], calls) });
  await assert.rejects(() => api.create({ gpu_model: "RTX 4090" }), ApiError);
  assert.equal(calls.length, 1);
});

test("createJob refuses to run without a key", () => {
  const api = new CloudGpuApi({ apiKey: "k", fetchImpl: async () => ({}) });
  assert.throws(() => api.createJob({ command: "echo" }), /idempotency/);
});

test("409 idempotency_key_reused surfaces as an ApiError and is not retried", async () => {
  const calls = [];
  const api = new CloudGpuApi({
    apiKey: "k",
    fetchImpl: fakeFetch([{ status: 409, body: { error: { code: "idempotency_key_reused", message: "used" } } }], calls),
  });
  await assert.rejects(() => api.createJob({ command: "x" }, "k1"), (e) => e.status === 409 && e.code === "idempotency_key_reused");
  assert.equal(calls.length, 1);
});

test("agent connect works without a key and sends no Authorization header", async () => {
  const calls = [];
  const api = new CloudGpuApi({
    apiKey: "",
    fetchImpl: fakeFetch(
      [
        { status: 200, body: { device_code: "d", user_code: "ABCD-EFGH" } },
        { status: 400, body: { error: { code: "authorization_pending", message: "wait" } } },
      ],
      calls,
    ),
  });
  const r = await api.connectStart({ agent_name: "a", spend_limit_usd: 5 });
  assert.equal(r.user_code, "ABCD-EFGH");
  assert.equal(calls[0].init.headers.Authorization, undefined);
  await assert.rejects(() => api.connectToken("d"), (e) => e.code === "authorization_pending");
});

test("stored key round-trips, is private to the user, and an expired one is ignored", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cgpu-"));
  const env = { CLOUDGPU_CONFIG_DIR: dir };
  assert.equal(loadStoredKey(env), null);
  const file = saveStoredKey({ api_key: "cgw-sk-abc", expires_at: Math.floor(Date.now() / 1000) + 3600 }, env);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(loadStoredKey(env).api_key, "cgw-sk-abc");
  saveStoredKey({ api_key: "cgw-sk-old", expires_at: 1 }, env);
  assert.equal(loadStoredKey(env), null);
});

test("run_job and cancel_job are marked destructive; reads are read-only", () => {
  const src = fs.readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  const ann = (name) => src.slice(src.indexOf(`"${name}"`)).match(/annotations:\s*\{([^}]*)\}/)[1];
  assert.match(ann("run_job"), /destructiveHint:\s*true/);
  assert.match(ann("cancel_job"), /destructiveHint:\s*true/);
  assert.match(ann("get_job"), /readOnlyHint:\s*true/);
  assert.match(ann("list_jobs"), /readOnlyHint:\s*true/);
  // run_job 必须要用户确认
  assert.match(src.slice(src.indexOf('"run_job"'), src.indexOf('"cancel_job"')), /user_confirmed !== true/);
});

test("optional storage being disabled does not affect existing account, offers or Jobs REST calls", async () => {
  const calls=[];
  const api=new CloudGpuApi({apiKey:'fake-test-key',fetchImpl:fakeFetch([
    {status:503,body:{error:{code:'storage_not_enabled',message:'disabled'}}},
    {status:200,body:{balance_usd:1}},
    {status:200,body:{data:[]}},
    {status:202,body:{id:'job_mock',status:'queued'}}
  ],calls)});
  await assert.rejects(()=>api.request('POST','/v1/files',{name:'file',purpose:'artifact',size_bytes:1}),e=>e.code==='storage_not_enabled');
  assert.equal((await api.account()).balance_usd,1);
  await api.offers();
  assert.equal((await api.createJob({command:'echo',gpu_model:'mock',max_minutes:1,max_spend_usd:0.01},'offline-test')).id,'job_mock');
  assert.deepEqual(calls.slice(1).map(c=>new URL(c.url).pathname),['/v1/gpu/account','/v1/gpu/offers','/v1/jobs']);
});
