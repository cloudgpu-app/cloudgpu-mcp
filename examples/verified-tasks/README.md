# Reproducible bounded GPU cases

Real internal acceptance, including model loading, execution, output download/SHA-256 and upstream release checks. Fees are observed final wallet charges, not future price guarantees.

| Case | Final run elapsed | Final GPU fee | Full development deliveries / submissions |
|---|---:|---:|---:|
| NVIDIA GPU environment check, RTX 3090 | 191 s | $0.0048 | 1 / 1 |
| Synthetic causal-LM LoRA, SmolLM2-135M, 8 steps, RTX 3090 | 190 s | $0.0097 | 1 / 4 |
| Wan2.1 1.3B ComfyUI video, 256×256, 17 frames, 8 steps, RTX 4090 | 1,064 s | $0.1105 | 1 / 12 |

These development submissions used evolving preparation and harness code. They include cancellations, unavailable stock, networking, dtype, encoder and output-transport failures. They are a small internal sample, not a commercial SLA or model-quality benchmark. The final video spent 874.102 s downloading/checking models and 18.776703 s starting ComfyUI, generating and encoding; remaining time includes provisioning and collection/release. Its MP4 was independently decoded as 17 H.264 frames. LoRA is a real nonzero trained adapter on four synthetic text records; it is not image/diffusion LoRA.

All 20 submitted acceptance Jobs are terminal; 19 allocated instances were independently confirmed released. One out-of-stock submission had no instance ID. GPU wallet fees including every failed/cancelled attempt and three separate output transport probes total **$0.9552 / $10 approved**. Storage reserve/settlement and provider invoices are separate. See [evidence.json](evidence.json) and live https://cloudgpu.app/agent-evidence.json.

## Run

From the repository root after `npm ci`, preview a bundled case locally:

```sh
node examples/verified-tasks/run.mjs gpu-environment
node examples/verified-tasks/run.mjs causal-lora
node examples/verified-tasks/run.mjs comfy-wan-video
```

Review the scripts, live readiness/quote and spending/time ceilings. With your owner-approved connected credentials (or CLOUDGPU_API_KEY in your private environment), submit one case:

```sh
CGPU_SUBMIT=YES CGPU_JOB_KEY=my-new-reviewed-case-1 node examples/verified-tasks/run.mjs gpu-environment
```

The runner prints the accepted Job ID immediately, waits for terminal/final cost, downloads only the requested ready outputs and verifies SHA-256. Files stay in a private `cloudgpu-results/<job_id>` directory; `CGPU_RESULTS_DIR` selects another private directory. It does not delete your persistent outputs.

Resume a known accepted Job without another quote or GPU:

```sh
CGPU_SUBMIT=YES CGPU_JOB_ID=job_<your-existing-id> node examples/verified-tasks/run.mjs gpu-environment
```

An uncertain initial submission must be reconciled with the original request/idempotency key; do not invent a replacement key or rerun blindly. Changing a case or beginning another task requires a new quote and approval. The final video runner's real resume/download path was also exercised against the accepted video Job.

## Limits and prerequisites

- Caps in `cases.json` are spending ceilings, not predicted charges. Quote current stock, image, disk and all preparation/download/output time. Hourly suppliers can require 3,600-second minimums; use only candidates with actual Job support and appropriate billing approval.
- Video requires a compatible existing ComfyUI image. The reviewed `flux-1-dev` image supplied ComfyUI for this specific test; this does not make arbitrary images compatible. No custom nodes are installed. ModelScope revisions and all model SHA-256 values are pinned. A pinned imageio-ffmpeg wheel supplies an encoder when absent; its mirror bytes must match the official wheel and binary hashes.
- Automatic model preparation remains bounded to 600 seconds. This example explicitly downloads large models in a separately reviewed bounded command (45-minute download / 60-minute Job ceiling); it does not silently extend the platform loader.
- Explicit automatic Job outputs are at most 100 MiB. On GPUs without direct object-storage connectivity, the verified control-plane fallback handles at most 8 MiB total, one relay at a time, using existing reservations and checksum checks. It does not relay authorization/validation denials. Larger outputs require verified direct connectivity or an approved export plan.
- These examples accept no new paid-storage charges; ensure existing quota before starting. Workspace/file capacity and paid storage budgets are separately reported by `/v1/storage`. Model weights go directly to the rented GPU, not into a CloudGPU model cache.
- GPU disk is erased on release. Inspect `output_collection`, final cost and release state. Commercial success rates and provider health are separately reported by the live readiness/evidence endpoints; unknown values remain unknown.
