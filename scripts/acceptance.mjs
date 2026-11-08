// 默认只读。--paid 仅供已获授权的内部测试账号；每任务最多 $0.03，最多两任务。
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
const paid = process.argv.includes("--paid");
const client = new Client({ name: "cloudgpu-d11-acceptance", version: "1.0" });
const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../src/index.js", import.meta.url))], env: { ...process.env, CLOUDGPU_READ_ONLY: paid ? "0" : "1" } });
const active = new Set();
const emit = m => console.log(JSON.stringify({ at: new Date().toISOString(), ...m }));
async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw Error(r.content[0].text);
  return JSON.parse(r.content[0].text);
}
async function wait(id) {
  const deadline = Date.now() + 12 * 60_000;
  let last;
  while (Date.now() < deadline) {
    const j = await call("get_job", { job_id: id });
    if (j.status !== last) emit({ step: "job", id, status: j.status, error: j.error?.code, cost_usd: j.cost_usd, cost_status: j.cost_status });
    last = j.status;
    if (["succeeded", "failed", "cancelled"].includes(j.status)) { active.delete(id); return j; }
    if (j.status === "needs_attention") throw Error("Job needs manual attention; do not resubmit with a new key: " + id);
    await new Promise(r => setTimeout(r, 20000));
  }
  throw Error("Acceptance deadline reached; cancel requested for " + id);
}
try {
  await client.connect(transport);
  const tools = await client.listTools(); emit({ step: "stdio", tools: tools.tools.length });
  const catalog = await call("get_compute_catalog"); emit({ step: "catalog", gpus: catalog.gpus.length });
  if (!paid) { emit({ step: "done", paid: false }); }
  else {
    const account = await call("get_account");
    if (Number(account.balance_usd) < 1) throw Error("Internal account needs sufficient preauthorisation balance.");
    const q = await call("quote_compute", { estimated_duration_seconds: 60, max_budget_usd: 0.03 });
    const card = q.candidates.find(c => c.supports_jobs && c.within_budget && c.can_start_with_balance && Number(c.instance_price_per_hour_usd) <= 1.8);
    if (!card) throw Error("No eligible GPU within the acceptance budget.");
    const args = { gpu_model: card.gpu_model, quote_id: q.quote_id, command: `nvidia-smi -L && bash -ic 'python -c "print(123)"' && echo CLOUDGPU_D11_ACCEPTANCE_OK`, max_spend_usd: 0.03, max_hours: 0.05, user_confirmed: true, idempotency_key: "d11-" + randomUUID() };
    emit({ step: "quote", gpu: card.gpu_model, estimated_cost: card.estimated_total_cost, preauthorisation: card.required_starting_balance, per_job_cap: 0.03 });
    const j = await call("run_job", args); active.add(j.id);
    const replay = await call("run_job", args);
    if (replay.id !== j.id) throw Error("Idempotency failure: stop and reconcile both Jobs.");
    emit({ step: "idempotent_replay", id: j.id, same_job: true });
    const result = await wait(j.id);
    if (result.status !== "succeeded" || !result.output_tail?.includes("CLOUDGPU_D11_ACCEPTANCE_OK")) throw Error("Execution acceptance failed: " + j.id);
    const cancelArgs = { ...args, quote_id: undefined, command: "sleep 180", idempotency_key: "d11-cancel-" + randomUUID() };
    const c = await call("run_job", cancelArgs); active.add(c.id);
    await call("cancel_job", { job_id: c.id });
    const cancelled = await wait(c.id);
    if (cancelled.status !== "cancelled") throw Error("Cancellation acceptance failed: " + c.id);
    emit({ step: "done", paid: true, success_job: j.id, cancelled_job: c.id, note: "Verify final ledger and released instances separately on the server." });
  }
} finally {
  for (const id of active) {
    try { await call("cancel_job", { job_id: id }); emit({ step: "cleanup_cancel_requested", id }); }
    catch { emit({ step: "cleanup_needs_manual_check", id }); }
  }
  await client.close();
}
