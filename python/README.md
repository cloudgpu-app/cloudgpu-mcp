# CloudGPU Python SDK 0.1.0

A thin standard-library REST client for owner-approved Agent compute. The reviewed wheel and source distribution are published at https://github.com/cloudgpu-app/cloudgpu-mcp/releases/tag/python-v0.1.0. **It is not yet published on PyPI**: the owner must configure the pending Trusted Publisher. It creates no standing infrastructure and never automatically charges a payment method or retries a Job submission.

Install the released wheel with `python -m pip install https://github.com/cloudgpu-app/cloudgpu-mcp/releases/download/python-v0.1.0/cloudgpu-0.1.0-py3-none-any.whl`, or from a reviewed checkout with `pip install ./python`. Then run `cloudgpu check` without an account, or `cloudgpu connect --spend-limit 5`. Open the printed Google sign-in link, review/top up/approve in the browser; the key is stored privately, never printed. The limit is a cap, not a purchase. Run `cloudgpu connect --spend-limit 5 --hermes` to explicitly write the private local Hermes environment file as well. Both clients must use the same CloudGPU server origin. `--hermes` honors the official `HERMES_HOME` setting; when absent it uses `~/.hermes`. Existing private credentials in a different Hermes profile are not overwritten.

```python
from cloudgpu import CloudGPU
client = CloudGPU()
print(client.readiness())  # anonymous, no key sent
link = client.request_top_up(5)  # owner pays in browser; this does not pay
funding = client.wait_for_funds(1, timeout=60)
```

`connect_account` returns only human-safe links/code. `finish_connect` privately saves the credential, excluding it from its return value. Pending connection state survives process restarts. Only a verified top-up and sufficient live balance make `wait_for_funds` ready; browser payment return alone does not.

`quote`, `get_job` and `run_job` use the same REST contracts. `run_job` requires an exact quote, explicit `user_confirmed=True`, spending/time bounds and a stable idempotency key. Reconcile the existing Job after network uncertainty. Billing can be per minute or each started hour; a hosted API price label does not establish the billing period. Current async Job eligibility must be checked per source; an hourly rental is not automatically an eligible Job.

Optional adapters in `cloudgpu.frameworks` cover LangChain, OpenAI Agents SDK and CrewAI readiness, task fit, payment links, quotes, Job status and explicitly approved bounded Job submission. Their frameworks are not dependencies and must be installed separately. No adapter grants approval or retries paid work automatically. Compatibility acceptance passed with LangChain Core 1.8.0, OpenAI Agents SDK 0.24.0 and CrewAI 1.6.1: actual tool schemas/invocation, five read/link/quote operations, blocked unapproved Job submission and live anonymous HTTP readiness. These tests do not use an LLM or paid model. Other versions and actual paid Agent autonomy remain unverified.

Run `PYTHONPATH=python python -m unittest discover -s python/tests`. Package build: `python -m build python` with the standard build tool installed. Publishing requires an authorized PyPI publisher/trusted-publishing identity; do not put publisher credentials in a PR or chat.

For the account owner configuring a pending PyPI Trusted Publisher: project `cloudgpu`, GitHub owner `cloudgpu-app`, repository `cloudgpu-mcp`, workflow `publish-python.yml`, environment `pypi`. The candidate workflow publishes only the reviewed `main` version when explicitly dispatched, uses OIDC and does not require sharing a password or API token. Creating this workflow is not proof of a configured publisher or a completed PyPI release.

Reproduce optional framework acceptance: `python -m pip install -r python/requirements-framework-acceptance.txt`, then `python python/integration/framework_acceptance.py`. The three upstream packages add substantial dependencies; they are not installed by the base SDK or default CI.
