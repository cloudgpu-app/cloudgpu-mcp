import test from "node:test";
import assert from "node:assert/strict";
import { checkCommand, sensitiveReason, redact, publicInstance, Quotes } from "../src/guards.js";

test("blocks commands that would lock the platform out", () => {
  for (const c of ["passwd root", "echo 'root:x' | chpasswd", "sed -i 's/yes/no/' /etc/ssh/sshd_config",
    "systemctl stop sshd", "pkill -f cgpu-watchdog", "kill -9 -1", "iptables -F", "pkill -9 bash"]) {
    assert.ok(checkCommand(c), c);
  }
  for (const c of ["python train.py", "pip install torch", "nvidia-smi", "kill 1234", "pkill -f train.py", "ls ~/.ssh"]) {
    assert.equal(checkCommand(c), null, c);
  }
});

test("refuses credential uploads by default", () => {
  assert.ok(sensitiveReason("~/.ssh/id_ed25519"));
  assert.ok(sensitiveReason("./.env"));
  assert.ok(sensitiveReason("~"));
  assert.equal(sensitiveReason("./data/train.jsonl"), null);
});

test("redacts secrets and hides ssh details", () => {
  assert.equal(redact("pw example-password at 1.2.3.4 key sk-" + "x".repeat(20), ["example-password", "1.2.3.4"]),
    "pw [redacted] at [redacted] key sk-[redacted]");
  const p = publicInstance({ id: "1", status: "running", ssh: { host: "1.2.3.4", port: 22, user: "root", password: "x" } });
  assert.equal(p.ssh, undefined);
  assert.equal(p.ssh_ready, true);
  assert.ok(!JSON.stringify(p).includes("1.2.3.4"));
});

test("quotes are single use and expire", () => {
  const q = new Quotes(50);
  const id = q.put({ gpu_model: "RTX 4090" });
  assert.ok(q.take(id).quote);
  assert.ok(q.take(id).error);
});
