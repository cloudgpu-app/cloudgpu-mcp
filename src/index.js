#!/usr/bin/env node
// CloudGPU MCP server (stdio). Lets an AI coding assistant rent a GPU on cloudgpu.app, run a job,
// fetch the results and shut the GPU down.
//
// Env:
//   CLOUDGPU_API_KEY         required; create one at https://cloudgpu.app/api
//   CLOUDGPU_MAX_SPEND_USD   optional; highest budget the assistant may set for one instance (default 50)
//   CLOUDGPU_MAX_HOURS       optional; longest run the assistant may set for one instance (default 24)
//   CLOUDGPU_READ_ONLY       optional; "1" registers only the tools that look things up
//   CLOUDGPU_BASE_URL        optional; default https://cloudgpu.app
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CloudGpuApi, ApiError } from "./api.js";
import { SshPool, exec, upload, download, writeFile } from "./ssh.js";
import { loadStoredKey, saveStoredKey } from "./credentials.js";
import crypto from "node:crypto";
import { registerStorageTools } from "./storage.js";
import {
  checkCommand,
  sensitiveReason,
  expandHome,
  redact,
  publicInstance,
  Quotes,
  round2,
  shq,
} from "./guards.js";

const VERSION = "0.4.0";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const RULES = fs.readFileSync(path.join(HERE, "..", "rules", "cloudgpu.md"), "utf8");

// A key from connect_account (saved on this computer) is used when CLOUDGPU_API_KEY is not set.
const stored = loadStoredKey();
const cfg = {
  apiKey: (process.env.CLOUDGPU_API_KEY || "").trim() || (stored ? stored.api_key : ""),
  baseUrl: process.env.CLOUDGPU_BASE_URL || "https://cloudgpu.app",
  maxSpend: num(process.env.CLOUDGPU_MAX_SPEND_USD, 50),
  maxHours: num(process.env.CLOUDGPU_MAX_HOURS, 24),
  readOnly: /^(1|true|yes)$/i.test(process.env.CLOUDGPU_READ_ONLY || ""),
};

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}

const api = new CloudGpuApi({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl });
const pool = new SshPool();
const quotes = new Quotes();
// Instances this session touched: did we run anything, did we download anything.
const session = new Map();

const INSTRUCTIONS = `CloudGPU (cloudgpu.app) rents GPUs billed per minute from a prepaid balance.
Workflow: get_account and list_gpus -> estimate_cost -> show the quote to the user and get an explicit yes -> create_instance -> get_status until running -> upload -> run_command (background for long jobs) -> tail_logs -> download results -> stop_instance -> report the actual cost.
Rules: never rent without the user's yes on a quote; always set a budget and time limit (the platform shuts the instance down when either is hit); download results before stop_instance because destroying an instance erases its disk; never change passwords, SSH config, the firewall or the platform's monitoring agent on the instance; if anything fails, download what exists and stop the instance rather than leaving it running.
Jobs: for a batch task (one command that writes its results somewhere), run_job does the whole thing on CloudGPU's servers: start a GPU, run the command, destroy the GPU, with the same per-job budget and time limit. Check it with get_job. The GPU's disk is erased when the job ends, so the command must upload its results itself (for example to the user's own S3 bucket) or print them; get_job returns the last ~4 KB of output.
No API key yet? connect_account gives the user a link to approve this assistant with a spending limit; then finish_connect stores the key on this computer.
The same API key also works for the OpenAI-compatible model API at ${cfg.baseUrl}/v1 (see list_models).`;

const server = new McpServer({ name: "cloudgpu", version: VERSION }, { instructions: INSTRUCTIONS });
registerStorageTools(server, { api, wrap, ok, fail, readOnly: cfg.readOnly, expandHome });

// ── helpers ──────────────────────────────────────────────────────────────

function ok(obj) {
  const text = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
  return { content: [{ type: "text", text: redact(text, [cfg.apiKey]) }] };
}

function fail(msg) {
  return { content: [{ type: "text", text: redact(msg, [cfg.apiKey]) }], isError: true };
}

function wrap(fn) {
  return async (args) => {
    try {
      return await fn(args || {});
    } catch (err) {
      if (err instanceof ApiError) {
        let hint = "";
        if (err.status === 401) hint = " Check CLOUDGPU_API_KEY (create one at https://cloudgpu.app/api).";
        if (err.status === 402) hint = " Top up at https://cloudgpu.app/billing.";
        return fail(`CloudGPU API error ${err.status} ${err.code}: ${err.message}${hint}`);
      }
      return fail(`Error: ${err && err.message ? err.message : String(err)}`);
    }
  };
}

function track(id) {
  if (!session.has(id)) session.set(id, { ran: false, downloaded: false });
  return session.get(id);
}

/** Running instance + SSH client; throws a readable error otherwise. */
async function connectTo(id) {
  const inst = await api.instance(id);
  if (inst.status !== "running") {
    throw new Error(
      `Instance ${id} is ${inst.status}` +
        (inst.status === "creating"
          ? "; wait for it with get_status until it is running."
          : inst.failure_reason
            ? `: ${inst.failure_reason}`
            : inst.limits && inst.limits.stopped_by
              ? ` (stopped by its ${inst.limits.stopped_by} limit).`
              : "."),
    );
  }
  if (!inst.ssh || !inst.ssh.host) throw new Error(`Instance ${id} has no SSH access yet; try get_status again shortly.`);
  const client = await pool.get(id, inst.ssh);
  const secrets = [cfg.apiKey, inst.ssh.password, inst.ssh.host];
  return { inst, client, secrets };
}

const JOBS = ".cloudgpu/jobs";
// bash -i so conda / venv set up in ~/.bashrc are active, the same as an interactive login.
const NOISE = /^bash: (cannot set terminal process group|no job control in this shell).*\n?/gm;

function cleanOut(s, secrets) {
  return redact((s || "").replace(NOISE, ""), secrets);
}

// ── account and catalogue ────────────────────────────────────────────────

server.registerTool("get_compute_catalog", {
  title: "Public GPU catalog", description: "GPU catalog, templates and billing without an API key. Does not rent anything.",
  inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: true },
}, wrap(async () => ok(await api.catalog())));
server.registerTool("quote_compute", {
  title: "Server-side compute quote", description: "Five-minute server quote: separates estimated task cost from required starting balance and marks supports_jobs. No GPU is started. Pass its quote_id to run_job.",
  inputSchema: { min_vram_gb: z.number().int().min(0).default(0), gpu_model: z.string().optional(), gpu_count: z.number().int().min(1).max(8).default(1),
    template: z.string().optional(), disk_gb: z.number().int().optional(), estimated_duration_seconds: z.number().int().positive(), max_budget_usd: z.number().positive() },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, wrap(async ({ estimated_duration_seconds, max_budget_usd, ...requirements }) => {
  const q = await api.quote({ requirements, estimated_duration_seconds, max_budget_usd });
  return ok({ ...q, quote_id: q.id });
}));

server.registerTool(
  "get_account",
  {
    title: "CloudGPU account",
    description: "Balance in USD, how many instances this account may run at once, and how many are running now.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  wrap(async () => ok(await api.account())),
);

server.registerTool(
  "list_gpus",
  {
    title: "List GPUs",
    description:
      "GPU models you can rent now, with VRAM, live price per GPU-hour in USD and availability (ok / low / none). Prices are live; never assume them.",
    inputSchema: {
      min_vram_gb: z.number().optional().describe("Only GPUs with at least this much VRAM per card"),
      gpu_model: z.string().optional().describe("Filter by name, e.g. 4090, A100, H20"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  wrap(async ({ min_vram_gb, gpu_model }) => {
    let rows = await api.offers();
    if (min_vram_gb) rows = rows.filter((r) => (r.vram_gb || 0) >= min_vram_gb);
    if (gpu_model) {
      const q = gpu_model.toLowerCase().replace(/\s+/g, "");
      rows = rows.filter((r) => String(r.gpu_model).toLowerCase().replace(/\s+/g, "").includes(q));
    }
    return ok({
      gpus: rows.map((r) => ({
        gpu_model: r.gpu_model,
        vram_gb: r.vram_gb,
        usd_per_gpu_hour: r.hourly_usd,
        available: r.available,
        min_gpu_count: r.min_gpu_count,
      })),
      note: "Billed per minute. 'available' is live and can change before you rent.",
    });
  }),
);

server.registerTool(
  "list_templates",
  {
    title: "List templates",
    description:
      "Ready-made instance images (e.g. JupyterLab, Ollama, ComfyUI, LLaMA-Factory) with the GPU each recommends. Templates with has_api_endpoint get a public HTTPS api_url.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  wrap(async () => ok({ templates: await api.templates() })),
);

server.registerTool(
  "estimate_cost",
  {
    title: "Quote a rental",
    description:
      "Live price and estimated cost for a GPU, plus your balance after it. Returns a quote_id that create_instance needs. Show the quote to the user and get an explicit yes before renting.",
    inputSchema: {
      gpu_model: z.string().describe("GPU model exactly as list_gpus returns it"),
      gpu_count: z.number().int().min(1).max(8).default(1),
      hours: z.number().positive().describe("Expected run time in hours"),
      template: z.string().optional().describe("Template id from list_templates; omit for a plain GPU with Python and CUDA"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  wrap(async ({ gpu_model, gpu_count = 1, hours, template }) => {
    const [offers, account] = await Promise.all([api.offers(), api.account().catch(() => null)]);
    const offer = offers.find((o) => String(o.gpu_model).toLowerCase() === gpu_model.toLowerCase());
    if (!offer) {
      return fail(`No GPU named "${gpu_model}". Available: ${offers.map((o) => o.gpu_model).join(", ")}`);
    }
    if (gpu_count < (offer.min_gpu_count || 1)) {
      return fail(`${offer.gpu_model} is rented in groups of at least ${offer.min_gpu_count} GPUs.`);
    }
    const hourly = round2(Number(offer.hourly_usd) * gpu_count);
    const estimate = round2(hourly * hours);
    const balance = account ? Number(account.balance_usd) : null;
    const warnings = [];
    if (offer.available === "none") warnings.push("This GPU is out of stock right now; renting will likely fail. Pick another.");
    if (offer.available === "low") warnings.push("Only a few of these are free; renting may fail.");
    if (balance != null && balance < estimate * 1.1) {
      warnings.push(
        `Balance $${balance} does not cover the estimate plus a 10% buffer. When the balance runs out the instance is destroyed and its disk erased. Top up at https://cloudgpu.app/billing.`,
      );
    }
    const quote_id = quotes.put({ gpu_model: offer.gpu_model, gpu_count, template, hourly, hours, estimate });
    return ok({
      quote_id,
      gpu_model: offer.gpu_model,
      gpu_count,
      template: template || null,
      usd_per_hour: hourly,
      hours,
      estimated_cost_usd: estimate,
      balance_usd: balance,
      balance_after_usd: balance == null ? null : round2(balance - estimate),
      suggested_max_spend_usd: round2(Math.min(cfg.maxSpend, Math.max(1, estimate * 1.25))),
      warnings,
      next: "Show this quote to the user. Only after they say yes, call create_instance with this quote_id.",
    });
  }),
);

server.registerTool(
  "list_models",
  {
    title: "List hosted models",
    description:
      "Models on CloudGPU's OpenAI-compatible API (same key, same balance). Use them from code with base_url " +
      `${cfg.baseUrl}/v1 instead of renting a GPU when you only need inference.`,
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  wrap(async () => {
    const models = await api.models();
    return ok({
      base_url: `${cfg.baseUrl}/v1`,
      auth: "Authorization: Bearer <the same CLOUDGPU_API_KEY>",
      models: models.map((m) => m.id),
      pricing: `${cfg.baseUrl}/pricing`,
    });
  }),
);

// ── connect (get a key with a budget, approved in the browser) ──────────────

let pendingConnect = null;

server.registerTool(
  "connect_account",
  {
    title: "Connect this assistant to a CloudGPU account",
    description:
      "Use when there is no API key. Starts an approval request and returns a link. The user opens it, signs in to cloudgpu.app and approves this assistant " +
      "with a spending limit and a maximum number of GPUs at once; CloudGPU's servers enforce both. Then call finish_connect. No money is spent.",
    inputSchema: {
      agent_name: z.string().min(1).max(64).describe("How the user will recognise this assistant, e.g. 'Claude Code on Yang's laptop'"),
      spend_limit_usd: z.number().min(1).max(10000).describe("Total this key may ever spend, in USD; ask the user"),
      max_concurrent: z.number().int().min(1).max(10).default(1).describe("GPUs or jobs this key may run at once"),
      expires_in_days: z.number().int().min(1).max(90).default(30),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  wrap(async ({ agent_name, spend_limit_usd, max_concurrent = 1, expires_in_days = 30 }) => {
    const r = await api.connectStart({ agent_name, spend_limit_usd, max_concurrent, expires_in_days });
    pendingConnect = { device_code: r.device_code, until: Date.now() + Number(r.expires_in || 600) * 1000, interval: Number(r.interval || 5) };
    return ok({
      link: r.verification_uri_complete,
      code: r.user_code,
      expires_in_seconds: r.expires_in,
      next: "Show the link to the user and ask them to open it, sign in and approve. Then call finish_connect.",
    });
  }),
);

server.registerTool(
  "finish_connect",
  {
    title: "Finish connecting",
    description:
      "After the user approved the link from connect_account: waits up to about a minute for the approval, then stores the new key on this computer " +
      "(~/.config/cloudgpu/credentials.json, readable only by the user) and uses it from now on. The key itself is never shown.",
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  wrap(async () => {
    if (!pendingConnect) return fail("No approval is pending. Call connect_account first.");
    const deadline = Math.min(Date.now() + 60_000, pendingConnect.until);
    for (;;) {
      try {
        const cred = await api.connectToken(pendingConnect.device_code);
        const file = saveStoredKey({
          api_key: cred.api_key,
          key_id: cred.key_id,
          agent_name: cred.agent_name,
          spend_limit_usd: cred.spend_limit_usd,
          max_concurrent: cred.max_concurrent,
          expires_at: cred.expires_at,
          base_url: cfg.baseUrl,
        });
        cfg.apiKey = cred.api_key;
        api.apiKey = cred.api_key;
        pendingConnect = null;
        return ok({
          connected: true,
          agent_name: cred.agent_name,
          spend_limit_usd: cred.spend_limit_usd,
          max_concurrent: cred.max_concurrent,
          expires_at: cred.expires_at,
          saved_to: file,
          note: "The account owner can revoke this key at any time at https://cloudgpu.app/api.",
        });
      } catch (err) {
        if (err instanceof ApiError && err.code === "authorization_pending" && Date.now() + pendingConnect.interval * 1000 < deadline) {
          await new Promise((r) => setTimeout(r, pendingConnect.interval * 1000));
          continue;
        }
        if (err instanceof ApiError && err.code === "authorization_pending") {
          return fail("Not approved yet. Ask the user to open the link and approve, then call finish_connect again.");
        }
        if (err instanceof ApiError && (err.code === "access_denied" || err.code === "expired_token")) pendingConnect = null;
        throw err;
      }
    }
  }),
);

// ── jobs (read) ───────────────────────────────────────────────────────────

server.registerTool(
  "get_job",
  {
    title: "Job status",
    description:
      "Status of a job (queued / provisioning / running / stopping / succeeded / failed / cancelled / needs_attention), exit code, cost so far, " +
      "the last ~4 KB of the command's output and the job's event history.",
    inputSchema: { job_id: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  wrap(async ({ job_id }) => {
    const [job, logs, events] = await Promise.all([api.job(job_id), api.jobLogs(job_id).catch(() => null), api.jobEvents(job_id).catch(() => [])]);
    return ok({ ...job, output_tail: logs ? logs.tail : null, events });
  }),
);

server.registerTool(
  "list_jobs",
  {
    title: "List jobs",
    description: "Recent jobs on this account with status and cost.",
    inputSchema: { limit: z.number().int().min(1).max(100).default(20) },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  wrap(async ({ limit = 20 }) => ok({ jobs: await api.jobs(limit) })),
);

// ── instances (read) ─────────────────────────────────────────────────────

server.registerTool(
  "get_status",
  {
    title: "Instance status",
    description:
      "Status (creating / running / stopped / failed), minutes run, cost so far, whether SSH is ready, the public api_url if the template has one, and the auto-shutdown limits.",
    inputSchema: { instance_id: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  wrap(async ({ instance_id }) => ok(publicInstance(await api.instance(instance_id)))),
);

server.registerTool(
  "list_instances",
  {
    title: "List instances",
    description: "Instances on this account: running, starting, and those stopped in the last 7 days, with cost.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  wrap(async () => ok({ instances: (await api.instances()).map(publicInstance) })),
);

// ── instances (act) ──────────────────────────────────────────────────────

if (!cfg.readOnly) {
  server.registerTool(
    "create_instance",
    {
      title: "Rent a GPU",
      description:
        "Rents the GPU from a quote. Costs money. Requires a quote_id from estimate_cost that the user has approved. " +
        "max_spend_usd and max_hours are enforced by CloudGPU's servers: the instance is destroyed when either is reached, even if this assistant has disconnected. " +
        "idle_minutes destroys it after the GPU sits idle that long (installing packages and downloading data count as idle, so allow for setup). " +
        "setup_script (optional bash) runs once as root after the instance is handed over; its output is in /root/cloudgpu-setup.log.",
      inputSchema: {
        quote_id: z.string(),
        user_confirmed: z.boolean().describe("true only if the user explicitly approved this quote in the conversation"),
        max_spend_usd: z.number().positive().describe(`Budget for this instance in USD (at most ${cfg.maxSpend})`),
        max_hours: z.number().positive().describe(`Hard time limit in hours (at most ${cfg.maxHours})`),
        idle_minutes: z
          .number()
          .int()
          .min(0)
          .max(1440)
          .default(60)
          .describe("Destroy after the GPU has been idle this long; 0 turns it off; otherwise at least 10"),
        setup_script: z
          .string()
          .max(16384)
          .optional()
          .describe("Optional bash script run once as root in the background after the instance is handed over; output in /root/cloudgpu-setup.log"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    wrap(async ({ quote_id, user_confirmed, max_spend_usd, max_hours, idle_minutes = 60, setup_script }) => {
      if (user_confirmed !== true) {
        return fail("Not rented: show the quote to the user and wait for an explicit yes, then call again with user_confirmed=true.");
      }
      if (max_spend_usd > cfg.maxSpend) {
        return fail(
          `max_spend_usd ${max_spend_usd} is above this server's cap of ${cfg.maxSpend} (CLOUDGPU_MAX_SPEND_USD). Ask the user to raise the cap in the MCP config if they want more.`,
        );
      }
      if (max_hours > cfg.maxHours) {
        return fail(`max_hours ${max_hours} is above this server's cap of ${cfg.maxHours} (CLOUDGPU_MAX_HOURS).`);
      }
      if (idle_minutes > 0 && idle_minutes < 10) return fail("idle_minutes must be 0 (off) or at least 10.");
      const { quote, error } = quotes.take(quote_id);
      if (error) return fail(error);
      const account = await api.account();
      const balance = Number(account.balance_usd);
      const needed = round2(Math.min(max_spend_usd, quote.estimate) * 1.1);
      if (balance < needed) {
        return fail(
          `Not rented: balance $${balance} is below $${needed} (the estimate or budget plus 10%). If the balance runs out the instance is destroyed and its disk erased. Top up at https://cloudgpu.app/billing.`,
        );
      }
      const body = {
        gpu_model: quote.gpu_model,
        gpu_count: quote.gpu_count,
        max_minutes: Math.ceil(max_hours * 60),
        max_spend_usd,
        idle_minutes,
      };
      if (quote.template) body.template = quote.template;
      if (setup_script && setup_script.trim()) body.setup_script = setup_script;
      const inst = await api.create(body);
      track(inst.id);
      return ok({
        ...publicInstance(inst),
        next: "Call get_status at intervals (not in a tight loop) until status is running, then upload and run_command.",
      });
    }),
  );

  server.registerTool(
    "run_job",
    {
      title: "Run a job on a GPU",
      description:
        "Costs money. CloudGPU starts a GPU, runs one bash command on it, then destroys the GPU, all on its servers, so it finishes even if this assistant disconnects. " +
        "max_spend_usd and max_hours are enforced by the servers. Retrying with the same idempotency_key never starts a second GPU; this tool generates one if you leave it out and returns it. " +
        "The disk is erased when the job ends: the command must upload its own results (for example to the user's storage) or print them. " +
        "Requires the user's explicit yes on the GPU, budget and time limit.",
      inputSchema: {
        command: z.string().min(1).max(32768).describe("bash command or script to run on the GPU"),
        gpu_model: z.string().optional().describe("GPU model exactly as list_gpus returns it"),
        template: z.string().optional().describe("Template id from list_templates"),
        gpu_count: z.number().int().min(1).max(8).default(1),
        disk_gb: z.number().int().optional().describe("Larger system disk: 100, 200 or 500; omit for the standard disk"),
        workspace_version_id: z.string().optional().describe("Immutable Workspace version to restore before the command; requires enabled persistent storage"),
        quote_id: z.string().optional().describe("Server quote from quote_compute, starting quote_; binds configuration and checks price at submission"),
        max_spend_usd: z.number().positive().describe(`Budget for this job in USD (at most ${cfg.maxSpend})`),
        max_hours: z.number().positive().describe(`Hard time limit in hours (at most ${cfg.maxHours})`),
        user_confirmed: z.boolean().describe("true only if the user explicitly approved the GPU, budget and time limit"),
        idempotency_key: z.string().max(128).optional().describe("Reuse the same value when retrying the same job"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    wrap(async ({ command, gpu_model, template, gpu_count = 1, disk_gb, workspace_version_id, quote_id, max_spend_usd, max_hours, user_confirmed, idempotency_key }) => {
      if (user_confirmed !== true) {
        return fail("Not started: tell the user the GPU, budget and time limit, wait for an explicit yes, then call again with user_confirmed=true.");
      }
      if (!gpu_model && !template && !quote_id) return fail("Give gpu_model, template or a server quote_id from quote_compute.");
      if (max_spend_usd > cfg.maxSpend) {
        return fail(`max_spend_usd ${max_spend_usd} is above this server's cap of ${cfg.maxSpend} (CLOUDGPU_MAX_SPEND_USD).`);
      }
      if (max_hours > cfg.maxHours) {
        return fail(`max_hours ${max_hours} is above this server's cap of ${cfg.maxHours} (CLOUDGPU_MAX_HOURS).`);
      }
      const refused = checkCommand(command);
      if (refused) return fail(refused);
      const key = idempotency_key || crypto.randomUUID();
      const body = { command, gpu_count, max_minutes: Math.ceil(max_hours * 60), max_spend_usd };
      if (gpu_model) body.gpu_model = gpu_model;
      if (template) body.template = template;
      if (disk_gb) body.disk_gb = disk_gb;
      if (workspace_version_id) body.workspace_version_id = workspace_version_id;
      if (quote_id) body.quote_id = quote_id;
      const job = await api.createJob(body, key);
      return ok({
        ...job,
        idempotency_key: key,
        next: "Call get_job at intervals (every minute or so, not in a tight loop) until status is succeeded, failed or cancelled, then report the cost.",
      });
    }),
  );

  server.registerTool(
    "cancel_job",
    {
      title: "Cancel a job",
      description: "Stops a job: if a GPU was started it is destroyed and billing stops. Output not yet uploaded by the command is lost.",
      inputSchema: { job_id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    wrap(async ({ job_id }) => ok(await api.cancelJob(job_id))),
  );

  server.registerTool(
    "run_command",
    {
      title: "Run a command on the instance",
      description:
        "Runs a bash command on the instance as root, in an interactive-style shell so conda/venv from ~/.bashrc are active. " +
        "Foreground returns the exit code and the last 20k characters of output. For anything longer than a few minutes (training, big downloads) use background=true, then tail_logs.",
      inputSchema: {
        instance_id: z.string(),
        command: z.string().describe("bash command or script"),
        background: z.boolean().default(false),
        timeout_sec: z.number().int().min(5).max(3600).default(600).describe("Foreground only"),
        workdir: z.string().default("~").describe("Directory to run in"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    wrap(async ({ instance_id, command, background = false, timeout_sec = 600, workdir = "~" }) => {
      const blocked = checkCommand(command);
      if (blocked) return fail(blocked);
      const { client, secrets } = await connectTo(instance_id);
      track(instance_id).ran = true;
      const job = "j" + Date.now().toString(36);
      const cd = workdir === "~" ? "cd ~" : workdir.startsWith("~/") ? `cd ~/${shq(workdir.slice(2))}` : `cd ${shq(workdir)}`;
      await writeFile(client, `${JOBS}/${job}.sh`, `${cd} || exit 97\n${command}\n`);
      if (background) {
        const r = await exec(
          client,
          `cd ~ && setsid nohup bash -c 'bash -i ${JOBS}/${job}.sh > ${JOBS}/${job}.log 2>&1 < /dev/null; echo $? > ${JOBS}/${job}.exit' > /dev/null 2>&1 < /dev/null & echo started`,
          { timeoutSec: 30 },
        );
        if (!/started/.test(r.stdout)) return fail(`Could not start the job: ${cleanOut(r.stderr, secrets)}`);
        return ok({
          job_id: job,
          log: `~/${JOBS}/${job}.log`,
          next: "Check progress with tail_logs (job_id). The job keeps running if this assistant disconnects; the instance's limits still apply.",
        });
      }
      const r = await exec(client, `cd ~ && timeout ${timeout_sec} bash -i ${JOBS}/${job}.sh 2>&1 < /dev/null`, {
        timeoutSec: timeout_sec + 15,
      });
      const out = cleanOut(r.stdout + (r.stderr ? "\n" + r.stderr : ""), secrets);
      return ok({
        exit_code: r.timedOut || r.code === 124 ? null : r.code,
        timed_out: r.timedOut || r.code === 124,
        output: out,
        ...(r.timedOut || r.code === 124 ? { hint: "Timed out. Re-run long work with background=true." } : {}),
      });
    }),
  );

  server.registerTool(
    "upload",
    {
      title: "Upload to the instance",
      description:
        "Copies a local file or directory (this computer) to the instance over SFTP. node_modules, .git and __pycache__ are skipped. Credentials files (.ssh, .env, keys) are refused unless allow_sensitive is true and the user asked for it.",
      inputSchema: {
        instance_id: z.string(),
        local_path: z.string(),
        remote_path: z.string().describe("Destination on the instance, e.g. /root/project or /root/data/"),
        allow_sensitive: z.boolean().default(false),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    wrap(async ({ instance_id, local_path, remote_path, allow_sensitive = false }) => {
      const local = path.resolve(expandHome(local_path));
      if (!fs.existsSync(local)) return fail(`No such local path: ${local}`);
      const why = sensitiveReason(local);
      if (why && !allow_sensitive) {
        return fail(`Refused to upload ${local}: ${why}. If the user explicitly wants it on the instance, call again with allow_sensitive=true.`);
      }
      const { client } = await connectTo(instance_id);
      const remote = remote_path.startsWith("~/") ? remote_path.slice(2) : remote_path;
      const r = await upload(client, local, remote);
      return ok({ uploaded_files: r.files, bytes: r.bytes, remote_path });
    }),
  );

  server.registerTool(
    "download",
    {
      title: "Download from the instance",
      description:
        "Copies a file or directory from the instance to this computer. Do this for every result before stop_instance: destroying an instance erases its disk.",
      inputSchema: {
        instance_id: z.string(),
        remote_path: z.string(),
        local_path: z.string().describe("Local destination file or directory, e.g. ./outputs/"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    wrap(async ({ instance_id, remote_path, local_path }) => {
      const { client } = await connectTo(instance_id);
      const remote = remote_path.startsWith("~/") ? remote_path.slice(2) : remote_path;
      const r = await download(client, remote, path.resolve(expandHome(local_path)));
      track(instance_id).downloaded = true;
      return ok({
        files: r.files.slice(0, 200),
        file_count: r.files.length,
        bytes: r.bytes,
      });
    }),
  );

  server.registerTool(
    "tail_logs",
    {
      title: "Job logs and GPU use",
      description:
        "Last lines of a background job's log (job_id) or any log file (path), whether the job is still running and its exit code, plus current GPU utilisation and memory.",
      inputSchema: {
        instance_id: z.string(),
        job_id: z.string().optional(),
        path: z.string().optional(),
        lines: z.number().int().min(1).max(2000).default(100),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    wrap(async ({ instance_id, job_id, path: logPath, lines = 100 }) => {
      if (!job_id && !logPath) return fail("Give job_id (from run_command background=true) or path.");
      if (job_id && !/^[a-z0-9]+$/i.test(job_id)) return fail("Bad job_id.");
      const { client, secrets } = await connectTo(instance_id);
      const file = job_id ? `${JOBS}/${job_id}.log` : logPath.startsWith("~/") ? logPath.slice(2) : logPath;
      const exitFile = job_id ? `${JOBS}/${job_id}.exit` : "/nonexistent";
      const r = await exec(
        client,
        `cd ~; echo '<<LOG'; tail -n ${lines} ${shq(file)} 2>&1; echo 'LOG>>'; ` +
          `if [ -f ${shq(exitFile)} ]; then echo "EXIT=$(cat ${shq(exitFile)})"; fi; ` +
          `nvidia-smi --query-gpu=index,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null | sed 's/^/GPU=/'`,
        { timeoutSec: 60 },
      );
      const s = r.stdout;
      const log = s.includes("<<LOG") ? s.slice(s.indexOf("<<LOG") + 6, s.lastIndexOf("LOG>>")) : s;
      const exitM = s.match(/EXIT=(\d+)/);
      const gpus = [...s.matchAll(/GPU=(\d+), (\d+), (\d+), (\d+)/g)].map((m) => ({
        gpu: Number(m[1]),
        utilization_pct: Number(m[2]),
        memory_used_mb: Number(m[3]),
        memory_total_mb: Number(m[4]),
      }));
      return ok({
        log: cleanOut(log, secrets),
        ...(job_id ? { running: !exitM, exit_code: exitM ? Number(exitM[1]) : null } : {}),
        gpus,
      });
    }),
  );

  server.registerTool(
    "stop_instance",
    {
      title: "Destroy an instance",
      description:
        "Destroys the instance and stops billing. Its disk is erased. If commands were run on it in this session and nothing was downloaded, this refuses unless force=true (only after the user confirms the results are not needed).",
      inputSchema: {
        instance_id: z.string(),
        force: z.boolean().default(false),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    wrap(async ({ instance_id, force = false }) => {
      const s = session.get(instance_id);
      if (s && s.ran && !s.downloaded && !force) {
        return fail(
          "Not stopped: nothing has been downloaded from this instance yet, and stopping erases its disk. Download the results first, or ask the user and call again with force=true.",
        );
      }
      pool.close(instance_id);
      try {
        const inst = await api.destroy(instance_id);
        session.delete(instance_id);
        return ok({ ...publicInstance(inst), note: "Destroyed. Billing has stopped." });
      } catch (err) {
        if (err instanceof ApiError && err.code === "cannot_destroy") {
          // 已经停了（限额到线、余额用完、开出来没 GPU 被平台退款）：告诉助手结果，而不是报错
          const inst = await api.instance(instance_id).catch(() => null);
          if (inst && inst.status !== "running") {
            session.delete(instance_id);
            return ok({ ...publicInstance(inst), note: "Already stopped; nothing more to do. Billing has stopped." });
          }
        }
        if (err instanceof ApiError && err.code === "instance_provisioning") {
          return fail("The instance is still starting and cannot be destroyed yet. Wait for get_status to show running (or failed; failed instances are not charged), then call stop_instance again.");
        }
        throw err;
      }
    }),
  );
}

// ── rules for the assistant ──────────────────────────────────────────────

server.registerResource(
  "rules",
  "cloudgpu://rules",
  { title: "CloudGPU agent rules", description: "How to rent, run and shut down safely", mimeType: "text/markdown" },
  async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: RULES }] }),
);

server.registerPrompt(
  "train_on_cloudgpu",
  {
    title: "Run a job on a CloudGPU GPU",
    description: "Rent a GPU, run a training or fine-tuning job, bring the results back and shut down",
    argsSchema: { task: z.string().describe("What to run, e.g. 'LoRA fine-tune a 7B base model on data/train.jsonl'") },
  },
  ({ task }) => ({
    messages: [{ role: "user", content: { type: "text", text: `${RULES}\n\n---\n\nTask: ${task}` } }],
  }),
);

// ── start ────────────────────────────────────────────────────────────────

if (process.argv.includes("--version")) {
  console.log(VERSION);
  process.exit(0);
}

const transport = new StdioServerTransport();
await server.connect(transport);
const bye = () => {
  pool.closeAll();
  process.exit(0);
};
process.on("SIGINT", bye);
process.on("SIGTERM", bye);
process.stdin.on("close", bye);
if (!cfg.apiKey) {
  console.error("cloudgpu-mcp: CLOUDGPU_API_KEY is not set; tools will return an error until it is. Create a key at https://cloudgpu.app/api");
}
