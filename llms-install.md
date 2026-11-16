# Installing CloudGPU MCP (instructions for AI agents such as Cline)

CloudGPU MCP is a local (stdio) MCP server for https://cloudgpu.app. It needs Node.js 18 or newer. Discovery works without a key; paid execution requires an owner-approved account. No build step and no clone are needed: run it with `npx`.

## 1. Discover first, then connect

No account is needed for `get_agent_readiness` or `list_regional_offers`. Use the
human owner's country explicitly when useful, never the Agent server IP. These
observations are planning facts, not reservations or exact-region execution.

For paid work, call `connect_account`, show the returned approval link to the
owner, then call `finish_connect`. The owner signs in, approves spending and can
top up; never ask them to paste a key into chat. An existing key may instead be
provided securely through `CLOUDGPU_API_KEY`. Never print it.

## 2. Add the server to the MCP settings

Add this to the MCP settings file (for Cline: `cline_mcp_settings.json`), with a securely configured existing key in `CLOUDGPU_API_KEY` if available (omit the env block for anonymous discovery or connect-link authorization):

```json
{
  "mcpServers": {
    "cloudgpu": {
      "command": "npx",
      "args": ["-y", "cloudgpu-mcp"],
      "env": {
        "CLOUDGPU_API_KEY": "<YOUR_API_KEY>"
      }
    }
  }
}
```

Optional safety caps (add to `env`): `CLOUDGPU_MAX_SPEND_USD` (highest budget the agent may set for one instance), `CLOUDGPU_MAX_HOURS` (longest time limit), and `CLOUDGPU_READ_ONLY=1` (look-up tools only, nothing can be rented).

## 3. Check that it works (this rents nothing)

Ask the agent: "List the GPUs available, then estimate the cost for a 24 GB GPU for one hour. Do not create anything."

You should see `list_gpus` and `estimate_cost` tool calls and a quote. If you see an authentication error, the key is wrong or missing.

## 4. Rules for using it

- Always show the user the quote from `estimate_cost` and wait for a clear yes before `create_instance` (pass `user_confirmed=true` only after that).
- Always set `max_spend_usd` and `max_hours` when creating an instance.
- Download the results before `stop_instance`, and stop the instance when the job is done.
- Review source-specific minimums and increments: minute billing and started-hour billing can both apply. A price per hour does not identify the billing period.
- A hard location requirement cannot use an ordinary quote as a substitute; check current capabilities before allocating.
- The full usage rules are in [rules/cloudgpu.md](rules/cloudgpu.md). The server also exposes them as the resource `cloudgpu://rules`.

More: [README.md](README.md) and https://cloudgpu.app/docs/mcp
