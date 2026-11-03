// cloudgpu 命令行工具的测试：本地 node:http 假服务器，不连真实 API。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { run, parseCli, buildCreateBody, UsageError, VERSION, configPath } from "../src/cli-core.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const PKG = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

// ── 测试工具 ──────────────────────────────────────────────────────────────

/**
 * 起一个假 API。routes 的键是 "GET /v1/gpu/offers" 这种形式，值是
 * { status, body } 或者函数 (req, body, n) => { status, body }，n 是这个路由第几次被调用。
 */
async function mockApi(routes) {
  const requests = [];
  const counts = {};
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const key = `${req.method} ${req.url}`;
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      counts[key] = (counts[key] || 0) + 1;
      let r = routes[key];
      if (typeof r === "function") r = r(req, body, counts[key]);
      if (!r) r = { status: 404, body: { error: { code: "not_found", message: `No route ${key}` } } };
      res.writeHead(r.status || 200, { "Content-Type": "application/json" });
      res.end(typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {}));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, requests, close: () => new Promise((r) => server.close(r)) };
}

function sink() {
  return { data: "", write(s) { this.data += s; return true; } };
}

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cloudgpu-cli-test-"));
}

/** 在进程内跑一条命令，返回 { code, out, err }。 */
async function cli(argv, { env = {}, stdin, spawn, sleep } = {}) {
  const stdout = sink();
  const stderr = sink();
  const code = await run(argv, {
    env: { HOME: tmpHome(), ...env },
    stdout,
    stderr,
    stdin: stdin || Object.assign(Readable.from([]), { isTTY: false }),
    spawn,
    sleep: sleep || (async () => {}),
    pollIntervalMs: 0,
  });
  return { code, out: stdout.data, err: stderr.data };
}

const OFFERS = {
  object: "list",
  data: [
    { gpu_model: "RTX 4090", vram_gb: 24, hourly_usd: 0.123, available: "ok", min_gpu_count: 1 },
    { gpu_model: "A100 80GB", vram_gb: 80, hourly_usd: 1.5, available: "low", min_gpu_count: 1 },
  ],
};
const TEMPLATES = {
  object: "list",
  data: [
    { id: "comfyui", name: "ComfyUI", category: "image", recommended_gpu: "RTX 4090", min_gpu_count: 1, estimated_vram_gb: 24, has_api_endpoint: true },
    { id: "big-llm", name: "Big LLM", category: "llm", recommended_gpu: "A100 80GB", min_gpu_count: 1, estimated_vram_gb: 60, has_api_endpoint: false },
  ],
};
const SSH = { host: "10.9.8.7", port: 2222, user: "root", password: "s3cret-pw" };

function inst(over = {}) {
  return { object: "gpu.instance", id: "inst_1", gpu_model: "RTX 4090", gpu_count: 1, template: "comfyui", status: "creating",
    hourly_usd: 0.123, running_minutes: null, cost_usd: null, ssh: null, api_url: null, failure_reason: null,
    limits: { max_minutes: 60, max_spend_usd: 2, idle_minutes: 30, stopped_by: null }, ...over };
}

// ── 参数解析 ──────────────────────────────────────────────────────────────

test("parseCli: commands, options, positionals and passthrough", () => {
  assert.deepEqual(parseCli([]), { command: "help", topic: undefined });
  assert.equal(parseCli(["--version"]).command, "version");
  assert.deepEqual(parseCli(["help", "up"]), { command: "help", topic: "up" });
  assert.deepEqual(parseCli(["down", "--help"]), { command: "help", topic: "down" });

  const up = parseCli(["up", "--gpu", "RTX 4090", "--template=comfyui", "--count", "2", "--wait", "--json"]);
  assert.equal(up.command, "up");
  assert.equal(up.values.gpu, "RTX 4090");
  assert.equal(up.values.template, "comfyui");
  assert.equal(up.values.count, "2");
  assert.equal(up.values.wait, true);
  assert.equal(up.values.json, true);

  // 选项可以写在命令前面
  assert.equal(parseCli(["--json", "ls"]).values.json, true);

  const down = parseCli(["down", "inst_1", "-y"]);
  assert.deepEqual(down.positionals, ["inst_1"]);
  assert.equal(down.values.yes, true);

  const ssh = parseCli(["ssh", "inst_1", "--", "-L", "8188:localhost:8188", "nvidia-smi"]);
  assert.deepEqual(ssh.positionals, ["inst_1"]);
  assert.deepEqual(ssh.passthrough, ["-L", "8188:localhost:8188", "nvidia-smi"]);
});

test("parseCli: usage errors", () => {
  assert.throws(() => parseCli(["frobnicate"]), (e) => e instanceof UsageError && /unknown command/.test(e.message));
  assert.throws(() => parseCli(["ls", "--bogus"]), (e) => e instanceof UsageError && /--bogus/.test(e.message));
  assert.throws(() => parseCli(["status"]), (e) => e instanceof UsageError && /missing <id>/.test(e.message));
  assert.throws(() => parseCli(["ls", "extra"]), (e) => e instanceof UsageError && /unexpected argument/.test(e.message));
  assert.throws(() => parseCli(["ls", "--", "x"]), UsageError);
  assert.throws(() => parseCli(["up", "--gpu"]), UsageError); // 缺值
});

test("buildCreateBody: maps flags to the API body and validates them", () => {
  assert.deepEqual(
    buildCreateBody({ gpu: "RTX 4090", template: "comfyui", count: "2", "max-minutes": "90", "max-spend": "3.5", "idle-minutes": "0" }),
    { gpu_model: "RTX 4090", template: "comfyui", gpu_count: 2, max_minutes: 90, max_spend_usd: 3.5, idle_minutes: 0 },
  );
  assert.deepEqual(buildCreateBody({ gpu: "RTX 4090" }), { gpu_model: "RTX 4090", gpu_count: 1 });
  for (const bad of [{}, { gpu: "x", count: "0" }, { gpu: "x", count: "9" }, { gpu: "x", count: "1.5" },
    { gpu: "x", "idle-minutes": "5" }, { gpu: "x", "max-spend": "-1" }, { gpu: "x", "max-spend": "abc" }, { gpu: "x", "max-minutes": "0" }]) {
    assert.throws(() => buildCreateBody(bad), UsageError, JSON.stringify(bad));
  }
});

test("usage errors exit 2 before any network call", async () => {
  const r = await cli(["up", "--gpu", "RTX 4090", "--idle-minutes", "5"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /idle-minutes/);
  assert.equal((await cli(["nope"])).code, 2);
});

test("help and version", async () => {
  const v = await cli(["--version"]);
  assert.equal(v.code, 0);
  assert.equal(v.out.trim(), PKG.version);
  assert.equal(VERSION, PKG.version);
  const h = await cli(["--help"]);
  assert.equal(h.code, 0);
  for (const c of ["login", "offers", "templates", "up", "ls", "status", "down", "ssh", "balance"]) assert.match(h.out, new RegExp(`\\b${c}\\b`));
  assert.match((await cli(["up", "--help"])).out, /--max-spend/);
});

// ── login 和配置文件 ──────────────────────────────────────────────────────

test("login verifies the key, saves it with 0600 perms, and env wins over it", async () => {
  const api = await mockApi({
    "GET /v1/gpu/account": (req) =>
      req.headers.authorization === "Bearer cgw-sk-bad"
        ? { status: 401, body: { error: { code: "invalid_api_key", message: "Invalid API key." } } }
        : { body: { object: "account", balance_usd: 12.5, max_running_instances: 2, running_instances: 0 } },
  });
  try {
    const home = tmpHome();
    const env = { HOME: home, CLOUDGPU_BASE_URL: api.url };
    const stdin = Readable.from(["cgw-sk-good\n"]);
    const r = await cli(["login"], { env, stdin });
    assert.equal(r.code, 0, r.err);
    const file = configPath(env);
    assert.equal(file, path.join(home, ".config", "cloudgpu", "config.json"));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).api_key, "cgw-sk-good");
    assert.equal(api.requests.at(-1).headers.authorization, "Bearer cgw-sk-good");
    assert.match(api.requests.at(-1).headers["user-agent"], /^cloudgpu-cli\//);

    // 已有文件的权限被放宽过，再次 login 要收紧回 0600
    fs.chmodSync(file, 0o644);
    assert.equal((await cli(["login", "--no-verify"], { env, stdin: Readable.from(["cgw-sk-other"]) })).code, 0);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).api_key, "cgw-sk-other");

    // 保存的 key 会被后续命令使用
    assert.equal((await cli(["balance"], { env })).code, 0);
    assert.equal(api.requests.at(-1).headers.authorization, "Bearer cgw-sk-other");

    // 环境变量优先
    assert.equal((await cli(["balance"], { env: { ...env, CLOUDGPU_API_KEY: "cgw-sk-env" } })).code, 0);
    assert.equal(api.requests.at(-1).headers.authorization, "Bearer cgw-sk-env");

    // 错误的 key：不保存，显示 API 的 message，不回显 key
    const bad = await cli(["login"], { env, stdin: Readable.from(["cgw-sk-bad\n"]) });
    assert.equal(bad.code, 1);
    assert.match(bad.err, /Invalid API key\./);
    assert.match(bad.err, /not saved/);
    assert.ok(!bad.err.includes("cgw-sk-bad"));
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).api_key, "cgw-sk-other");

    // 空输入是用法错误
    assert.equal((await cli(["login"], { env, stdin: Readable.from([""]) })).code, 2);
  } finally {
    await api.close();
  }
});

test("commands without a key say how to log in", async () => {
  const r = await cli(["ls"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /cloudgpu login/);
  assert.match(r.err, /CLOUDGPU_API_KEY/);
});

// ── 读命令：表格和 --json ────────────────────────────────────────────────

test("offers, templates, ls, status and balance: tables and --json", async () => {
  const api = await mockApi({
    "GET /v1/gpu/offers": { body: OFFERS },
    "GET /v1/gpu/templates": { body: TEMPLATES },
    "GET /v1/gpu/instances": { body: { object: "list", data: [inst({ status: "running", ssh: SSH, running_minutes: 12, cost_usd: 0.03 })] } },
    "GET /v1/gpu/instances/inst_1": { body: inst({ status: "running", ssh: SSH, api_url: "https://inst-1.example.test" }) },
    "GET /v1/gpu/account": { body: { object: "account", balance_usd: 12.5, max_running_instances: 2, running_instances: 1, top_up_url: "https://cloudgpu.app/billing" } },
  });
  const env = { CLOUDGPU_API_KEY: "cgw-sk-test", CLOUDGPU_BASE_URL: api.url };
  try {
    let r = await cli(["offers"], { env });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^GPU\s+VRAM\s+PER GPU-HOUR\s+AVAILABLE/);
    assert.match(r.out, /RTX 4090\s+24 GB\s+\$0\.123\s+ok/);
    assert.equal(api.requests.at(-1).headers.authorization, "Bearer cgw-sk-test");

    r = await cli(["offers", "--json"], { env });
    assert.deepEqual(JSON.parse(r.out), OFFERS.data);

    // --template 按模板估计的显存过滤
    r = await cli(["offers", "--template", "big-llm", "--json"], { env });
    assert.deepEqual(JSON.parse(r.out).offers.map((o) => o.gpu_model), ["A100 80GB"]);
    r = await cli(["offers", "--template", "nope"], { env });
    assert.equal(r.code, 1);
    assert.match(r.err, /No template "nope".*comfyui/);

    r = await cli(["templates"], { env });
    assert.match(r.out, /comfyui\s+ComfyUI\s+image/);
    assert.deepEqual(JSON.parse((await cli(["templates", "--json"], { env })).out), TEMPLATES.data);

    r = await cli(["ls"], { env });
    assert.match(r.out, /inst_1\s+running\s+RTX 4090\s+comfyui\s+\$0\.123\s+12 min\s+\$0\.03/);
    r = await cli(["ls", "--json"], { env });
    const list = JSON.parse(r.out);
    assert.equal(list[0].id, "inst_1");
    assert.equal(list[0].ssh.password, undefined); // --json 默认不带密码
    assert.equal(list[0].ssh.password_hidden, true);
    assert.ok(!r.out.includes("s3cret-pw"));

    r = await cli(["status", "inst_1"], { env });
    assert.match(r.out, /SSH\s+ssh -p 2222 root@10\.9\.8\.7/);
    assert.match(r.out, /URL\s+https:\/\/inst-1\.example\.test/);
    assert.ok(!r.out.includes("s3cret-pw"));
    r = await cli(["status", "inst_1", "--show-password"], { env });
    assert.match(r.out, /Password\s+s3cret-pw/);
    r = await cli(["status", "inst_1", "--json", "--show-password"], { env });
    assert.equal(JSON.parse(r.out).ssh.password, "s3cret-pw");

    r = await cli(["balance"], { env });
    assert.match(r.out, /Balance\s+\$12\.50/);
    assert.match(r.out, /1 running of 2 allowed/);
    assert.equal(JSON.parse((await cli(["balance", "--json"], { env })).out).balance_usd, 12.5);
  } finally {
    await api.close();
  }
});

// ── up --wait ─────────────────────────────────────────────────────────────

test("up --wait polls until running and prints SSH and URLs", async () => {
  const api = await mockApi({
    "GET /v1/gpu/offers": { body: OFFERS },
    "POST /v1/gpu/instances": { status: 201, body: inst() },
    "GET /v1/gpu/instances/inst_1": (_req, _b, n) =>
      n < 3 ? { body: inst() } : { body: inst({ status: "running", ssh: SSH, api_url: "https://inst-1.example.test", running_minutes: 0 }) },
  });
  const env = { CLOUDGPU_API_KEY: "cgw-sk-test", CLOUDGPU_BASE_URL: api.url };
  let sleeps = 0;
  try {
    const r = await cli(
      ["up", "--gpu", "rtx 4090", "--template", "comfyui", "--max-minutes", "60", "--max-spend", "2", "--idle-minutes", "30", "--wait"],
      { env, sleep: async () => { sleeps++; } },
    );
    assert.equal(r.code, 0, r.err);
    const post = api.requests.find((q) => q.method === "POST");
    // GPU 名字按 offers 校正大小写
    assert.deepEqual(post.body, { gpu_model: "RTX 4090", template: "comfyui", gpu_count: 1, max_minutes: 60, max_spend_usd: 2, idle_minutes: 30 });
    assert.equal(api.requests.filter((q) => q.url === "/v1/gpu/instances/inst_1").length, 3);
    assert.equal(sleeps, 3);
    assert.match(r.out, /Status\s+running/);
    assert.match(r.out, /ssh -p 2222 root@10\.9\.8\.7/);
    assert.match(r.out, /https:\/\/inst-1\.example\.test/);
    assert.match(r.out, /cloudgpu down inst_1/);
    assert.ok(!r.out.includes("s3cret-pw"));
    assert.match(r.err, /inst_1: running/);
  } finally {
    await api.close();
  }
});

test("up --wait exits 1 with the failure reason when the instance fails", async () => {
  const api = await mockApi({
    "GET /v1/gpu/offers": { body: OFFERS },
    "POST /v1/gpu/instances": { status: 201, body: inst() },
    "GET /v1/gpu/instances/inst_1": (_req, _b, n) =>
      n < 2 ? { status: 503, body: { error: { message: "busy" } } } : { body: inst({ status: "failed", failure_reason: "No machine could start it." }) },
  });
  const env = { CLOUDGPU_API_KEY: "cgw-sk-test", CLOUDGPU_BASE_URL: api.url };
  try {
    const r = await cli(["up", "--gpu", "RTX 4090", "--wait", "--json"], { env });
    assert.equal(r.code, 1);
    assert.equal(JSON.parse(r.out).status, "failed");
    assert.match(r.err, /failed: No machine could start it\./);
  } finally {
    await api.close();
  }
});

test("up without --wait prints the id; unknown GPU is rejected before creating", async () => {
  const api = await mockApi({
    "GET /v1/gpu/offers": { body: OFFERS },
    "POST /v1/gpu/instances": { status: 201, body: inst() },
  });
  const env = { CLOUDGPU_API_KEY: "cgw-sk-test", CLOUDGPU_BASE_URL: api.url };
  try {
    let r = await cli(["up", "--gpu", "RTX 4090"], { env });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Created inst_1/);
    r = await cli(["up", "--gpu", "RTX 9999"], { env });
    assert.equal(r.code, 1);
    assert.match(r.err, /No GPU named "RTX 9999"\. Available: RTX 4090, A100 80GB/);
    assert.equal(api.requests.filter((q) => q.method === "POST").length, 1);
  } finally {
    await api.close();
  }
});

// ── 错误映射 ──────────────────────────────────────────────────────────────

test("API errors show error.message, the HTTP status and code, and exit non-zero", async () => {
  const api = await mockApi({
    "GET /v1/gpu/offers": { body: OFFERS },
    "POST /v1/gpu/instances": { status: 402, body: { error: { type: "invalid_request_error", code: "insufficient_balance", message: "Your balance is too low for this instance." } } },
    "GET /v1/gpu/account": { status: 401, body: { error: { code: "invalid_api_key", message: "Invalid API key." } } },
    "GET /v1/gpu/templates": { status: 200, body: "<html>oops</html>" },
  });
  const env = { CLOUDGPU_API_KEY: "cgw-sk-test-secret", CLOUDGPU_BASE_URL: api.url };
  try {
    let r = await cli(["up", "--gpu", "RTX 4090"], { env });
    assert.equal(r.code, 1);
    assert.match(r.err, /^Error: Your balance is too low for this instance\. \(HTTP 402, insufficient_balance\)/);
    assert.match(r.err, /cloudgpu\.app\/billing/);

    r = await cli(["balance"], { env });
    assert.equal(r.code, 1);
    assert.match(r.err, /Invalid API key\. \(HTTP 401, invalid_api_key\)/);
    assert.match(r.err, /cloudgpu login/);
    assert.ok(!r.err.includes("cgw-sk-test-secret"));

    r = await cli(["status", "inst_x"], { env });
    assert.equal(r.code, 1);
    assert.match(r.err, /No route GET \/v1\/gpu\/instances\/inst_x \(HTTP 404, not_found\)/);

    r = await cli(["templates"], { env });
    assert.equal(r.code, 1);
    assert.match(r.err, /not JSON/);
  } finally {
    await api.close();
  }
  // 连不上服务器（DELETE 不重试，所以很快）
  const r = await cli(["down", "inst_1", "--yes"], { env: { ...env, CLOUDGPU_BASE_URL: api.url } });
  assert.equal(r.code, 1);
  assert.match(r.err, /^Error: Could not reach http:\/\/127\.0\.0\.1/);
});

// ── down ──────────────────────────────────────────────────────────────────

test("down asks for confirmation, honours --yes, and treats already-stopped as done", async () => {
  const api = await mockApi({
    "DELETE /v1/gpu/instances/inst_1": { body: inst({ status: "stopped", cost_usd: 0.05 }) },
    "DELETE /v1/gpu/instances/inst_2": { status: 409, body: { error: { code: "cannot_destroy", message: "Instance is not running." } } },
    "GET /v1/gpu/instances/inst_2": { body: inst({ id: "inst_2", status: "stopped", cost_usd: 0.2, limits: { stopped_by: "idle" } }) },
    "DELETE /v1/gpu/instances/inst_3": { status: 409, body: { error: { code: "instance_provisioning", message: "Instance is still being created." } } },
  });
  const env = { CLOUDGPU_API_KEY: "cgw-sk-test", CLOUDGPU_BASE_URL: api.url };
  try {
    let r = await cli(["down", "inst_1"], { env });
    assert.equal(r.code, 2);
    assert.match(r.err, /--yes/);
    assert.equal(api.requests.length, 0);

    r = await cli(["down", "inst_1", "--yes"], { env });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Destroyed\. Billing has stopped\. Final cost: \$0\.05/);

    r = await cli(["down", "inst_2", "-y", "--json"], { env });
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out).status, "stopped");

    r = await cli(["down", "inst_3", "-y"], { env });
    assert.equal(r.code, 1);
    assert.match(r.err, /Instance is still being created\./);
  } finally {
    await api.close();
  }
});

// ── ssh ───────────────────────────────────────────────────────────────────

function fakeSpawn(exitCode = 0) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    setImmediate(() => child.emit("exit", exitCode, null));
    return child;
  };
  return { spawn, calls };
}

test("ssh runs the system ssh with host, port and user; password only with --show-password", async () => {
  const api = await mockApi({
    "GET /v1/gpu/instances/inst_1": { body: inst({ status: "running", ssh: SSH }) },
    "GET /v1/gpu/instances/inst_2": { body: inst({ id: "inst_2", status: "creating" }) },
  });
  const env = { CLOUDGPU_API_KEY: "cgw-sk-test", CLOUDGPU_BASE_URL: api.url };
  try {
    let f = fakeSpawn(0);
    let r = await cli(["ssh", "inst_1", "--", "nvidia-smi"], { env, spawn: f.spawn });
    assert.equal(r.code, 0, r.err);
    assert.equal(f.calls[0].cmd, "ssh");
    assert.deepEqual(f.calls[0].args, ["-p", "2222", "root@10.9.8.7", "nvidia-smi"]);
    assert.equal(f.calls[0].opts.stdio, "inherit");
    assert.ok(!r.err.includes("s3cret-pw"));
    assert.match(r.err, /--show-password/);

    f = fakeSpawn(255);
    r = await cli(["ssh", "inst_1", "--show-password"], { env, spawn: f.spawn });
    assert.equal(r.code, 255); // 透传 ssh 的退出码
    assert.match(r.err, /Password: s3cret-pw/);

    f = fakeSpawn(0);
    r = await cli(["ssh", "inst_2"], { env, spawn: f.spawn });
    assert.equal(r.code, 1);
    assert.match(r.err, /inst_2 is creating/);
    assert.equal(f.calls.length, 0);
  } finally {
    await api.close();
  }
});

// ── 真正的 bin（子进程） ───────────────────────────────────────────────────

function runBin(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, HOME: tmpHome(), ...env } }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, out: stdout, err: stderr });
    });
  });
}

test("bin: --version, --json output and exit codes", async () => {
  assert.equal(PKG.bin.cloudgpu, "src/cli.js");
  assert.equal((await runBin(["--version"])).out.trim(), PKG.version);
  const api = await mockApi({
    "GET /v1/gpu/account": (req) =>
      req.headers.authorization === "Bearer cgw-sk-good"
        ? { body: { object: "account", balance_usd: 3 } }
        : { status: 401, body: { error: { code: "invalid_api_key", message: "Invalid API key." } } },
  });
  try {
    let r = await runBin(["balance", "--json"], { CLOUDGPU_API_KEY: "cgw-sk-good", CLOUDGPU_BASE_URL: api.url });
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out).balance_usd, 3);
    r = await runBin(["balance"], { CLOUDGPU_API_KEY: "cgw-sk-bad", CLOUDGPU_BASE_URL: api.url });
    assert.equal(r.code, 1);
    assert.match(r.err, /Invalid API key/);
    assert.equal((await runBin(["up"])).code, 2);
  } finally {
    await api.close();
  }
});

test("versions agree across package.json, server.json and the MCP server", () => {
  const server = JSON.parse(fs.readFileSync(new URL("../server.json", import.meta.url), "utf8"));
  assert.equal(server.version, PKG.version);
  assert.equal(server.packages[0].version, PKG.version);
  const src = fs.readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  assert.match(src, new RegExp(`const VERSION = "${PKG.version.replace(/\./g, "\\.")}"`));
});
