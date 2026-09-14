# OpenRouter API Reference

> Sources: official OpenRouter documentation and OpenAPI source at commit `8f6eddfc923da3ba4af8024ee8d35d16015397a5` (2026-09-14)
> Created: 2026-09-14
> Updated: 2026-09-14
>
> Primary source repository: <https://github.com/OpenRouterTeam/docs/tree/8f6eddfc923da3ba4af8024ee8d35d16015397a5>

## Overview

OpenRouter exposes a unified API for models from multiple providers. Its request and response schemas are close to the OpenAI Chat API, while the router normalizes provider differences and can select alternate providers when the preferred endpoint is unavailable.

The stable API base is:

```text
https://openrouter.ai/api/v1
```

The primary inference interfaces documented here are:

- Chat Completions: `POST /api/v1/chat/completions`
- Responses: `POST /api/v1/responses`
- Embeddings: `POST /api/v1/embeddings`
- Models: `GET /api/v1/models` and `GET /api/v1/model/{author}/{slug}`
- Current key and usage limits: `GET /api/v1/key`
- Generation metadata: `GET /api/v1/generation?id={generation_id}`

The complete contract is published as OpenAPI YAML and JSON:

- <https://openrouter.ai/openapi.yaml>
- <https://openrouter.ai/openapi.json>

## Core Concepts

### Authentication

Requests use an API key as a Bearer token. OpenRouter API keys can have credit limits and can participate in OAuth flows, so they should be treated as high-privilege secrets.

```http
Authorization: Bearer <OPENROUTER_API_KEY>
Content-Type: application/json
```

Optional attribution headers identify an application on OpenRouter:

```http
HTTP-Referer: <YOUR_SITE_URL>
X-OpenRouter-Title: <YOUR_SITE_NAME>
```

`X-Title` is also accepted as an alias for `X-OpenRouter-Title`. Keep keys in environment variables or a secret manager; never commit them to a repository. If a key is exposed, delete it in the OpenRouter key settings and create a replacement.

### Model identifiers and routing

Model IDs normally use an organization prefix, for example `openai/gpt-5.2`. The `model` field may be omitted, in which case the user's or payer's default model is used. The `models` field can provide a fallback list.

By default, OpenRouter load-balances across providers for a model, prioritizing price while considering recent availability. It can retry other providers after provider failures or rate limiting. Explicit `order` or `sort` preferences disable the default load-balancing behavior.

Model aliases and variants are resolved by the Models API. Catalog variants such as `:free` have their own model entry; routing variants such as `:nitro` resolve to the base model entry.

### Native tokenization and usage

Token counts and pricing use the selected model's native tokenizer. The response `usage` object is therefore model-specific and should be used instead of estimating tokens with a tokenizer from another model family.

### Stateless Responses API

The Responses API does not store prior conversation state. `store: true` and `previous_response_id` are not supported; clients must send the complete conversation history in every request. Assistant messages in a supplied history require `id` and `status`.

## API / Interface

### Chat Completions request

The canonical request shape is OpenAI-compatible with OpenRouter-specific routing and debugging fields:

```typescript
type Request = {
  messages?: Message[]; // Either messages or prompt is required
  prompt?: string;
  model?: string;
  response_format?: ResponseFormat;
  stop?: string | string[];
  stream?: boolean;
  plugins?: Plugin[];
  max_tokens?: number;
  temperature?: number;
  tools?: Tool[];
  tool_choice?: ToolChoice;
  seed?: number;
  top_p?: number;
  top_k?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  repetition_penalty?: number;
  logit_bias?: { [key: number]: number };
  top_logprobs?: number;
  min_p?: number;
  top_a?: number;
  prediction?: { type: 'content'; content: string };
  models?: string[];
  route?: 'fallback';
  provider?: ProviderPreferences;
  user?: string;
  debug?: { echo_upstream_body?: boolean };
};

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } };

type Message =
  | {
      role: 'user' | 'assistant' | 'system';
      content: string | ContentPart[];
      name?: string;
    }
  | {
      role: 'tool';
      content: string;
      tool_call_id: string;
      name?: string;
    };

type Tool = {
  type: 'function';
  function: {
    description?: string;
    name: string;
    parameters: object;
  };
};

type ToolChoice =
  | 'none'
  | 'auto'
  | 'required'
  | { type: 'function'; function: { name: string } };

type ResponseFormat =
  | { type: 'json_object' }
  | {
      type: 'json_schema';
      json_schema: {
        name: string;
        strict?: boolean;
        schema: object;
      };
    };

type Plugin = {
  id: string;
  enabled?: boolean;
  [key: string]: unknown;
};
```

`messages` and `prompt` are alternative input forms. User messages may contain text or multimodal text/image content. Tools follow the OpenAI function-calling shape and are transformed for providers with other native interfaces.

### Chat Completions response

```typescript
type Response = {
  id: string;
  choices: (NonStreamingChoice | StreamingChoice | NonChatChoice)[];
  created: number;
  model: string;
  object: 'chat.completion' | 'chat.completion.chunk';
  system_fingerprint?: string;
  usage?: ResponseUsage;
};

type ResponseUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens: number;
    cache_write_tokens?: number;
    audio_tokens?: number;
    video_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
    audio_tokens?: number;
    image_tokens?: number;
  };
  cost?: number;
  is_byok?: boolean;
  cost_details?: {
    upstream_inference_cost?: number;
    upstream_inference_prompt_cost: number;
    upstream_inference_completions_cost: number;
    server_tool_cost?: number | null;
  };
  server_tool_use?: { web_search_requests?: number };
};

type NonStreamingChoice = {
  finish_reason: string | null;
  native_finish_reason: string | null;
  message: {
    content: string | null;
    role: string;
    tool_calls?: ToolCall[];
  };
  error?: ErrorResponse;
};

type StreamingChoice = {
  finish_reason: string | null;
  native_finish_reason: string | null;
  delta: {
    content: string | null;
    role?: string;
    tool_calls?: ToolCall[];
  };
  error?: ErrorResponse;
};

type ToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

type ErrorResponse = {
  code: number;
  message: string;
  metadata?: Record<string, unknown>;
};
```

Normalized `finish_reason` values include `tool_calls`, `stop`, `length`, `content_filter`, and `error`. Provider-specific raw values are available in `native_finish_reason`.

Usage is always returned for non-streaming completions. For Chat Completions streaming, usage is returned once in the final chunk before `[DONE]`. OpenRouter intentionally includes a content-free choice in that usage chunk, rather than an empty `choices` array.

### Responses API

Basic request:

```typescript
const response = await fetch('https://openrouter.ai/api/v1/responses', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer YOUR_OPENROUTER_API_KEY',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'openai/o4-mini',
    input: 'What is the meaning of life?',
    max_output_tokens: 9000,
  }),
});

const result = await response.json();
console.log(result);
```

`input` can be a string or a structured message array. A typical response has `id`, `object: "response"`, `created_at`, `model`, `output`, `usage`, and `status`. Output text is represented as an `output_text` content part inside an assistant message.

Common request fields documented by the Responses API include:

| Field | Type | Notes |
|---|---|---|
| `model` | string | Required model ID |
| `input` | string or array | Required prompt or message/input items |
| `stream` | boolean | Enables SSE; default is false |
| `max_output_tokens` | integer | Output token ceiling |
| `temperature` | number | Range 0–2 |
| `top_p` | number | Nucleus sampling |
| `reasoning` | object | Reasoning configuration, e.g. `{ effort: "high" }` |
| `tools` | array | Function tools |
| `tool_choice` | string or object | `auto`, `none`, or a named function |

The Responses API is streamed as SSE events such as `response.created`, `response.output_item.added`, `response.content_part.delta`, `response.output_item.done`, and `response.done`. Usage is reported in the completed response event.

### Embeddings

Generate text embeddings with `POST /api/v1/embeddings`:

```typescript
const response = await fetch('https://openrouter.ai/api/v1/embeddings', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer <OPENROUTER_API_KEY>',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'openai/text-embedding-3-small',
    input: 'The quick brown fox jumps over the lazy dog',
  }),
});

const data = await response.json();
const embedding = data.data[0].embedding;
```

`input` can be one string or an array of strings. Compatible multimodal embedding models can accept an input item with `content` containing `text` and/or `image_url` parts. Embeddings are returned as complete responses; streaming is not supported.

Available embedding models can be listed with `GET /api/v1/embeddings/models`.

### Streaming

Set `stream: true` on Chat Completions, Responses, or other supported inference requests. Chat Completions and Responses use Server-Sent Events. A hand-written parser must:

1. Buffer incomplete lines.
2. Ignore SSE comment lines beginning with `:` such as `: OPENROUTER PROCESSING`.
3. Parse only `data: ` payloads.
4. Stop at `data: [DONE]`.
5. Check every parsed event for an error, including a terminal usage or error event.

The generation ID is returned in the `X-Generation-Id` response header for chat completions, completions, responses, and messages.

If an error happens before the response is committed, OpenRouter returns a normal JSON error with an HTTP error status. After headers are committed, the HTTP status remains `200`; a mid-stream failure is delivered as an SSE event containing an `error` field and a choice with `finish_reason: "error"`.

### Tool calling

Tool calling is a client-side loop:

1. Send `tools` with the user request.
2. Inspect the assistant response for `tool_calls` or Responses API `function_call` output items.
3. Validate and execute the requested function locally.
4. Send the tool result back in a follow-up request.
5. Include the tool definitions again in Chat Completions follow-up requests.

Chat Completions tool result example:

```json
{
  "role": "tool",
  "tool_call_id": "call_abc123",
  "content": "[{\"id\":4300,\"title\":\"Ulysses\"}]"
}
```

Responses API function-call output uses `function_call_output` with `call_id` and `output`. `output` may be a string or an array of input content parts. `tool_choice` can be `auto`, `none`, or a specific function. `parallel_tool_calls` controls whether multiple function calls may be requested concurrently and defaults to true where supported.

### Structured outputs

Use JSON mode:

```json
{
  "response_format": {
    "type": "json_object"
  }
}
```

Use schema-constrained output:

```json
{
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "weather",
      "strict": true,
      "schema": {
        "type": "object",
        "properties": {
          "location": { "type": "string" },
          "temperature": { "type": "number" }
        },
        "required": ["location", "temperature"],
        "additionalProperties": false
      }
    }
  }
}
```

Support is endpoint-specific: a model can have multiple providers, and only some endpoints may support structured outputs. To restrict routing to compatible providers, set `provider.require_parameters` to `true`. Strict enforcement varies by provider; validate the returned content in the client.

### Models API

`GET /api/v1/models` returns a standardized object with `data`, `total_count`, and optional pagination links. Pagination is opt-in with `offset` and `limit`; `limit` defaults to 500 and has a maximum of 1000 when pagination is used.

Useful query parameters:

| Parameter | Values / purpose |
|---|---|
| `output_modalities` | `text`, `image`, `audio`, `embeddings`, or `all`; comma-separated values are accepted |
| `supported_parameters` | Filter by supported request parameter, e.g. `tools` |
| `sort` | `pricing-low-to-high`, `pricing-high-to-low`, `context-high-to-low`, `throughput-high-to-low`, `latency-low-to-high`, `most-popular`, `top-weekly`, `newest` |
| `offset`, `limit` | Opt-in pagination |

A model object includes `id`, `canonical_slug`, `name`, `created`, `description`, `context_length`, `architecture`, `pricing`, `top_provider`, `per_request_limits`, `supported_parameters`, `default_parameters`, and optional `expiration_date` and `benchmarks`. Pricing strings are USD per token, request, image, web-search operation, or other documented unit.

### Provider routing

The `provider` request object supports:

| Field | Type | Default / behavior |
|---|---|---|
| `order` | string[] | Provider slugs tried in priority order |
| `allow_fallbacks` | boolean | `true` |
| `require_parameters` | boolean | `false`; only providers supporting all request parameters when true |
| `data_collection` | `allow` or `deny` | `allow` |
| `zdr` | boolean | Restrict to Zero Data Retention endpoints when true |
| `enforce_distillable_text` | boolean | Restrict to models allowing text distillation when true |
| `only` | string[] | Allow only listed providers |
| `ignore` | string[] | Skip listed providers |
| `quantizations` | string[] | Filter quantization levels such as `fp8`, `int8`, `int4` |
| `sort` | string or object | `price`, `throughput`, or `latency`; object may include `partition` |
| `preferred_min_throughput` | number or percentile object | Prefer endpoints above a throughput threshold; does not exclude all others |
| `preferred_max_latency` | number or percentile object | Prefer endpoints below a latency threshold; does not exclude all others |
| `max_price` | object | Hard maximum accepted pricing |

A base provider slug matches provider variants and regions. A full slug such as `google-vertex/us-east5` or `deepinfra/turbo` targets a specific endpoint. Restrictive `only`, `ignore`, `order`, or `allow_fallbacks: false` settings reduce recovery options.

## Usage Patterns

### Minimal raw API call

```bash
curl https://openrouter.ai/api/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -d '{
  "model": "~openai/gpt-sol-latest",
  "messages": [
    {"role": "user", "content": "What is the meaning of life?"}
  ]
}'
```

### TypeScript SDK

The official quickstart documents `@openrouter/sdk`:

```typescript
import { OpenRouter } from '@openrouter/sdk';

const client = new OpenRouter({
  apiKey: '<OPENROUTER_API_KEY>',
  httpReferer: '<YOUR_SITE_URL>',
  appTitle: '<YOUR_SITE_NAME>',
});

const completion = await client.chat.send({
  chatRequest: {
    model: '~openai/gpt-sol-latest',
    messages: [
      {
        role: 'user',
        content: 'What is the meaning of life?',
      },
    ],
  },
});

if (completion instanceof ReadableStream) {
  throw new Error('Expected a non-streaming response');
}

console.log(completion.choices[0].message.content);
```

### Python SDK

The official quickstart documents the `openrouter` package:

```python
from openrouter import OpenRouter
import os

with OpenRouter(api_key=os.getenv("OPENROUTER_API_KEY")) as client:
    response = client.chat.send(
        model="~openai/gpt-sol-latest",
        messages=[
            {"role": "user", "content": "What is the meaning of life?"}
        ],
    )

    print(response.choices[0].message.content)
```

### Retryable request handling

Honor `Retry-After` on `429` and `503` responses. For direct `fetch`, check the response status before parsing a success body:

```typescript
const res = await fetch('https://openrouter.ai/api/v1/chat/completions', { ... });
if (res.status === 429 || res.status === 503) {
  const retryAfter = Number(res.headers.get('Retry-After'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    // retry the request
  }
}
```

For streaming, also treat a `200` response containing a mid-stream `error` event as a failure.

### Querying generation statistics

Use the generation ID from the response to retrieve asynchronous usage and cost metadata:

```typescript
const generation = await fetch(
  'https://openrouter.ai/api/v1/generation?id=$GENERATION_ID',
  { headers },
);

const stats = await generation.json();
```

## Configuration

### Sampling and generation parameters

OpenRouter forwards supported parameters to the selected provider. If a parameter is absent, OpenRouter omits it upstream rather than inserting a hardcoded value; the provider then applies its own default.

| Parameter | Type and documented range | Conventional default / notes |
|---|---|---|
| `temperature` | float, 0–2 | 1.0 |
| `top_p` | float, 0–1 | 1.0 |
| `top_k` | integer, 0+ | 0; not available for OpenAI models |
| `frequency_penalty` | float, -2–2 | 0.0 |
| `presence_penalty` | float, -2–2 | 0.0 |
| `repetition_penalty` | float, 0–2 | 1.0 |
| `min_p` | float, 0–1 | 0.0 |
| `top_a` | float, 0–1 | 0.0 |
| `seed` | integer | Determinism is not guaranteed for every model |
| `max_tokens` | integer, 1+ | Limited by context remaining after the prompt |
| `max_completion_tokens` | integer, 1+ | Output ceiling |
| `logit_bias` | map | Token ID to bias from -100 to 100 |
| `logprobs` | boolean | Return output token log probabilities |
| `top_logprobs` | integer, 0–20 | Requires `logprobs: true` |
| `stop` | array | Stop on a listed token/sequence |
| `response_format` | map | JSON mode or JSON Schema mode |
| `structured_outputs` | boolean | Model/provider capability flag |
| `tools` | array | Function/tool definitions |
| `tool_choice` | string or object | Tool selection policy |
| `parallel_tool_calls` | boolean | Defaults to true where supported |
| `reasoning` | map | Thinking/reasoning behavior |
| `reasoning_effort` | enum | `xhigh`, `high`, `medium`, `low`, `minimal`, `none` |
| `verbosity` | enum | `low`, `medium`, `high`, `xhigh`, `max`; conventional default `medium` |
| `web_search_options` | map | Native web-search configuration |

## Best Practices

1. **Pin and monitor model capability data.** Use `GET /api/v1/models` and inspect `supported_parameters`, `architecture`, `context_length`, and pricing before enabling tools, structured outputs, multimodal input, or reasoning.
2. **Use the official stable base URL and Bearer authentication.** Keep API keys outside source control and set per-key credit limits where appropriate.
3. **Treat provider behavior as variable.** A parameter unsupported by a chosen provider may be ignored unless `provider.require_parameters` is true.
4. **Design clients defensively.** Ignore unknown response fields and tolerate unknown enum values because non-breaking API changes can add both.
5. **Parse SSE according to the specification.** Buffer lines, ignore comments, recognize `[DONE]`, and inspect terminal usage/error frames.
6. **Handle errors at both transport and payload levels.** A provider failure after headers are committed can arrive in a `200` response body or SSE event.
7. **Use fallback routing deliberately.** Leave fallbacks enabled for availability-sensitive workloads; restrict `order`, `only`, `ignore`, or `allow_fallbacks` only when the policy requires it.
8. **Use `require_parameters: true` for hard feature requirements.** This is especially important for tool calling and structured outputs.
9. **Respect cost and quota signals.** Inspect `usage`, `cost`, `GET /api/v1/key`, `Retry-After`, and rate-limit headers where present.
10. **Validate tool arguments locally.** The model proposes a tool call; the client executes it and returns the result. Do not treat model-generated arguments as trusted input.
11. **Do not use debug output in production.** `debug.echo_upstream_body` is streaming-only and may expose sensitive transformed request data.
12. **Refresh model availability independently from API versioning.** Providers can add or remove models without changing the stable `v1` API path.

## Common Pitfalls

- **Parsing every SSE line as JSON:** comment lines such as `: OPENROUTER PROCESSING` are valid SSE and must be ignored.
- **Assuming HTTP 200 means success:** mid-stream or post-commit errors can be delivered with status 200; inspect the event/body for `error`.
- **Assuming an empty `choices` array is always present in the final Chat Completions usage frame:** OpenRouter includes a content-free choice in that frame for client compatibility.
- **Forgetting tools in a follow-up Chat Completions request:** include the `tools` definition again so the router can validate the schema.
- **Sending unsupported parameters without checking the endpoint:** unsupported parameters may be ignored unless `require_parameters` is enabled.
- **Using one tokenizer for all models:** token counts and costs use each model's native tokenizer.
- **Assuming Responses API state is stored:** send the complete conversation history; `store` and `previous_response_id` are rejected.
- **Treating provider slugs as exact endpoint IDs:** a base slug can match multiple regions or variants; use the full slug for a specific endpoint.
- **Over-constraining provider routing:** `only`, `ignore`, disabled fallbacks, and strict price limits can make a request fail even when another provider could serve it.
- **Assuming structured outputs are universally strict:** support and enforcement vary by provider endpoint; validate application output.
- **Retrying without honoring `Retry-After`:** 429/503 responses may provide a wait interval.
- **Using debug mode in production:** transformed request bodies can contain information that should not be exposed.

## Version Notes

The stable API version is selected by the path `https://openrouter.ai/api/v1`. There are no version headers and no date-based version pinning.

The API evolves continuously. Non-breaking changes may ship without prior notice and include new endpoints, optional request parameters, response fields, status codes, schemas, optional properties, and union variants. Clients should ignore fields they do not recognize and should not fail on unknown enum values.

Breaking changes include removing or renaming endpoints, parameters, or response fields; changing a field type; widening a previously non-null field to allow `null`; or making an optional parameter required. Such changes are reviewed and announced in the API Changelog with migration notes.

Model availability is independent of API versioning: providers can add or remove models separately. Monitor the API Changelog and the official Models API for current compatibility.

## Primary Sources

All sources below are official OpenRouter materials from the same pinned documentation commit:

- [API Reference overview](https://github.com/OpenRouterTeam/docs/blob/8f6eddfc923da3ba4af8024ee8d35d16015397a5/api_reference/overview.mdx) — request/response normalization, headers, plugins, structured outputs, usage.
- [Authentication](https://github.com/OpenRouterTeam/docs/blob/8f6eddfc923da3ba4af8024ee8d35d16015397a5/api_reference/authentication.mdx) — Bearer API keys, attribution headers, key safety.
- [Parameters](https://github.com/OpenRouterTeam/docs/blob/8f6eddfc923da3ba4af8024ee8d35d16015397a5/api_reference/parameters.mdx) — sampling, generation, tools, reasoning, verbosity, web search.
- [Streaming](https://github.com/OpenRouterTeam/docs/blob/8f6eddfc923da3ba4af8024ee8d35d16015397a5/api_reference/streaming.mdx) — SSE framing, usage frames, cancellation, pre-stream and mid-stream errors.
- [Embeddings](https://github.com/OpenRouterTeam/docs/blob/8f6eddfc923da3ba4af8024ee8d35d16015397a5/api_reference/embeddings.mdx) — text/image embeddings, models, batching, limits.
- [Errors and debugging](https://github.com/OpenRouterTeam/docs/blob/8f6eddfc923da3ba4af8024ee8d35d16015397a5/api_reference/errors-and-debugging.mdx) — HTTP errors, typed `error_type`, provider errors, debug mode.
- [Limits](https://github.com/OpenRouterTeam/docs/blob/8f6eddfc923da3ba4af8024ee8d35d16015397a5/api_reference/limits.mdx) — credits, free-model limits, 402/429 behavior, headers.
- [Versioning](https://github.com/OpenRouterTeam/docs/blob/8f6eddfc923da3ba4af8024ee8d35d16015397a5/api_reference/versioning.mdx) — stable `v1`, compatibility and deprecation policy.
- [Quickstart](https://github.com/OpenRouterTeam/docs/blob/8f6eddfc923da3ba4af8024ee8d35d16015397a5/quickstart.mdx) — raw API, official TypeScript/Python SDKs, Responses overview.
- [Responses basic usage](https://github.com/OpenRouterTeam/docs/blob/8f6eddfc923da3ba4af8024ee8d35d16015397a5/api_reference/responses/basic-usage.mdx) — Responses input, output, streaming, stateless conversations.
- [Responses tool calling](https://github.com/OpenRouterTeam/docs/blob/8f6eddfc923da3ba4af8024ee8d35d16015397a5/api_reference/responses/tool-calling.mdx) — function calls, outputs, parallel calls, streaming events.
- [Responses reasoning](https://github.com/OpenRouterTeam/docs/blob/8f6eddfc923da3ba4af8024ee8d35d16015397a5/api_reference/responses/reasoning.mdx) — reasoning effort, response output, streaming deltas.
- [Provider routing](https://github.com/OpenRouterTeam/docs/blob/8f6eddfc923da3ba4af8024ee8d35d16015397a5/guides/routing/provider-selection.mdx) — provider preferences, fallback, performance, data policy.
- [Tool calling guide](https://github.com/OpenRouterTeam/docs/blob/8f6eddfc923da3ba4af8024ee8d35d16015397a5/guides/features/tool-calling.mdx) — client-side tool loop and Chat Completions tool format.
- [Structured outputs guide](https://github.com/OpenRouterTeam/docs/blob/8f6eddfc923da3ba4af8024ee8d35d16015397a5/guides/features/structured-outputs.mdx) — JSON mode, JSON Schema, endpoint support.
- [Models guide](https://github.com/OpenRouterTeam/docs/blob/8f6eddfc923da3ba4af8024ee8d35d16015397a5/guides/overview/models.mdx) — model catalog, filters, pagination, pricing and capabilities.
- [OpenAPI source](https://github.com/OpenRouterTeam/docs/blob/8f6eddfc923da3ba4af8024ee8d35d16015397a5/openapi/openapi.yaml) — machine-readable authoritative API contract.

The direct `openrouter.ai` pages were not fetchable in this environment because of Cloudflare/security protection. The official `OpenRouterTeam/docs` repository is the primary source used instead, pinned to the commit above so the reference can be refreshed reproducibly.
