// cloudgpu 命令行工具的全部逻辑。src/cli.js 只是入口，这里导出 run() 方便测试在进程内调用。
// 只用 Node 18+ 自带模块，不加运行时依赖；HTTP 请求复用 api.js 里的 CloudGpuApi。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { parseArgs } from "node:util";
import { spawn as nodeSpawn } from "node:child_process";
import { CloudGpuApi, ApiError, sleep as defaultSleep } from "./api.js";
import { redact } from "./guards.js";

export const VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const KEYS_URL = "https://cloudgpu.app/api";
const BILLING_URL = "https://cloudgpu.app/billing";

// 参数或用法错误：退出码 2
export class UsageError extends Error {
  constructor(message, command) {
    super(message);
    this.command = command;
  }
}

// 运行时错误（实例失败、用户取消等）：退出码默认 1
export class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

// ── 命令定义 ─────────────────────────────────────────────────────────────
// options 直接交给 util.parseArgs；args 是位置参数的名字（目前最多一个）。

const JSON_OPT = { json: { type: "boolean" } };
const SHOW_PW = { "show-password": { type: "boolean" } };

const COMMANDS = {
  login: {
    summary: "Save an API key to ~/.config/cloudgpu/config.json",
    usage: "cloudgpu login [--no-verify]",
    details: [
      "Prompts for the key (input hidden), or reads it from stdin: echo \"$KEY\" | cloudgpu login",
      "The key is checked against the API before it is saved, unless --no-verify is given.",
      "The file is written with 0600 permissions. CLOUDGPU_API_KEY, if set, takes precedence over the saved key.",
      `Create a key at ${KEYS_URL}`,
    ],
    options: { "no-verify": { type: "boolean" } },
    args: [],
  },
  offers: {
    summary: "GPU models for rent, with live price and availability",
    usage: "cloudgpu offers [--template <id>] [--json]",
    details: ["--template <id>  only GPUs with enough VRAM for that template (see `cloudgpu templates`)"],
    options: { ...JSON_OPT, template: { type: "string" } },
    args: [],
  },
  templates: {
    summary: "Ready-made instance images (JupyterLab, ComfyUI, Ollama, ...)",
    usage: "cloudgpu templates [--json]",
    details: [],
    options: { ...JSON_OPT },
    args: [],
  },
  up: {
    summary: "Rent a GPU instance",
    usage:
      'cloudgpu up --gpu "RTX 4090" [--template <id>] [--count N] [--max-minutes N] [--max-spend USD] [--idle-minutes N] [--setup FILE] [--wait] [--json]',
    details: [
      "--gpu <model>        GPU model as `cloudgpu offers` lists it (required)",
      "--template <id>      template id from `cloudgpu templates`; omit for a plain GPU with Python and CUDA",
      "--count N            number of GPUs, 1-8 (default 1)",
      "--max-minutes N      destroy the instance N minutes after it starts (enforced by the server)",
      "--max-spend USD      destroy the instance before it costs more than this (enforced by the server)",
      "--idle-minutes N     destroy after the GPU is idle this long; 0 = off, otherwise 10-1440",
      "--setup FILE         bash script run once as root after the instance is handed over (up to 16 KB);",
      "                     output in /root/cloudgpu-setup.log on the instance",
      "--wait               poll until the instance is running or failed, then print SSH and URLs",
      "--show-password      with --wait, also print the SSH password if the API returns one",
      "Costs money: billing is per minute from your prepaid balance until the instance is destroyed.",
    ],
    options: {
      ...JSON_OPT,
      ...SHOW_PW,
      gpu: { type: "string" },
      template: { type: "string" },
      count: { type: "string" },
      "max-minutes": { type: "string" },
      "max-spend": { type: "string" },
      "idle-minutes": { type: "string" },
      setup: { type: "string" },
      wait: { type: "boolean" },
    },
    args: [],
  },
  ls: {
    summary: "List instances (running, starting, and recently stopped)",
    usage: "cloudgpu ls [--json]",
    details: [],
    options: { ...JSON_OPT },
    args: [],
  },
  status: {
    summary: "Show one instance: status, cost so far, SSH, URLs, limits",
    usage: "cloudgpu status <id> [--json] [--show-password]",
    details: [],
    options: { ...JSON_OPT, ...SHOW_PW },
    args: ["id"],
  },
  down: {
    summary: "Destroy an instance (stops billing, erases its disk)",
    usage: "cloudgpu down <id> [--yes] [--json]",
    details: ["Asks for confirmation unless --yes (-y) is given. Download your results first."],
    options: { ...JSON_OPT, yes: { type: "boolean", short: "y" } },
    args: ["id"],
  },
  ssh: {
    summary: "Open an SSH session to a running instance",
    usage: "cloudgpu ssh <id> [--show-password] [-- <extra ssh args or remote command>]",
    details: [
      "Runs your system `ssh` with the host, port and user from the API.",
      "The password is printed only with --show-password.",
    ],
    options: { ...SHOW_PW },
    args: ["id"],
    passthrough: true,
  },
  balance: {
    summary: "Account balance and instance quota",
    usage: "cloudgpu balance [--json]",
    details: [],
    options: { ...JSON_OPT },
    args: [],
  },
};

export function helpText(command) {
  if (command && COMMANDS[command]) {
    const c = COMMANDS[command];
    return [`${c.summary}.`, "", `Usage: ${c.usage}`, ...(c.details.length ? ["", ...c.details.map((d) => "  " + d)] : []), ""].join("\n");
  }
  const width = Math.max(...Object.keys(COMMANDS).map((k) => k.length)) + 2;
  return [
    `cloudgpu ${VERSION}: rent GPUs on cloudgpu.app from the command line.`,
    "",
    "Usage: cloudgpu <command> [options]",
    "",
    "Commands:",
    ...Object.entries(COMMANDS).map(([k, c]) => "  " + k.padEnd(width) + c.summary),
    "",
    "Options:",
    "  --json       machine-readable output (offers, templates, ls, status, balance, up, down)",
    "  -h, --help   help for a command: cloudgpu <command> --help",
    "  --version    print the version",
    "",
    "Auth: CLOUDGPU_API_KEY, or the key saved by `cloudgpu login`. CLOUDGPU_BASE_URL overrides the API host.",
    `Keys: ${KEYS_URL}   Pricing: https://cloudgpu.app/pricing`,
    "",
  ].join("\n");
}

// ── 参数解析 ─────────────────────────────────────────────────────────────

/**
 * 把 argv（不含 node 和脚本路径）解析成 { command, values, positionals, passthrough }。
 * 特殊结果：command 为 "help" / "version" 时由 run() 直接打印。出错抛 UsageError。
 */
export function parseCli(argv) {
  // `--` 之后的内容原样交给 ssh，不参与解析
  const dd = argv.indexOf("--");
  const head = dd === -1 ? argv : argv.slice(0, dd);
  const passthrough = dd === -1 ? [] : argv.slice(dd + 1);

  const cmdIdx = head.findIndex((a) => !a.startsWith("-"));
  const command = cmdIdx === -1 ? null : head[cmdIdx];
  const rest = cmdIdx === -1 ? head : [...head.slice(0, cmdIdx), ...head.slice(cmdIdx + 1)];

  if (!command || command === "help") {
    if (head.includes("--version") || head.includes("-v")) return { command: "version" };
    const topic = command === "help" ? rest.find((a) => !a.startsWith("-")) : undefined;
    return { command: "help", topic };
  }
  const spec = COMMANDS[command];
  if (!spec) throw new UsageError(`unknown command "${command}". Run \`cloudgpu --help\` to see the commands.`);
  if (rest.includes("--help") || rest.includes("-h")) return { command: "help", topic: command };
  if (passthrough.length && !spec.passthrough) throw new UsageError(`\`cloudgpu ${command}\` does not take arguments after --`, command);

  let parsed;
  try {
    parsed = parseArgs({ args: rest, options: spec.options, allowPositionals: true, strict: true });
  } catch (err) {
    // util.parseArgs 的报错已经说明了是哪个选项
    throw new UsageError(err.message.replace(/\s*To specify a positional argument.*$/s, ""), command);
  }
  const { values, positionals } = parsed;
  if (positionals.length < spec.args.length) {
    throw new UsageError(`missing <${spec.args[positionals.length]}>. Usage: ${spec.usage}`, command);
  }
  if (positionals.length > spec.args.length) {
    throw new UsageError(`unexpected argument "${positionals[spec.args.length]}". Usage: ${spec.usage}`, command);
  }
  return { command, values, positionals, passthrough };
}

function intOpt(values, name, min, max) {
  const v = values[name];
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) {
    throw new UsageError(`--${name} must be a whole number from ${min} to ${max} (got "${v}")`, "up");
  }
  return Number(v);
}

export const SETUP_MAX_CHARS = 16384;

/** 把 up 的选项变成 POST /v1/gpu/instances 的请求体（gpu_model 稍后用 offers 校正大小写）。 */
export function buildCreateBody(values) {
  if (!values.gpu || !values.gpu.trim()) throw new UsageError('--gpu is required, e.g. --gpu "RTX 4090" (see `cloudgpu offers`)', "up");
  const body = { gpu_model: values.gpu.trim() };
  if (values.template) body.template = values.template;
  body.gpu_count = intOpt(values, "count", 1, 8) ?? 1;
  const maxMinutes = intOpt(values, "max-minutes", 1, 10080);
  if (maxMinutes !== undefined) body.max_minutes = maxMinutes;
  if (values["max-spend"] !== undefined) {
    const s = values["max-spend"];
    const n = Number(s);
    if (!/^\d+(\.\d+)?$/.test(s) || !(n > 0)) throw new UsageError(`--max-spend must be a positive amount in USD (got "${s}")`, "up");
    body.max_spend_usd = n;
  }
  const idle = intOpt(values, "idle-minutes", 0, 1440);
  if (idle !== undefined) {
    if (idle > 0 && idle < 10) throw new UsageError("--idle-minutes must be 0 (off) or from 10 to 1440", "up");
    body.idle_minutes = idle;
  }
  if (values.setup !== undefined) {
    // 启动脚本从文件读，服务器上限 16 KB（按字符算），这里先挡一道
    let script;
    try {
      script = fs.readFileSync(values.setup, "utf8");
    } catch (e) {
      throw new UsageError(`--setup: cannot read ${values.setup} (${e.code || e.message})`, "up");
    }
    script = script.replace(/\r\n/g, "\n").trim();
    if (!script) throw new UsageError(`--setup: ${values.setup} is empty`, "up");
    if (script.length > SETUP_MAX_CHARS) throw new UsageError(`--setup: script is ${script.length} characters; the limit is ${SETUP_MAX_CHARS}`, "up");
    body.setup_script = script;
  }
  return body;
}

// ── 配置文件 ─────────────────────────────────────────────────────────────

export function configPath(env) {
  const base = env.XDG_CONFIG_HOME || path.join(env.HOME || env.USERPROFILE || os.homedir(), ".config");
  return path.join(base, "cloudgpu", "config.json");
}

export function readConfig(env) {
  const file = configPath(env);
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw new CliError(`Could not read ${file}: ${err.message}`);
  }
  try {
    const cfg = JSON.parse(text);
    return cfg && typeof cfg === "object" ? cfg : {};
  } catch {
    throw new CliError(`${file} is not valid JSON. Fix it or run \`cloudgpu login\` again after deleting it.`);
  }
}

/** 写配置：目录 0700，文件 0600；先写临时文件再改名，避免写一半。 */
export function writeConfig(env, cfg) {
  const file = configPath(env);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(tmp, 0o600); // umask 可能把 mode 改掉，这里再设一次
  fs.renameSync(tmp, file);
  return file;
}

/** 环境变量优先，其次是 login 保存的 key。 */
export function resolveApiKey(env) {
  const fromEnv = (env.CLOUDGPU_API_KEY || "").trim();
  if (fromEnv) return { key: fromEnv, source: "env" };
  const key = (readConfig(env).api_key || "").trim();
  return key ? { key, source: "config" } : { key: "", source: null };
}

// ── 输出格式 ─────────────────────────────────────────────────────────────

export function table(headers, rows) {
  const cells = [headers, ...rows].map((r) => r.map((c) => (c == null || c === "" ? "-" : String(c))));
  const widths = headers.map((_, i) => Math.max(...cells.map((r) => r[i].length)));
  return cells.map((r) => r.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd()).join("\n") + "\n";
}

// 金额照 API 返回的数字显示，不做任何写死的价格
export function usd(n) {
  if (n == null || n === "" || !Number.isFinite(Number(n))) return "-";
  return "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

function gpuLabel(inst) {
  return inst.gpu_model ? `${inst.gpu_model}${inst.gpu_count > 1 ? ` x${inst.gpu_count}` : ""}` : "-";
}

function sshCommand(ssh) {
  if (!ssh || !ssh.host) return null;
  return `ssh -p ${ssh.port || 22} ${ssh.user || "root"}@${ssh.host}`;
}

/** --json 输出里的实例：没有 --show-password 时去掉 SSH 密码。 */
function scrubInstance(inst, showPassword) {
  if (!inst || !inst.ssh || showPassword || inst.ssh.password == null) return inst;
  const { password, ...ssh } = inst.ssh;
  return { ...inst, ssh: { ...ssh, password_hidden: true } };
}

function limitsText(l) {
  if (!l) return null;
  const parts = [];
  if (l.max_minutes != null) parts.push(`max ${l.max_minutes} min`);
  if (l.max_spend_usd != null) parts.push(`max ${usd(l.max_spend_usd)}`);
  if (l.idle_minutes != null) parts.push(l.idle_minutes === 0 ? "idle shutdown off" : `idle ${l.idle_minutes} min`);
  return parts.length ? parts.join(", ") : null;
}

export function instanceDetails(inst, { showPassword = false } = {}) {
  const rows = [
    ["ID", inst.id],
    ["Status", inst.status],
    ["GPU", gpuLabel(inst)],
    ["Template", inst.template || "(none)"],
    ["Price", inst.hourly_usd != null ? `${usd(inst.hourly_usd)}/hr` : null],
    ["Running", inst.running_minutes != null ? `${inst.running_minutes} min` : null],
    ["Cost", inst.cost_usd != null ? usd(inst.cost_usd) : null],
    ["Limits", limitsText(inst.limits)],
    ["Stopped by", inst.limits && inst.limits.stopped_by ? `${inst.limits.stopped_by} limit` : null],
    ["Failure", inst.failure_reason || null],
    ["SSH", inst.status === "running" ? sshCommand(inst.ssh) : null],
    [
      "Password",
      inst.status === "running" && inst.ssh && inst.ssh.password
        ? showPassword
          ? inst.ssh.password
          : "(hidden; add --show-password to print it)"
        : null,
    ],
    ["URL", inst.api_url || null],
  ].filter(([, v]) => v != null && v !== "");
  const w = Math.max(...rows.map(([k]) => k.length)) + 2;
  return rows.map(([k, v]) => k.padEnd(w) + v).join("\n") + "\n";
}

// ── 错误到文字的映射 ──────────────────────────────────────────────────────

/** 返回 { message, exitCode }。API 的报错直接显示 error.message。 */
export function describeError(err) {
  if (err instanceof UsageError) {
    const hint = err.command ? `Run \`cloudgpu ${err.command} --help\` for usage.` : "";
    return { message: `cloudgpu: ${err.message}${hint && !err.message.includes("Usage:") ? "\n" + hint : ""}`, exitCode: 2 };
  }
  if (err instanceof ApiError) {
    if (err.status === 0) return { message: `Error: ${err.message}`, exitCode: 1 };
    let msg = `Error: ${err.message} (HTTP ${err.status}${err.code ? `, ${err.code}` : ""})`;
    if (err.status === 401) msg += `\nCheck your API key: run \`cloudgpu login\` or set CLOUDGPU_API_KEY. Keys: ${KEYS_URL}`;
    if (err.status === 402) msg += `\nTop up at ${BILLING_URL}`;
    return { message: msg, exitCode: 1 };
  }
  if (err instanceof CliError) return { message: `Error: ${err.message}`, exitCode: err.exitCode };
  return { message: `Error: ${err && err.message ? err.message : String(err)}`, exitCode: 1 };
}

// ── 交互输入 ─────────────────────────────────────────────────────────────

function readAll(stream) {
  return new Promise((resolve, reject) => {
    let data = "";
    stream.setEncoding && stream.setEncoding("utf8");
    stream.on("data", (c) => (data += c));
    stream.on("end", () => resolve(data));
    stream.on("error", reject);
  });
}

/** 终端里读一行，不回显（输入 API key 用）。 */
function promptHidden(stdin, stderr, question) {
  return new Promise((resolve, reject) => {
    stderr.write(question);
    let buf = "";
    const done = (fn) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      stderr.write("\n");
      fn();
    };
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === "\r" || ch === "\n") return done(() => resolve(buf));
        if (ch === "\u0003") return done(() => reject(new CliError("Cancelled.", 130)));
        if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
        else if (ch >= " ") buf += ch;
      }
    };
    stdin.setEncoding("utf8");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

function promptLine(stdin, stderr, question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: stdin, output: stderr, terminal: true });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// ── 主入口 ────────────────────────────────────────────────────────────────

/**
 * 运行一条命令，返回退出码。ctx 里的东西都可以替换，方便测试：
 *   env, stdin, stdout, stderr, spawn, sleep, pollIntervalMs
 */
export async function run(argv, ctx = {}) {
  const env = ctx.env || process.env;
  const stdout = ctx.stdout || process.stdout;
  const stderr = ctx.stderr || process.stderr;
  const out = (s) => stdout.write(s);
  let apiKey = "";
  try {
    const p = parseCli(argv);
    if (p.command === "version") {
      out(VERSION + "\n");
      return 0;
    }
    if (p.command === "help") {
      out(helpText(p.topic));
      return 0;
    }
    const c = {
      ...p,
      env,
      out,
      err: (s) => stderr.write(s),
      stderr,
      stdin: ctx.stdin || process.stdin,
      spawn: ctx.spawn || nodeSpawn,
      sleep: ctx.sleep || defaultSleep,
      pollIntervalMs: ctx.pollIntervalMs ?? 5000,
      baseUrl: env.CLOUDGPU_BASE_URL || "https://cloudgpu.app",
    };
    if (p.command === "login") return await cmdLogin(c);
    // up 的参数先校验，写错了不用登录也能看到用法错误
    if (p.command === "up") c.body = buildCreateBody(p.values);
    apiKey = resolveApiKey(env).key;
    if (!apiKey) {
      throw new CliError(`Not logged in. Run \`cloudgpu login\` or set CLOUDGPU_API_KEY. Create a key at ${KEYS_URL}`);
    }
    c.api = new CloudGpuApi({ apiKey, baseUrl: c.baseUrl, userAgent: `cloudgpu-cli/${VERSION}` });
    return await HANDLERS[p.command](c);
  } catch (err) {
    const { message, exitCode } = describeError(err);
    stderr.write(redact(message, [apiKey]) + "\n");
    return exitCode;
  }
}

const HANDLERS = {
  offers: cmdOffers,
  templates: cmdTemplates,
  up: cmdUp,
  ls: cmdLs,
  status: cmdStatus,
  down: cmdDown,
  ssh: cmdSsh,
  balance: cmdBalance,
};

function printJson(c, obj) {
  c.out(JSON.stringify(obj, null, 2) + "\n");
}

// ── 各命令 ────────────────────────────────────────────────────────────────

async function cmdLogin(c) {
  const stdin = c.stdin;
  let key;
  if (stdin.isTTY && typeof stdin.setRawMode === "function") {
    key = await promptHidden(stdin, { write: c.err }, `API key (create one at ${KEYS_URL}): `);
  } else {
    key = await readAll(stdin);
  }
  key = String(key || "").trim();
  if (!key) throw new UsageError("no API key given. Type it at the prompt, or pipe it in: echo \"$KEY\" | cloudgpu login", "login");
  if (/\s/.test(key)) throw new UsageError("the API key must be a single line without spaces", "login");

  if (!c.values["no-verify"]) {
    const api = new CloudGpuApi({ apiKey: key, baseUrl: c.baseUrl, userAgent: `cloudgpu-cli/${VERSION}` });
    try {
      await api.account();
    } catch (err) {
      // 校验失败就不保存，错误信息里不带 key
      const { message } = describeError(err);
      throw new CliError(`${redact(message.replace(/^Error: /, ""), [key])}\nThe key was not saved.`);
    }
  }
  const cfg = readConfig(c.env);
  cfg.api_key = key;
  const file = writeConfig(c.env, cfg);
  c.out(`Saved API key to ${file}\n`);
  if ((c.env.CLOUDGPU_API_KEY || "").trim()) {
    c.err("Note: CLOUDGPU_API_KEY is set in your environment and takes precedence over the saved key.\n");
  }
  return 0;
}

async function cmdOffers(c) {
  let offers = await c.api.offers();
  let tpl = null;
  if (c.values.template) {
    const templates = await c.api.templates();
    tpl = templates.find((t) => t.id === c.values.template);
    if (!tpl) {
      throw new CliError(`No template "${c.values.template}". Templates: ${templates.map((t) => t.id).join(", ") || "(none)"}`);
    }
    // 按模板估计的显存过滤；min_gpu_count 取两者较大的一个
    const need = Number(tpl.estimated_vram_gb) || 0;
    const minCount = Math.max(1, Number(tpl.min_gpu_count) || 1);
    offers = offers
      .filter((o) => (Number(o.vram_gb) || 0) * Math.max(minCount, Number(o.min_gpu_count) || 1) >= need)
      .map((o) => ({ ...o, min_gpu_count: Math.max(minCount, Number(o.min_gpu_count) || 1) }));
  }
  if (c.values.json) {
    printJson(c, tpl ? { template: tpl.id, offers } : offers);
    return 0;
  }
  if (!offers.length) {
    c.out(tpl ? `No GPU on offer fits template ${tpl.id} right now.\n` : "No GPUs on offer right now.\n");
    return 0;
  }
  c.out(
    table(
      ["GPU", "VRAM", "PER GPU-HOUR", "AVAILABLE", "MIN GPUS"],
      offers.map((o) => [o.gpu_model, o.vram_gb != null ? `${o.vram_gb} GB` : null, usd(o.hourly_usd), o.available, o.min_gpu_count]),
    ),
  );
  c.out("Prices and availability are live from the API and can change; billed per minute.\n");
  if (tpl && tpl.recommended_gpu) c.out(`Template ${tpl.id} recommends: ${tpl.recommended_gpu}\n`);
  return 0;
}

async function cmdTemplates(c) {
  const templates = await c.api.templates();
  if (c.values.json) {
    printJson(c, templates);
    return 0;
  }
  if (!templates.length) {
    c.out("No templates.\n");
    return 0;
  }
  c.out(
    table(
      ["ID", "NAME", "CATEGORY", "RECOMMENDED GPU", "MIN GPUS", "VRAM", "API URL"],
      templates.map((t) => [
        t.id,
        t.name,
        t.category,
        t.recommended_gpu,
        t.min_gpu_count,
        t.estimated_vram_gb != null ? `${t.estimated_vram_gb} GB` : null,
        t.has_api_endpoint ? "yes" : "no",
      ]),
    ),
  );
  return 0;
}

async function cmdUp(c) {
  const body = c.body;
  // 用 offers 把 GPU 名字校正成 API 的写法（大小写、空格不敏感）
  const offers = await c.api.offers();
  const norm = (s) => String(s).toLowerCase().replace(/\s+/g, "");
  const offer = offers.find((o) => norm(o.gpu_model) === norm(body.gpu_model));
  if (!offer) {
    throw new CliError(`No GPU named "${body.gpu_model}". Available: ${offers.map((o) => o.gpu_model).join(", ") || "(none)"}`);
  }
  body.gpu_model = offer.gpu_model;
  if (offer.available === "none") {
    c.err(`Warning: the API reports no ${offer.gpu_model} available right now; the request may fail.\n`);
  }

  let inst = await c.api.create(body);
  const showPassword = !!c.values["show-password"];
  if (!c.values.wait) {
    if (c.values.json) {
      printJson(c, scrubInstance(inst, showPassword));
      return 0;
    }
    c.out(`Created ${inst.id} (${gpuLabel(inst)}, status: ${inst.status}).\n`);
    c.out(`Billing is per minute until it is destroyed. Check it with: cloudgpu status ${inst.id}\n`);
    c.out(`Destroy it with: cloudgpu down ${inst.id}\n`);
    return 0;
  }

  c.err(`Created ${inst.id}. Waiting for it to be running (Ctrl-C stops waiting; the instance keeps running).\n`);
  inst = await waitForInstance(c, inst);
  if (c.values.json) {
    printJson(c, scrubInstance(inst, showPassword));
  } else {
    c.out(instanceDetails(inst, { showPassword }));
    if (inst.status === "running") c.out(`\nConnect: cloudgpu ssh ${inst.id}\nDestroy: cloudgpu down ${inst.id}\n`);
  }
  if (inst.status === "running") return 0;
  if (inst.status === "failed") {
    c.err(`Instance ${inst.id} failed${inst.failure_reason ? `: ${inst.failure_reason}` : ""}. Failed instances are not charged.\n`);
  } else {
    c.err(`Instance ${inst.id} is ${inst.status}.\n`);
  }
  return 1;
}

/** 轮询直到 running（且有 SSH 信息）、failed 或 stopped。临时网络错误或 5xx 连续 5 次才放弃。 */
export async function waitForInstance(c, inst) {
  const id = inst.id;
  let last = inst.status;
  let runningWithoutSsh = 0;
  let failures = 0;
  const onSigint = () => {
    c.err(`\nStopped waiting. ${id} is still there and may be billing: cloudgpu status ${id} / cloudgpu down ${id}\n`);
    process.exit(130);
  };
  process.once("SIGINT", onSigint);
  try {
    for (;;) {
      if (inst.status === "running") {
        if ((inst.ssh && inst.ssh.host) || ++runningWithoutSsh > 3) return inst;
      } else if (inst.status !== "creating") {
        return inst;
      }
      await c.sleep(c.pollIntervalMs);
      try {
        inst = await c.api.instance(id);
        failures = 0;
      } catch (err) {
        const transient = err instanceof ApiError && (err.status === 0 || err.status >= 500);
        if (!transient || ++failures >= 5) throw err;
        continue;
      }
      if (inst.status !== last) {
        c.err(`${id}: ${inst.status}\n`);
        last = inst.status;
      }
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

async function cmdLs(c) {
  const list = await c.api.instances();
  if (c.values.json) {
    printJson(c, list.map((i) => scrubInstance(i, false)));
    return 0;
  }
  if (!list.length) {
    c.out("No instances.\n");
    return 0;
  }
  c.out(
    table(
      ["ID", "STATUS", "GPU", "TEMPLATE", "PER HOUR", "RUNNING", "COST"],
      list.map((i) => [
        i.id,
        i.status,
        gpuLabel(i),
        i.template,
        usd(i.hourly_usd),
        i.running_minutes != null ? `${i.running_minutes} min` : null,
        usd(i.cost_usd),
      ]),
    ),
  );
  return 0;
}

async function cmdStatus(c) {
  const inst = await c.api.instance(c.positionals[0]);
  const showPassword = !!c.values["show-password"];
  if (c.values.json) printJson(c, scrubInstance(inst, showPassword));
  else c.out(instanceDetails(inst, { showPassword }));
  return 0;
}

async function cmdDown(c) {
  const id = c.positionals[0];
  if (!c.values.yes) {
    const stdin = c.stdin;
    if (!stdin.isTTY) {
      throw new UsageError(`refusing to destroy ${id} without confirmation in a non-interactive shell. Add --yes.`, "down");
    }
    const inst = await c.api.instance(id);
    const what = `${id} (${gpuLabel(inst)}, ${inst.status}${inst.cost_usd != null ? `, cost so far ${usd(inst.cost_usd)}` : ""})`;
    const answer = await promptLine(stdin, c.stderr, `Destroy ${what}? Its disk is erased. [y/N] `);
    if (!/^y(es)?$/i.test(String(answer).trim())) {
      c.err("Not destroyed.\n");
      return 1;
    }
  }
  let inst;
  let note = "Destroyed. Billing has stopped.";
  try {
    inst = await c.api.destroy(id);
  } catch (err) {
    if (err instanceof ApiError && err.code === "cannot_destroy") {
      // 已经停了（到了限额、余额用完、开机失败）：不算错误
      const cur = await c.api.instance(id).catch(() => null);
      if (cur && cur.status !== "running" && cur.status !== "creating") {
        inst = cur;
        note = `Already ${cur.status}; nothing to do.`;
      }
    } else if (err instanceof ApiError && err.code === "instance_provisioning") {
      throw new CliError(`${err.message}\nThe instance is still being created. Run \`cloudgpu down ${id}\` again once \`cloudgpu status ${id}\` shows running or failed.`);
    }
    if (!inst) throw err;
  }
  if (c.values.json) {
    printJson(c, scrubInstance(inst, false));
    return 0;
  }
  c.out(`${id}: ${note}${inst.cost_usd != null ? ` Final cost: ${usd(inst.cost_usd)}.` : ""}\n`);
  return 0;
}

async function cmdSsh(c) {
  const id = c.positionals[0];
  const inst = await c.api.instance(id);
  if (inst.status !== "running") {
    throw new CliError(
      `Instance ${id} is ${inst.status}` +
        (inst.status === "creating"
          ? `; wait for it with \`cloudgpu status ${id}\` until it is running.`
          : inst.failure_reason
            ? `: ${inst.failure_reason}`
            : "."),
    );
  }
  const ssh = inst.ssh;
  if (!ssh || !ssh.host) throw new CliError(`Instance ${id} has no SSH login yet; try again shortly.`);
  if (ssh.password) {
    if (c.values["show-password"]) c.err(`Password: ${ssh.password}\n`);
    else c.err("This instance uses a password login. Run with --show-password to print it.\n");
  }
  const args = ["-p", String(ssh.port || 22), `${ssh.user || "root"}@${ssh.host}`, ...c.passthrough];
  return await new Promise((resolve, reject) => {
    let child;
    try {
      child = c.spawn("ssh", args, { stdio: "inherit" });
    } catch (err) {
      reject(err);
      return;
    }
    child.on("error", (err) => {
      if (err.code === "ENOENT") reject(new CliError("`ssh` was not found. Install an OpenSSH client and try again."));
      else reject(err);
    });
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

async function cmdBalance(c) {
  const a = await c.api.account();
  if (c.values.json) {
    printJson(c, a);
    return 0;
  }
  const rows = [["Balance", usd(a.balance_usd)]];
  if (a.max_running_instances != null) {
    rows.push(["Instances", `${a.running_instances ?? "?"} running of ${a.max_running_instances} allowed`]);
  }
  if (a.gpu_api_enabled === false) rows.push(["GPU API", "not enabled for this account"]);
  if (a.billing) rows.push(["Billing", a.billing]);
  rows.push(["Top up", a.top_up_url || BILLING_URL]);
  const w = Math.max(...rows.map(([k]) => k.length)) + 2;
  c.out(rows.map(([k, v]) => k.padEnd(w) + v).join("\n") + "\n");
  return 0;
}
