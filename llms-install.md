# Installing CloudGPU MCP (instructions for AI agents such as Cline)

CloudGPU MCP is a local (stdio) MCP server for https://cloudgpu.app. It needs Node.js 18 or newer and a CloudGPU API key. No build step and no clone are needed: run it with `npx`.

## 1. Get an API key

Ask the user to create an API key at https://cloudgpu.app/api (it starts with `cgw-sk-`) and to add a prepaid balance (card or USDT). Do not invent or guess a key. If the user has not given you one yet, stop and ask for it. Never print the key back in the chat.

## 2. Add the server to the MCP settings

Add this to the MCP settings file (for Cline: `cline_mcp_settings.json`), with the key the user gave you in `CLOUDGPU_API_KEY`:

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
- The full usage rules are in [rules/cloudgpu.md](rules/cloudgpu.md). The server also exposes them as the resource `cloudgpu://rules`.

More: [README.md](README.md) and https://cloudgpu.app/docs/mcp
