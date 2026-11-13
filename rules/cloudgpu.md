# CloudGPU rules for AI assistants

Use these rules whenever you rent or use a GPU on CloudGPU (cloudgpu.app) through the `cloudgpu` MCP tools.
Copy this file into your project as `AGENTS.md`, `.cursor/rules/cloudgpu.md` or `.clinerules/cloudgpu.md`, or wherever your assistant reads project instructions.

## Before renting

1. Call `get_account` and `list_gpus`. Pick a GPU with enough VRAM for the job, and don't rent more GPU than the job needs. As a rough guide, LoRA on a 7–8B model fits in 24 GB, and a full fine-tune of the same model needs 80 GB or more.
2. Check `list_instances` for an existing approved running rental. If a new rental is needed, optionally use `compare_compute_costs` for up to eight compatible GPUs, then call `estimate_cost` with a realistic duration including preparation, model downloads and result collection. A comparison is not a creation quote or benchmark.
3. Show the user a short quote before you rent anything:
   - the GPU and how many,
   - the price per hour,
   - the billing increment and minimum charge (some sources charge a minimum one hour and each started hour in full),
   - the estimated hours and cost,
   - the budget and time limit you will set,
   - their balance after the job.
4. Rent only after the user says yes. Pass `user_confirmed=true` only in that case.

## Renting

- Always set `max_spend_usd` and `max_hours`. CloudGPU's servers destroy the instance when either is reached, even if you have disconnected.
- Keep `idle_minutes` on (default 60). Raise it if setup will take long, because installing packages and downloading models leave the GPU idle.
- Call `get_status` at intervals, not in a tight loop, until the instance is `running`.
- `failed` instances are not charged. Tell the user, then offer another GPU.

## Working on the instance

- Put code and data on the instance with `upload`. Do not upload credentials.
- Use `run_command` for short steps. For training, long installs or big downloads, use `background=true` and follow progress with `tail_logs`.
- Instances come with Python and CUDA, but not always PyTorch. Check first: `nvidia-smi -L` and `python -c "import torch; print(torch.__version__, torch.cuda.is_available())"`.
- If PyTorch is missing, plain `pip install torch` installs a current CUDA build. It is a few GB, so run it with `background=true`. Index URLs for older CUDA versions (for example `.../whl/cu124`) may have no wheel for the machine's Python, which can be as new as 3.14. Only use them if the project needs that CUDA version, and then create an environment with an older Python first (`conda create -y -n work python=3.12`, then `conda activate work && ...` in each command).
- If `nvidia-smi` shows no GPU once the instance is running, stop and tell the user. CloudGPU detects such machines, shuts them down and refunds them automatically.
- **Do not** change the root password, edit the SSH configuration, change the firewall, or stop the platform's monitoring agent (`cgpu-*` processes). The platform must keep its access to the instance; if that access is lost, the platform shuts the instance down. The MCP server refuses such commands.
- Never use the GPU for cryptocurrency mining or anything the [acceptable use policy](https://cloudgpu.app/aup) forbids. Instances that do so are shut down.

## Jobs: one command, start to finish on CloudGPU

For a batch task that is one command (a training script, a render, a batch of inference), `run_job` is simpler than renting an instance: CloudGPU starts the GPU, runs the command, and destroys the GPU when it finishes, even if you disconnect.

- Get the user's yes on the GPU, the budget and the time limit first, as for renting.
- The GPU's disk is erased when the job ends. When automatic output collection is available, declare explicit outputs under `$CLOUDGPU_OUTPUT_DIR` and inspect collection status and ready file IDs. Otherwise save results explicitly before release. Never print credentials or assume a rental billing quote proves Job/template compatibility. `get_job` returns the last ~4 KB of output.
- If `run_job` times out or the connection drops, call it again with the same `idempotency_key`. You get the same job back; a second GPU is not started.
- Check progress with `get_job` every minute or so. `needs_attention` means CloudGPU stopped the job to check something by hand; tell the user and do not resubmit it.

## No API key?

Call `connect_account` with a name for yourself and the spending limit the user wants. Show the user the link; they sign in and approve. Then call `finish_connect`. The key is saved on this computer and never shown in the chat. The user can revoke it at https://cloudgpu.app/api.

## Finishing (always)

1. Download every result: model weights, adapters, checkpoints, logs, metrics. Destroying an instance erases its disk. Files explicitly uploaded to Workspace persist under its quota and retention policy; an instance disk is not automatically backed up. Confirm uploads completed and files are ready before release. Storage charges are separate from the GPU budget.
2. Call `stop_instance`.
3. Tell the user what ran, where the results are on their computer, and the final cost from `stop_instance`.

If anything goes wrong mid-way, do not leave the instance running. Download whatever exists, stop the instance, then explain what happened.

## Only need a model, not a GPU?

The same API key works for CloudGPU's OpenAI-compatible model API at `https://cloudgpu.app/v1`. Call `list_models` to see the models. If you only need inference on a hosted model, use the API instead of renting a GPU.

## Multi-Job batches

Use prepare_job_batch to review all tasks and the sum of their GPU budget caps before any submission. Storage charges are separate. run_job_batch requires explicit approval and the exact plan hash. Preserve the full approved manifest, stable batch key and receipt. A partial or unknown submission never permits a replacement key: replay the identical manifest to recover original Jobs. Never automatically retry failed execution or create a replacement GPU while release is uncertain. Batch preparation is not a reservation, and accepted Jobs are independent, not an atomic transaction. Unsubmitted members do not survive a client exit.

Application recipes reuse prepared environments. ComfyUI protocol fixtures and LoRA orchestration fixtures are not real GPU or model-quality acceptance. No image/SDXL LoRA recipe is supplied. Never tell a user a template is production-validated based on these fixtures, or ask for credentials in workflow files.

## Reuse a GPU across tasks

A running rental can execute multiple approved commands sequentially using its instance ID and `run_command`; check status, ownership, available memory/disk and remaining original budget/deadline first. Do not use another team or personal account's resource. This does not extend its existing limits. Separate `run_job` calls and `prepare_job_rerun` do not reuse that rental. Persist results, stop when finished and reconcile release; do not retain idle GPUs just because an hour was charged. Crossing the next started hour incurs a further full-hour charge. No warm pool is promised.
