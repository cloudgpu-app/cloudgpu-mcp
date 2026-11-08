// CloudGPU REST client. Talks only to the public API (https://cloudgpu.app/v1/...),
// with the user's own API key. Nothing here knows or needs anything that is not public.

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class CloudGpuApi {
  constructor({ apiKey, baseUrl = "https://cloudgpu.app", fetchImpl = globalThis.fetch, userAgent = "cloudgpu-mcp/0.1" } = {}) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetch = fetchImpl;
    // 命令行工具和 MCP 服务器共用这个客户端，用 User-Agent 区分来源
    this.userAgent = userAgent;
  }

  // opts.idempotencyKey: sent as Idempotency-Key; such a POST is safe to retry because the server returns the
  //   same job for the same key instead of starting a second GPU.
  // opts.noAuth: endpoints used before there is a key (agent connect).
  async request(method, path, body, opts = {}) {
    if (!this.apiKey && !opts.noAuth) {
      throw new ApiError(
        401,
        "missing_api_key",
        "CLOUDGPU_API_KEY is not set. Create a key at https://cloudgpu.app/api and add it to this MCP server's env.",
      );
    }
    let lastErr;
    // Retry only on network errors and 502/503/504; never on 4xx. A POST is retried only when it carries an
    // Idempotency-Key, because only then can it not start a second GPU.
    const retryable = method === "GET" || Boolean(opts.idempotencyKey);
    const attempts = retryable ? 3 : 1;
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await this.fetch(this.baseUrl + path, {
          method,
          headers: {
            ...(this.apiKey && !opts.noAuth ? { Authorization: `Bearer ${this.apiKey}` } : {}),
            ...(opts.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey } : {}),
            "Content-Type": "application/json",
            "User-Agent": this.userAgent,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        let json;
        try {
          json = text ? JSON.parse(text) : {};
        } catch {
          json = null;
        }
        if (!res.ok) {
          const e = json && json.error ? json.error : {};
          const err = new ApiError(res.status, e.code || `http_${res.status}`, e.message || `HTTP ${res.status}`);
          if (retryable && res.status >= 502 && res.status <= 504 && i < attempts - 1) {
            lastErr = err;
            await sleep(1000 * (i + 1));
            continue;
          }
          throw err;
        }
        if (json === null) {
          throw new ApiError(res.status, "bad_response", "The server returned something that is not JSON.");
        }
        return json;
      } catch (err) {
        if (err instanceof ApiError) throw err;
        lastErr = new ApiError(0, "network_error", `Could not reach ${this.baseUrl}: ${err.message}`);
        if (i < attempts - 1) await sleep(1000 * (i + 1));
      }
    }
    throw lastErr;
  }

  account() {
    return this.request("GET", "/v1/gpu/account");
  }
  offers() {
    return this.request("GET", "/v1/gpu/offers").then((r) => r.data || []);
  }
  templates() {
    return this.request("GET", "/v1/gpu/templates").then((r) => r.data || []);
  }
  instances() {
    return this.request("GET", "/v1/gpu/instances").then((r) => r.data || []);
  }
  instance(id) {
    return this.request("GET", `/v1/gpu/instances/${encodeURIComponent(id)}`);
  }
  create(body) {
    return this.request("POST", "/v1/gpu/instances", body);
  }
  destroy(id) {
    return this.request("DELETE", `/v1/gpu/instances/${encodeURIComponent(id)}`);
  }
  models() {
    return this.request("GET", "/v1/models").then((r) => r.data || []);
  }
  catalog() { return this.request("GET", "/v1/public/gpu-catalog", undefined, { noAuth: !this.apiKey }); }
  quote(body) { return this.request("POST", "/v1/quotes", body, { noAuth: !this.apiKey }); }

  // ── jobs: start a GPU, run one command, destroy the GPU (server-side) ──
  createJob(body, idempotencyKey) {
    if (!idempotencyKey) throw new Error("createJob needs an idempotency key");
    return this.request("POST", "/v1/jobs", body, { idempotencyKey });
  }
  job(id) {
    return this.request("GET", `/v1/jobs/${encodeURIComponent(id)}`);
  }
  jobs(limit = 20) {
    return this.request("GET", `/v1/jobs?limit=${encodeURIComponent(limit)}`).then((r) => r.data || []);
  }
  jobLogs(id) {
    return this.request("GET", `/v1/jobs/${encodeURIComponent(id)}/logs`);
  }
  jobEvents(id) {
    return this.request("GET", `/v1/jobs/${encodeURIComponent(id)}/events`).then((r) => r.data || []);
  }
  cancelJob(id) {
    return this.request("POST", `/v1/jobs/${encodeURIComponent(id)}/cancel`, {});
  }

  // ── agent connect: get a key with a budget, approved by the account owner in the browser ──
  connectStart(body) {
    return this.request("POST", "/v1/agent/connect", body, { noAuth: true });
  }
  connectToken(deviceCode) {
    return this.request("POST", "/v1/agent/connect/token", { device_code: deviceCode }, { noAuth: true });
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
