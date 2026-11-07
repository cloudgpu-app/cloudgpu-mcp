# CloudGPU MCP

[CloudGPU](https://cloudgpu.app) MCP server: let an AI agent rent a GPU by the minute, run a job, bring the results back and shut the GPU down. The same API key and balance also cover CloudGPU's OpenAI-compatible model API, so an agent can call a hosted model without renting anything.

> "Fine-tune a 7B base model with LoRA on data/train.jsonl and put the adapter in ./outputs."

The agent checks live prices and quotes you, rents the GPU once you say yes, uploads your code and data, starts training in the background, watches the logs, downloads the adapter and destroys the instance. You get the files and the final cost.

It is a local (stdio) MCP server. It works with any MCP client that can start one: Claude Code, Cursor, Cline, opencode, goose, VS Code, Windsurf and others.

## Install

1. Create an API key at [cloudgpu.app/api](https://cloudgpu.app/api) and add a prepaid balance (card or USDT).
2. Add the server to your client. Node.js 18 or newer is required. The key goes in the environment variable `CLOUDGPU_API_KEY`.

<details open>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add cloudgpu --env CLOUDGPU_API_KEY=cgw-sk-... -- npx -y cloudgpu-mcp
```
</details>

<details>
<summary><b>Cursor</b> (<code>~/.cursor/mcp.json</code> or <code>.cursor/mcp.json</code>)</summary>

```json
{
  "mcpServers": {
    "cloudgpu": {
      "command": "npx",
      "args": ["-y", "cloudgpu-mcp"],
      "env": { "CLOUDGPU_API_KEY": "cgw-sk-..." }
    }
  }
}
```
</details>

<details>
<summary><b>Cline</b> (MCP Servers → Configure MCP Servers → <code>cline_mcp_settings.json</code>)</summary>

```json
{
  "mcpServers": {
    "cloudgpu": {
      "command": "npx",
      "args": ["-y", "cloudgpu-mcp"],
      "env": { "CLOUDGPU_API_KEY": "cgw-sk-..." }
    }
  }
}
```
</details>

<details>
<summary><b>opencode</b> (<code>opencode.json</code>)</summary>

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "cloudgpu": {
      "type": "local",
      "command": ["npx", "-y", "cloudgpu-mcp"],
      "environment": { "CLOUDGPU_API_KEY": "cgw-sk-..." },
      "enabled": true
    }
  }
}
```
</details>

<details>
<summary><b>goose</b> (<code>~/.config/goose/config.yaml</code>, or <code>goose configure</code> → Add Extension → Command-line Extension)</summary>

```yaml
extensions:
  cloudgpu:
    name: cloudgpu
    type: stdio
    cmd: npx
    args: ["-y", "cloudgpu-mcp"]
    envs:
      CLOUDGPU_API_KEY: "cgw-sk-..."
    enabled: true
    timeout: 300
```
</details>

3. Optional but recommended: copy [`rules/cloudgpu.md`](rules/cloudgpu.md) into your project as `AGENTS.md`, `.cursor/rules/cloudgpu.md` or `.clinerules/cloudgpu.md`. It tells the agent to quote before renting, download before shutting down, and never leave a GPU running. The server also exposes the same text as the resource `cloudgpu://rules`.

To check the install, ask your agent: "List the GPUs available, then estimate the cost for a 24 GB GPU for one hour. Do not create anything." You should see `list_gpus` and `estimate_cost` calls and a quote, and nothing is rented.

## Agent Skill

The same guidance is available as two [Agent Skills](https://agentskills.io):

- [`skills/cloudgpu/SKILL.md`](skills/cloudgpu/SKILL.md): renting and using a GPU. Claude Code loads it on demand when you ask for a GPU job. It expects the `cloudgpu` MCP tools to be installed (see above).
- [`skills/cloudgpu-model-api/SKILL.md`](skills/cloudgpu-model-api/SKILL.md): calling the OpenAI-compatible model API at `https://cloudgpu.app/v1` without renting a GPU. It works with the MCP tools or with just a `CLOUDGPU_API_KEY`.

- **Claude plugin:** both skills are included automatically when you install the CloudGPU Claude plugin from this repo's marketplace:

  ```
  /plugin marketplace add mrhy7176/cloudgpu-mcp
  /plugin install cloudgpu@cloudgpu
  ```

- **Claude Code, personal install:** copy `skills/cloudgpu/` and `skills/cloudgpu-model-api/` to `~/.claude/skills/`.
- **Claude Code, project install:** copy `skills/cloudgpu/` and `skills/cloudgpu-model-api/` to `.claude/skills/` in your project.
- **Cursor, Codex, Cline, Amp and other agents that read Agent Skills:** install both skills with the [skills CLI](https://skills.sh):

  ```
  npx skills add mrhy7176/cloudgpu-mcp
  ```

## Tools

| Tool | What it does |
|---|---|
| `get_account` | Balance, and how many instances the account may run at once |
| `list_gpus` | GPU models with VRAM, live price per GPU-hour and availability |
| `list_templates` | Ready-made images: JupyterLab, Ollama, ComfyUI, LLaMA-Factory, … |
| `estimate_cost` | Live quote for a GPU and a number of hours, plus your balance afterwards; returns a `quote_id` |
| `create_instance` | Rents from an approved quote, with a budget, a time limit and an idle limit |
| `get_status` / `list_instances` | Status, minutes run, cost so far, auto-shutdown limits |
| `run_command` | Runs a command on the instance; `background=true` for long jobs |
| `tail_logs` | Latest log lines, whether the job finished, GPU utilisation |
| `upload` / `download` | Files and folders between your computer and the instance (SFTP) |
| `stop_instance` | Destroys the instance and stops billing |
| `list_models` | Models on the OpenAI-compatible API, for inference without renting a GPU |
| `run_job` | Starts a GPU, runs one command and destroys the GPU, all on CloudGPU's servers; safe to retry with the same `idempotency_key` |
| `get_job` / `list_jobs` | Job status, exit code, cost, the last ~4 KB of output and the job's history |
| `cancel_job` | Stops a job and destroys its GPU |
| `connect_account` / `finish_connect` | Gets a key without copying one: the user approves this assistant in the browser with a spending limit and a number of GPUs at once |

The server also provides a `train_on_cloudgpu` prompt.

## Guardrails

- **A quote first.** `create_instance` only takes a `quote_id` from `estimate_cost` and `user_confirmed=true`.
- **Server-side limits.** Every instance is created with `max_spend_usd`, `max_hours` and an idle limit (60 minutes by default). CloudGPU's servers check them and destroy the instance when one is hit, even if your client has disconnected or your laptop is asleep.
- **Your own ceiling.** `CLOUDGPU_MAX_SPEND_USD` and `CLOUDGPU_MAX_HOURS` cap what the agent may set.
- **Results before shutdown.** After commands have run, `stop_instance` refuses until something has been downloaded, unless the user confirms `force=true`.
- **Secrets stay out of the chat.** The instance's SSH login is used inside this process and never returned to the model. Tool output is scrubbed of the API key and login details. Uploading `.ssh`, `.env`, key files or your whole home directory needs `allow_sensitive=true`.
- **The instance stays manageable.** Commands that change the root password, SSH configuration, firewall or the platform's monitoring agent are refused. CloudGPU shuts down instances that it can no longer monitor.
- **Jobs are not started twice.** `run_job` sends an `Idempotency-Key`. Resending the same job returns the same job instead of starting a second GPU, and the server refuses the same key with different parameters.
- **Keys with a budget.** A key from `connect_account` has a total spending limit, a number of GPUs it may run at once and an expiry date, all enforced by CloudGPU's servers. Revoke it at https://cloudgpu.app/api and it can no longer start anything.
- **Read-only mode.** `CLOUDGPU_READ_ONLY=1` registers only the look-up tools.

## Configuration

| Env | Default | |
|---|---|---|
| `CLOUDGPU_API_KEY` | (or `connect_account`) | From https://cloudgpu.app/api. Without it, a key saved by `finish_connect` in `~/.config/cloudgpu/credentials.json` is used |
| `CLOUDGPU_MAX_SPEND_USD` | `50` | Highest budget the agent may set for one instance |
| `CLOUDGPU_MAX_HOURS` | `24` | Longest time limit the agent may set |
| `CLOUDGPU_READ_ONLY` | off | `1` = look-up tools only |
| `CLOUDGPU_BASE_URL` | `https://cloudgpu.app` | Override the API host |

## Model API on the same balance

The key also works with the OpenAI-compatible API at `https://cloudgpu.app/v1`. Call `list_models` (or `GET /v1/models`) to see the available model IDs. Model prices are on [cloudgpu.app/api](https://cloudgpu.app/api).

## Optional persistent files and Workspaces (development)

These tools require persistent storage to be explicitly enabled on the server;
they return `storage_not_enabled` until it is ready. Discover server capabilities
at `/v1/public/compute-capabilities`. No free quota or retention period is promised.

- `get_compute_catalog` and `quote_compute` use public discovery and server quotes,
  including required starting balance and `supports_jobs`. Pass the server quote to
  `run_job` as `quote_id`; the original `estimate_cost` remains a local quote for
  interactive instance rentals.
- `get_storage`, `list_files`, `list_workspaces`, `list_workspace_versions` and
  `get_workspace_version` show saved files, versions and usage.
- `upload_artifact` and `download_artifact` transfer persistent files, including
  datasets/models, without returning storage credentials to the assistant.
- `save_workspace` saves regular project files as an immutable version. It refuses
  known credential paths and symlinks, and skips `.git`, `node_modules`,
  `__pycache__` and `.venv`. Save dependency manifests so the next GPU can rebuild
  its environment. The returned `workspace_version_id` can be passed to `run_job`.
- `delete_file` and `delete_workspace_version` require explicit user confirmation
  and refuse active references.

This restores project files into a fresh directory before the Job command. It is
not full-disk restore and does not automatically save edits or collect outputs.
Continue saving results from the command itself. Large-model restore speed and
cross-supplier cache behavior must be measured before relying on them. Backend restore plans travel via SSH stdin, never in
Job command arguments or saved scripts; the user command starts after restoration.
This does not protect transfer-time memory from root on the GPU. Failed deletions
or expired uploads may remain pending while the server verifies cleanup; quota is
released only after confirmed removal. With storage disabled, normal catalog,
account, instance and Job tools keep working without a storage provider.


The developer acceptance script `node scripts/acceptance.mjs` is read-only by
default. Its `--paid` mode is for an explicitly authorized internal test account
only; it can create two Jobs capped at $0.03 each. Do not run paid mode as part of
ordinary package tests.

## Without MCP

The server wraps CloudGPU's public REST API, which any agent or script can call with the same key:

```bash
curl https://cloudgpu.app/v1/gpu/offers -H "Authorization: Bearer $CLOUDGPU_API_KEY"
```

## Command-line tool

The package also installs a `cloudgpu` command for using the same API from a terminal (Node.js 18.3 or newer, no extra dependencies):

```bash
npm install -g cloudgpu-mcp      # or run it once with: npx -p cloudgpu-mcp cloudgpu --help
cloudgpu login                   # saves your key to ~/.config/cloudgpu/config.json (mode 0600)
cloudgpu offers                  # GPU models with live price and availability
cloudgpu up --gpu "RTX 4090" --template comfyui --max-minutes 120 --max-spend 5 --wait
cloudgpu ssh <id>                # opens your system ssh to the instance
cloudgpu down <id>               # destroys it and stops billing (asks first; --yes to skip)
```

| Command | What it does |
|---|---|
| `login` | Save an API key (input hidden, or piped on stdin); checked against the API first |
| `offers [--template ID]` | GPU models, VRAM, live price per GPU-hour, availability |
| `templates` | Ready-made images and the GPU each recommends |
| `up --gpu MODEL [--template ID] [--count N] [--max-minutes N] [--max-spend USD] [--idle-minutes N] [--setup FILE] [--wait]` | Rent an instance; `--setup` runs a bash script once as root after hand-over (log in `/root/cloudgpu-setup.log`); `--wait` polls until it is running or failed, then prints the SSH command and URL |
| `ls` / `status <id>` | Instances with status, minutes run and cost so far |
| `ssh <id> [-- ARGS]` | Run `ssh` with the instance's host, port and user; `--show-password` prints the password if there is one |
| `down <id> [--yes]` | Destroy the instance; its disk is erased, so download results first |
| `balance` | Balance and how many instances the account may run |

`CLOUDGPU_API_KEY` takes precedence over the saved key, and `CLOUDGPU_BASE_URL` overrides the API host. Read commands accept `--json`; SSH passwords are left out of JSON unless you pass `--show-password`. Every command has `--help`. Errors print the API's message and exit non-zero (2 for usage errors).

## Links

- MCP docs: https://cloudgpu.app/docs/mcp
- GPU pricing: https://cloudgpu.app/pricing
- Model API and prices: https://cloudgpu.app/api
- API reference: https://cloudgpu.app/api/docs · OpenAPI: https://cloudgpu.app/openapi.json · For LLMs: https://cloudgpu.app/llms.txt

CloudGPU here means cloudgpu.app. Prepaid balance, billed per minute; when the balance runs out, running instances are destroyed and their disks erased, so keep enough balance for the job and download results as you go.

## Development

```bash
npm install
npm test
node src/index.js   # stdio server; set CLOUDGPU_API_KEY first
node src/cli.js --help
```

## License

MIT, see [LICENSE](LICENSE).
