# Check your model client with five offline fixtures

When an application fails to call an OpenAI-compatible model endpoint, a useful first step is to isolate client behavior from the server. A tiny fake transport can check URL construction, error handling and streaming without renting a GPU or sending a generation request.

The CloudGPU MCP repository documents both local MCP setup and remote account connection. Client-side API fixtures provide a separate reproducible input for debugging applications around those workflows. This example has no account connection or rental step.

## Run the fixture

Tested with CPython 3.12.16, openai 3.3.0 and httpx 0.28.1. These pins reproduce this check; they are not a claim about the latest versions.

```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install openai==3.3.0 httpx==0.28.1
python offline_gateway_contract.py
```

Package installation can access the package index. The fixture's API requests use MockTransport and need no API account, real credential, model download or GPU.

Save this complete example as `offline_gateway_contract.py`:

```python
"""Run SDK contract checks entirely through HTTPX MockTransport."""

import json
import unittest

import httpx
from openai import APIStatusError, OpenAI


def client_for(handler):
    return OpenAI(
        base_url="https://mock.invalid/v1",
        api_key="offline-fixture-key",
        max_retries=0,
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )


class GatewayContractTests(unittest.TestCase):
    def test_chat_payload_and_response(self):
        def handler(request):
            self.assertEqual(str(request.url), "https://mock.invalid/v1/chat/completions")
            self.assertEqual(json.loads(request.content)["model"], "fixture-model")
            return httpx.Response(200, json={
                "id": "fixture", "object": "chat.completion", "created": 0,
                "model": "fixture-model",
                "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"},
                             "finish_reason": "stop"}],
            })
        with client_for(handler) as client:
            result = client.chat.completions.create(
                model="fixture-model", messages=[{"role": "user", "content": "offline fixture"}]
            )
        self.assertEqual(result.choices[0].message.content, "ok")

    def check_error(self, status, body):
        with client_for(lambda request: httpx.Response(status, text=body)) as client:
            with self.assertRaises(APIStatusError) as caught:
                client.chat.completions.create(
                    model="fixture-model", messages=[{"role": "user", "content": "offline fixture"}]
                )
        self.assertEqual(caught.exception.status_code, status)

    def test_bad_request(self):
        self.check_error(400, '{"error":{"message":"fixture: unknown model"}}')

    def test_authentication_error(self):
        self.check_error(401, '{"error":{"message":"fixture: invalid key"}}')

    def test_non_json_gateway_error(self):
        self.check_error(503, "<html>fixture: upstream unavailable</html>")

    def test_stream_role_and_usage_only_chunks(self):
        common = {"id": "fixture", "object": "chat.completion.chunk", "created": 0,
                  "model": "fixture-model"}
        chunks = [
            {**common, "choices": [{"index": 0, "delta": {"role": "assistant", "content": None},
                                    "finish_reason": None}]},
            {**common, "choices": [{"index": 0, "delta": {"content": "ok"},
                                    "finish_reason": "stop"}]},
            {**common, "choices": [], "usage": {"prompt_tokens": 1, "completion_tokens": 1,
                                                  "total_tokens": 2}},
        ]
        payload = "".join("data: " + json.dumps(chunk) + "\n\n" for chunk in chunks) + "data: [DONE]\n\n"
        def handler(request):
            self.assertTrue(json.loads(request.content)["stream"])
            return httpx.Response(200, headers={"content-type": "text/event-stream"}, text=payload)
        texts, totals = [], []
        with client_for(handler) as client:
            stream = client.chat.completions.create(
                model="fixture-model", messages=[{"role": "user", "content": "offline fixture"}],
                stream=True, stream_options={"include_usage": True},
            )
            for chunk in stream:
                if chunk.usage:
                    totals.append(chunk.usage.total_tokens)
                if chunk.choices and chunk.choices[0].delta.content:
                    texts.append(chunk.choices[0].delta.content)
        self.assertEqual(texts, ["ok"])
        self.assertEqual(totals, [2])


if __name__ == "__main__":
    unittest.main(verbosity=2)
```

Expected result: five tests pass. The duration varies by machine.

## What the result proves

The tests inspect the final `/v1/chat/completions` path and model field, exercise SDK status exceptions for 400/401/503 responses, and parse role-only and usage-only streaming chunks. The key, model and responses are invented fixtures. The token counts are fixture values, not a benchmark or an invoice.

A passing mock does not establish DNS/TLS connectivity, real authentication, model availability, server compatibility, GPU memory use, throughput or price. A later live check is a separate experiment against the chosen service and its billing terms.

References: [HTTPX mock transports](https://www.python-httpx.org/advanced/transports/#mock-transports), [OpenAI Python error handling](https://github.com/openai/openai-python#handling-errors).

Disclosure: this draft and fixture were prepared with AI assistance. The reported verification is a local fixture run; no live inference or paid API request was made.

CloudGPU integration reference: https://cloudgpu.app/docs/mcp . GPU rental and model API use are paid services; this local fixture does not establish service performance or provide compute credits.
