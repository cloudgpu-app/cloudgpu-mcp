import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("MCP offers a Workspace rental only with a server-bound billing quote", async () => {
  const quotes = [];
  const creates = [];
  let workspaceAware = false;
  const server = http.createServer(async (request, response) => {
    const reply = (body) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(body));
    };
    const readBody = async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      return JSON.parse(Buffer.concat(chunks).toString());
    };
    switch (request.url) {
      case "/v1/gpu/offers":
        return reply({ data: [{ gpu_model: "RTX 4090", available: "yes" }] });
      case "/v1/gpu/account":
        return reply({ balance_usd: 10 });
      case "/v1/gpu/billing-quote":
        quotes.push(await readBody());
        return reply({
          billingQuoteId: "server-workspace-quote", expiresAt: Date.now() + 60000, currency: "USD",
          hourlyTotalUsd: 0.6, minimumChargeUsd: 0.01, preauthorizedUsd: 0.6,
          incrementSeconds: 60, minimumSeconds: 60,
          ...(workspaceAware ? { workspaceRestoreRequired: true } : {}),
        });
      case "/v1/gpu/instances":
        creates.push(await readBody());
        return reply({ id: "synthetic-instance", status: "creating" });
      default:
        response.writeHead(404).end();
    }
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/index.js"],
    env: {
      ...process.env,
      CLOUDGPU_READ_ONLY: "0",
      CLOUDGPU_API_KEY: "synthetic-key",
      CLOUDGPU_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    },
  });
  const client = new Client({ name: "workspace-rental-test", version: "1" });
  const call = (name, args) => client.callTool({ name, arguments: args });
  const requirements = { gpu_model: "RTX 4090", hours: 1, workspace_restore_required: true };
  try {
    await client.connect(transport);
    const legacy = await call("estimate_cost", requirements);
    assert.equal(legacy.isError, true);
    assert.match(legacy.content[0].text, /workspace_route_unavailable/);
    assert.equal(creates.length, 0);
    workspaceAware = true;
    const result = await call("estimate_cost", requirements);
    assert.ok(!result.isError, result.content[0].text);
    const quote = JSON.parse(result.content[0].text);
    assert.equal(quote.workspace_restore_required, true);
    assert.equal(quotes.length, 2);
    for (const request of quotes) assert.equal(request.workspaceRestoreRequired, true);
    const create = await call("create_instance", {
      quote_id: quote.quote_id, user_confirmed: true, max_spend_usd: 1, max_hours: 1,
    });
    assert.ok(!create.isError, create.content[0].text);
    assert.equal(creates.length, 1);
    assert.equal(creates[0].billing_quote_id, "server-workspace-quote");
    assert.equal(creates[0].billing_accepted, true);
  } finally {
    await client.close();
    await transport.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
