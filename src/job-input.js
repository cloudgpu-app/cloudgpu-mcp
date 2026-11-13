// 单个与批量提交共用同一字段校验，不能为批量削弱原有门禁。
import {z} from "zod";
export function jobInputShape(cfg){return {
        command: z.string().min(1).max(32768).describe("bash command or script to run on the GPU"),
        gpu_model: z.string().optional().describe("GPU model exactly as list_gpus returns it"),
        template: z.string().optional().describe("Template id from list_templates"),
        gpu_count: z.number().int().min(1).max(8).default(1),
        disk_gb: z.number().int().optional().describe("Larger system disk: 100, 200 or 500; omit for the standard disk"),
        workspace_version_id: z.string().optional().describe("Immutable Workspace version to restore before the command; requires enabled persistent storage"),
        model_references: z.array(z.object({name:z.string(),repo_id:z.string(),revision:z.string().regex(/^[0-9a-f]{40}$/),files:z.array(z.object({path:z.string(),size_bytes:z.number().int().positive(),sha256:z.string().regex(/^[0-9a-f]{64}$/).optional()})).min(1).max(32)})).max(4).optional().describe("Pinned public model references from resolve_model_reference. Downloads into $CLOUDGPU_MODEL_DIR/<name> before the command; download time consumes the same GPU budget. No R2 cache or remote repository code execution."),
        outputs: z.object({
          files: z.array(z.string().min(1).max(512)).min(1).max(16),
          max_bytes: z.number().int().min(1).max(104857600).optional(),
          accept_storage_charges: z.boolean().optional(),
        }).strict().optional().describe("Explicit relative output files under $CLOUDGPU_OUTPUT_DIR; no globs, symlinks, hidden or credential files. Default total limit 10 MiB, maximum 100 MiB. Only set accept_storage_charges=true after the user agrees to existing paid storage terms. Inspect output_collection after completion; the GPU is released even if saving fails."),
        quote_id: z.string().optional().describe("Server quote from quote_compute, starting quote_; binds configuration and checks price at submission"),
        billing_quote_id: z.string().regex(/^[a-f0-9-]{36}$/).optional().describe("Accepted source-specific billing quote from estimate_cost; expires after five minutes. Required for whole-hour sources."),
        billing_accepted: z.boolean().optional().describe("true only after the user accepts the quoted minimum and billing period; budget must cover that minimum"),
        max_spend_usd: z.number().positive().describe(`Budget for this job in USD (at most ${cfg.maxSpend})`),
        max_hours: z.number().positive().describe(`Hard time limit in hours (at most ${cfg.maxHours})`),
        user_confirmed: z.boolean().describe("true only if the user explicitly approved the GPU, budget and time limit"),
        idempotency_key: z.string().max(128).optional().describe("Reuse the same value when retrying the same job"),
};}
