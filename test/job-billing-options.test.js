import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('stdio compares Job billing periods and carries only the selected approved quote', async () => {
  const requests = [];
  const billingId = '00000000-0000-4000-8000-000000000000';
  const fixture = createServer(async (request, response) => {
    const parts = [];
    for await (const part of request) parts.push(part);
    const body = JSON.parse(Buffer.concat(parts).toString());
    requests.push({ path: request.url, body });
    const replies = {
      '/v1/quotes': { id: 'quote_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', job_billing_options: [
        { billing_increment_seconds: 60, estimated_total_cost: 0.585 },
        { billing_increment_seconds: 3600, estimated_total_cost: 0.78 },
      ] },
      '/v1/gpu/billing-quote': { billingQuoteId: billingId, incrementSeconds: 3600 },
      '/v1/jobs': { id: 'fixture-job-only', status: 'queued' },
    };
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(replies[request.url] ?? {}));
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['src/index.js'],
    env: { ...process.env, CLOUDGPU_API_KEY: 'synthetic-fixture-only', CLOUDGPU_READ_ONLY: '0',
      CLOUDGPU_BASE_URL: `http://127.0.0.1:${fixture.address().port}` },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'job-billing-fixture', version: '1' });
  try {
    await client.connect(transport);
    const estimate = await client.callTool({ name: 'quote_compute', arguments: {
      gpu_model: 'RTX 4090', estimated_duration_seconds: 5400, max_budget_usd: 1,
    } });
    assert.equal(estimate.isError, undefined, estimate.content[0].text);
    assert.deepEqual(JSON.parse(estimate.content[0].text).job_billing_options.map(x => x.billing_increment_seconds), [60, 3600]);
    assert.equal(requests[0].body.include_job_billing_options, true);

    const quote = await client.callTool({ name: 'quote_job_billing', arguments: {
      gpu_model: 'RTX 4090', billing_increment_seconds: 3600,
    } });
    assert.equal(JSON.parse(quote.content[0].text).billing_quote_id, billingId);
    assert.equal(requests[1].body.jobBillingQuote, true);
    assert.equal(requests[1].body.billingIncrementSeconds, 3600);

    const args = { command: 'echo fixture', gpu_model: 'RTX 4090', billing_quote_id: billingId,
      max_spend_usd: 1, max_hours: 1.5, user_confirmed: true, idempotency_key: 'fixture-job' };
    const unapproved = await client.callTool({ name: 'run_job', arguments: args });
    assert.equal(unapproved.isError, true);
    assert.equal(requests.length, 2);
    const approved = await client.callTool({ name: 'run_job', arguments: { ...args, billing_accepted: true } });
    assert.equal(JSON.parse(approved.content[0].text).id, 'fixture-job-only');
    assert.equal(requests[2].path, '/v1/jobs');
    assert.equal(requests[2].body.billing_quote_id, billingId);
    assert.equal(requests[2].body.billing_accepted, true);
    assert.equal(requests[2].body.quote_id, undefined);
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    await new Promise(resolve => fixture.close(resolve));
  }
});
