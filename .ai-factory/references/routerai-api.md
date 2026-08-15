# RouterAI API Reference

> Source:
> - https://routerai.ru/docs/reference (rendered from `/api/openapi.json`)
> - https://routerai.ru/api/openapi.json (OpenAPI 3.0.0 spec, authoritative)
> - https://routerai.ru/docs/guides (overview / "Обзор RouterAI")
> Created: 2026-08-15
> Updated: 2026-08-15

## Overview

RouterAI is a unified AI gateway that exposes models from OpenAI, Anthropic, Google, and many other providers behind a single API. Pricing is in rubles, pay-as-you-go. The API is compatible with the OpenAI API format (plus an Anthropic Messages-compatible endpoint), so existing OpenAI/Anthropic SDKs and tools can point at RouterAI with a base URL change.

The reference page (`/docs/reference`) is a Scalar API reference rendering of the OpenAPI document served at `https://routerai.ru/api/openapi.json`. The OpenAPI spec is the single source of truth for the endpoints and schemas below.

## Base URL and Conventions

- **Base URL:** `https://routerai.ru/api/v1`
  - The OpenAPI `servers` entry lists `https://routerai.ru/api`; every path is prefixed with `/v1/`, so the effective base is `https://routerai.ru/api/v1`.
  - Example endpoint: `POST https://routerai.ru/api/v1/chat/completions`
- **Content type:** JSON for request/response bodies, except binary responses (speech/video) and multipart transcription.
- **Auth:** HTTP Bearer token. Send `Authorization: Bearer <API key>`.
- **Error statuses (common across generation endpoints):**
  - `401` — invalid or missing API key.
  - `400` — invalid parameters.
  - `402` — insufficient balance.
  - `500` — internal server error.
  - `503` — no available providers for the requested model (some endpoints).

## Authentication

| Mechanism | Header | Notes |
|---|---|---|
| API key (standard) | `Authorization: Bearer <key>` | Used by all model/inference endpoints. |
| Master key (provisioning) | `Authorization: Bearer <master-key>` | Required for `/v1/keys*` and `/v1/team*`. Created in team settings (Keys → Master keys). A key created by a regular member (`role=member`) cannot access Team API and gets `403`. |

- `GET /v1/models` and `GET /v1/models/{author}/{slug}/endpoints` require **no** authentication.
- `GET /v1/key` returns info about the key used in the current request.

## API / Interface

### Chat Completions

`POST /v1/chat/completions` — OpenAI-compatible chat. Supports streaming and non-streaming.

Request body:

| Field | Type | Required | Description |
|---|---|---|---|
| `model` | string | ✅ | Model id, e.g. `deepseek/deepseek-chat-v3.1`. Catalog: https://routerai.ru/models |
| `messages` | array | ✅ | Chat messages. Each item: `{role, content}`. Roles: `system`, `developer`, `user`, `assistant`, `tool`. |
| `stream` | boolean | — | Streaming mode. Default `false`. |
| `temperature` | number | — | `0..2`. Default `1`. |
| `session_id` | string | — | Optional session id (max 256 chars) to group related requests. Can also be sent as header `X-Session-Id`; body wins if both present. |
| `provider` | object | — | Provider routing (see Configuration). |

Example request:

```json
{
  "model": "deepseek/deepseek-chat-v3.1",
  "messages": [{ "role": "user", "content": "Привет, как дела?" }]
}
```

Response: `ChatCompletion` — `id`, `choices[]` (`finish_reason`, `index`, `message{role,content,tool_calls,reasoning,refusal}`, `logprobs`), `created`, `model`, `object`, `system_fingerprint`, `usage`.

### Completions (legacy)

`POST /v1/completions` — text completion from a single prompt.

Request body:

| Field | Type | Required | Description |
|---|---|---|---|
| `model` | string | ✅ | Model id. |
| `prompt` | string | ✅ | Text prompt. |
| `stream` | boolean | — | Streaming mode. Default `false`. |
| `temperature` | number | — | `0..2`. |

Response: `Completion` — `id`, `provider`, `model`, `choices[]` (`message{role,content,images,reasoning}`).

### Models

`GET /v1/models` — list all available models with capabilities, pricing, context length. **No auth required.**

Response: array of `ModelsList` (`data[]` of `Model`).

`GET /v1/models/{author}/{slug}/endpoints` — endpoints of a model by provider, sorted in routing priority (first = default provider). **No auth required.**

Path params:

| Param | Description |
|---|---|
| `author` | Model author — id part before `/`, e.g. `anthropic` |
| `slug` | Model slug — id part after `/`, e.g. `claude-sonnet-4.5` |

Response: `ModelEndpointsResponse` (`data{id,name,created,description,architecture,endpoints[]}`).

`Model` fields: `id`, `name`, `created`, `description`, `context_length`, `architecture`, `pricing`, `per_request_limits`, `supported_parameters[]`, `default_parameters`.

`ModelEndpoint` fields: `name`, `provider_name`, `tag` (provider slug for `provider.order/only/ignore`), `country` (2-letter, nullable), `context_length`, `quantization`, `max_completion_tokens`, `max_prompt_tokens`, `supported_parameters[]`, `supported_apis[]` (e.g. `chat`, `messages`, `responses`, `embeddings`), `status` (0 = normal; negative = temporarily deprioritized), `pricing`, `variable_pricings[]`.

### Responses API

`POST /v1/responses` — OpenAI Responses API (newer than Chat Completions). Supports streaming.

Request body:

| Field | Type | Required | Description |
|---|---|---|---|
| `model` | string | ✅ | Model id. |
| `input` | string/array | ✅ | String or array of `{role, content}`. |
| `stream` | boolean | — | Default `false`. |
| `temperature` | number | — | `0..2`. |
| `session_id` | string | — | Same semantics as Chat Completions. |
| `provider` | object | — | Provider routing. |

Response: `ResponseEntity` — `id`, `object`, `status`, `output[]` (`OutputMessage{id,role,type,status,content[]}` where content items are `OutputContent{type,text,annotations}`), `usage`, and many optional fields.

### Embeddings

`POST /v1/embeddings` — embed text/images/audio into fixed-length vectors.

Request body:

| Field | Type | Required | Description |
|---|---|---|---|
| `model` | string | ✅ | e.g. `google/gemini-embedding-001`. |
| `input` | string/array | ✅ | String or array of strings. |
| `encoding_format` | string | — | `float` (default) or `base64`. |

Response: `Embedding` — `id`, `provider`, `model`, `data[]`.

### Messages (Anthropic)

`POST /v1/messages` — Anthropic Messages API. Compatible with Claude Code and the official Anthropic SDK. Request `{model, max_tokens, messages, system?, tools?, ...}`; response uses content blocks (`text`, `tool_use`, `thinking`).

Request body:

| Field | Type | Required | Description |
|---|---|---|---|
| `model` | string | ✅ | e.g. `anthropic/claude-sonnet-4.6`. |
| `max_tokens` | integer | ✅ | Max output tokens. |
| `messages` | array | ✅ | `{role: "user"|"assistant", content}`; content can be text or content blocks. |
| `system` | string | — | System prompt (string or `[{type:"text", text}]`). |
| `stream` | boolean | — | Anthropic SSE. Default `false`. |
| `temperature` | number | — | Default `1.0`. |
| `top_p` | number | — | |
| `top_k` | integer | — | |
| `stop_sequences` | array<string> | — | |
| `tools` | array | — | Anthropic format `{name, description, input_schema}`. |
| `tool_choice` | object | — | |
| `metadata` | object | — | |
| `thinking` | object | — | Extended thinking `{type:"enabled", budget_tokens}`. |
| `session_id` | string | — | Same semantics as Chat Completions. |
| `provider` | object | — | Provider routing. |

Response: `Message` — `id`, `type`, `role`, `content[]`, `model`, `stop_reason`, `usage{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}`.

### Rerank

`POST /v1/rerank` — re-rank documents by relevance to a query. Returns `relevance_score` per document.

Request body:

| Field | Type | Required | Description |
|---|---|---|---|
| `model` | string | ✅ | e.g. `cohere/rerank-4-pro`. |
| `query` | string | ✅ | Search query. |
| `documents` | array<string> | ✅ | Documents to rank. |
| `top_n` | integer | — | Return top N. |
| `return_documents` | boolean | — | Include document text in response. |

Response example:

```json
{
  "id": "rerank-7f3c2a1b",
  "model": "cohere/rerank-4-pro",
  "results": [
    { "index": 0, "relevance_score": 0.9871 },
    { "index": 1, "relevance_score": 0.0123 }
  ],
  "usage": { "total_tokens": 28 }
}
```

### Speech (TTS)

`POST /v1/audio/speech` — text-to-speech. Returns raw binary audio.

Request body:

| Field | Type | Required | Description |
|---|---|---|---|
| `model` | string | ✅ | e.g. `x-ai/grok-voice-tts-1.0`. |
| `input` | string | ✅ | Text to synthesize. |
| `voice` | string | ✅ | Voice id (model-dependent). |
| `response_format` | string | — | `mp3` or `pcm` (16-bit little-endian). Default `pcm`. Determines Content-Type (`audio/mpeg` vs `audio/pcm`). |
| `speed` | number | — | Speed multiplier, default `1.0`. Only honored by models that support it (e.g. OpenAI TTS). |
| `provider` | object | — | Provider routing. |

Response: binary audio. Header `X-Generation-Id` gives the generation id for cost lookup via `GET /v1/generation`.

### Transcription (STT)

`POST /v1/audio/transcriptions` — audio-to-text. Two input formats:

1. JSON with base64 audio (`input_audio`).
2. OpenAI-compatible `multipart/form-data` with a file (`file`, `model`, …) — works with `client.audio.transcriptions.create`.

JSON body:

| Field | Type | Required | Description |
|---|---|---|---|
| `model` | string | ✅ | e.g. `openai/whisper-large-v3`. |
| `input_audio` | object | ✅ | `{data: "<base64>", format: "<mp3|wav|flac|m4a|ogg|webm|aac>"}`. |
| `language` | string | — | ISO-639-1 code (auto-detect by default). |
| `temperature` | number | — | Sampling temperature. |
| `response_format` | string | — | `json` (default, `{text, usage}`) or `verbose_json` (adds `task`, `language`, `duration`, `segments`, `words`). |
| `timestamp_granularities` | array | — | `["word"]`/`["segment"]`; only with `verbose_json`. |
| `provider` | object | — | Provider routing. |

Multipart fields: `file` (binary), `model`, plus `language`, `temperature`, `response_format`, `timestamp_granularities` as above.

Response: `TranscriptionResponse` — `text` (required), `usage{total_tokens, input_tokens, output_tokens, seconds, cost}` (cost in rubles), and verbose fields when requested.

### Video (async)

Create a job, poll it, then download the result.

- `POST /v1/videos` — create a job. Returns `202` with `VideoJob` and `polling_url`.
- `GET /v1/videos/{id}` — job status.
- `GET /v1/videos/{id}/content` — download mp4 (after `completed`). Query `index` defaults to `0`.

Create request body:

| Field | Type | Required | Description |
|---|---|---|---|
| `model` | string | ✅ | Video model. |
| `prompt` | string | ✅ | Text description. |
| `frame_images` | array | — | image-to-video keyframes: `{type:"image_url", image_url:{url}, frame_type:"first_frame"|"last_frame"}`. |
| `input_references` | array | — | `{type:"image_url"|"video_url"|"audio_url", ..._url:{url}}`. |
| `aspect_ratio` | string | — | `16:9` (default), `9:16`, `1:1`, `4:3`, `3:4`, `3:2`, `2:3`, `21:9`, `9:21`. |
| `resolution` | string | — | `480p`, `720p`, `1080p`, `1K`, `2K`, `4K`. |
| `size` | string | — | `WIDTHxHEIGHT`, e.g. `1280x720`. |
| `duration` | integer | — | Seconds (≥1). |
| `seed` | integer | — | Reproducibility. |
| `generate_audio` | boolean | — | Generate audio track. |
| `callback_url` | string (uri) | — | HTTPS webhook; POSTed on terminal status. Non-absolute https URL is ignored (does not block job creation). |
| `provider` | object | — | Provider routing. |

`VideoJob` fields: `id`, `status` (`queued`/`pending`/`in_progress`/`completed`/`failed`/`cancelled`/`expired`), `model`, `generation_id`, `polling_url`, `unsigned_urls[]` (present at `completed`), `usage{cost}` (rubles), `error` (at `failed`).

### Images

`POST /v1/images` — synchronous image generation; returns base64 in `data[].b64_json`.

Request body:

| Field | Type | Required | Description |
|---|---|---|---|
| `model` | string | ✅ | Image model (has `image` in `architecture.output_modalities`). |
| `prompt` | string | — | Required for generation from scratch; may be omitted with `input_references` (image-to-image). |
| `n` | integer | — | Number of images. |
| `aspect_ratio` | string | — | e.g. `1:1`, `16:9`, `9:16`. |
| `resolution` | string | — | e.g. `512`, `1K`, `2K`, `4K`. |
| `size` | string | — | e.g. `1024x1024`. |
| `quality` | string | — | e.g. `auto`, `low`, `medium`, `high`. |
| `background` | string | — | e.g. `auto`, `transparent`, `opaque`. |
| `output_format` | string | — | e.g. `png`, `jpeg`, `webp`, `svg`. |
| `output_compression` | integer | — | 0–100 for jpeg/webp. |
| `seed` | integer | — | Reproducibility. |
| `input_references` | array | — | `{type:"image_url", image_url:{url}}` for edit/variations. |
| `stream` | boolean | — | If `true`, SSE stream with `image_generation.partial_image` previews and final `image_generation.completed`. Default `false`. |
| `provider` | object | — | Provider routing. |

Response: `ImageResponse` — `created`, `data[]` (`b64_json`, `media_type`), `usage{cost}` (rubles).

### API Keys (master key)

| Method & Path | Summary |
|---|---|
| `GET /v1/keys` | List all API keys. |
| `POST /v1/keys` | Create key. Body: `name` (required), `limit` (monthly spend limit, default `0`). Response `NewKey{data, key}` — `key` shown once. |
| `GET /v1/keys/{hash}` | Get key by hash. |
| `PATCH /v1/keys/{hash}` | Update key. Body: `name`, `disabled`, `limit`. |
| `DELETE /v1/keys/{hash}` | Delete key (`204`). |
| `GET /v1/key` | Info about the key used in the current request (no master key needed). |

`Key` schema: `usage`, `limit`, `limit_reset` (`monthly`), `limit_remaining`, `usage_monthly`, `name`, `hash`, `disabled`, `created_at`, `updated_at`.

### Team Management (master key)

| Method & Path | Summary |
|---|---|
| `GET /v1/team` | Team summary: `TeamInfo{id, name, members_count, pending_invitations_count, balance, created_at}`. |
| `GET /v1/team/members` | List members. Query: `active` (bool; default active only), `page` (default 1), `per_page` (default 100, max 500). |
| `POST /v1/team/members` | Create member account directly (no invite-accept step). |
| `GET /v1/team/members/{id}` | Member card. |
| `PATCH /v1/team/members/{id}` | Update member (role, spending limit, active). |
| `DELETE /v1/team/members/{id}` | Soft-delete member (deactivate). |
| `GET /v1/team/invitations` | List invitations. Query: `status` (`pending`/`accepted`/`declined`/`expired`), `page`, `per_page`. |
| `POST /v1/team/invitations` | Invite an already-registered user. |
| `DELETE /v1/team/invitations/{id}` | Revoke a pending invitation. |

`TeamMember`: `id`, `user_id`, `email`, `role` (`admin`|`member`), `active`, `is_owner`, `monthly_spending_limit` (string, `"0.0"` = no limit), `spending_limit_period` (`day`|`week`|`month`), `monthly_spending`, `period_spending`, `created_at`.

`CreateTeamMember`: `email` (required), `role` (default `member`), `monthly_spending_limit` (default 0), `spending_limit_period` (default `month`), `password` (6–128 chars; if omitted response contains `password_setup_url` valid 6h), `send_email` (default `false`). Returns `409` if email already registered — use invitations instead.

`CreateTeamInvitation`: `email` (required), `role`, `monthly_spending_limit`, `spending_limit_period`, `send_email`. Valid 7 days. Response includes `invite_url` (nullable once accepted/declined/expired).

Invariant notes (from spec descriptions):
- Owner can only have their spend limit changed.
- The last active admin cannot be demoted or deactivated.
- Owner and last active admin cannot be removed.

### Credits & Generation

| Method & Path | Summary |
|---|---|
| `GET /v1/credits` | Current balance. Response `Credits{credits}`. |
| `GET /v1/generation?id=<id>` | Details of a past request. `id` from response header `X-Generation-Id` or body `id`. |

`Generation` schema: `id`, `created_at`, `model`, `api` (`chat/completions`/`messages`/`responses`/`embeddings`), `source` (`api`/`telegram`/`max_chat`/`chat`), `session_id`, `total_cost` (rubles), `latency_ms`, `has_web_search`, `usage`, `provider`.

## Configuration

### Provider routing (`provider` object)

Passed on most inference endpoints to control which upstream provider serves the request:

| Field | Type | Default | Description |
|---|---|---|---|
| `order` | array<string> | — | Priority list of provider slugs, e.g. `["openai", "anthropic"]`. |
| `only` | array<string> | — | Whitelist; request only goes to these providers. |
| `ignore` | array<string> | — | Blacklist; never route to these providers. |
| `allow_fallbacks` | boolean | `true` | Retry a fallback provider if primary fails. |
| `country` | string | — | 2-letter country code to filter providers by geo policy. |

Provider slugs come from `ModelEndpoint.tag` in `GET /v1/models/{author}/{slug}/endpoints`.

### Session grouping

- `session_id` body field (max 256 chars) or `X-Session-Id` header.
- If both are set, the body value wins.
- Groups related requests (dialog, agent workflow) for analytics/activity.

### Cost reporting

- Synchronous/async responses expose `usage.cost` (rubles) where applicable (transcription, images, video).
- Binary responses (speech) return `X-Generation-Id`; fetch cost via `GET /v1/generation?id=<id>` → `total_cost`.

### Common generation parameters

| Parameter | Type | Default | Endpoints |
|---|---|---|---|
| `temperature` | number | varies | chat, completions, responses, messages, transcription |
| `stream` | boolean | `false` | chat, completions, responses, messages, images (SSE) |
| `session_id` | string | — | chat, responses, messages |
| `provider` | object | — | chat, responses, messages, speech, transcription, video, images |
| `response_format` | string | varies | speech (`mp3`/`pcm`, default `pcm`), transcription (`json`/`verbose_json`, default `json`) |

## Usage Patterns

### Chat completion with curl

```bash
curl https://routerai.ru/api/v1/chat/completions \
  -H "Authorization: Bearer $ROUTERAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek/deepseek-chat-v3.1",
    "messages": [{"role": "user", "content": "Привет, как дела?"}]
  }'
```

### OpenAI SDK compatibility

Point the base URL at RouterAI and keep the OpenAI SDK:

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://routerai.ru/api/v1",
    api_key="<ROUTERAI_API_KEY>",
)

resp = client.chat.completions.create(
    model="deepseek/deepseek-chat-v3.1",
    messages=[{"role": "user", "content": "Hello"}],
)
print(resp.choices[0].message.content)
```

### Anthropic Messages API (Claude Code / Anthropic SDK)

```bash
curl https://routerai.ru/api/v1/messages \
  -H "Authorization: Bearer $ROUTERAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "anthropic/claude-sonnet-4.6",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello, how are you?"}]
  }'
```

### Provider routing

```json
{
  "model": "anthropic/claude-sonnet-4.6",
  "max_tokens": 1024,
  "messages": [{"role": "user", "content": "Hi"}],
  "provider": {
    "only": ["anthropic"],
    "allow_fallbacks": false
  }
}
```

### Async video flow

1. `POST /v1/videos` → `202` with `id` + `polling_url`.
2. `GET /v1/videos/{id}` until `status == "completed"`.
3. `GET /v1/videos/{id}/content?index=0` → mp4.

### Cost lookup

After a request, read `X-Generation-Id` (or `id`), then:

```bash
curl "https://routerai.ru/api/v1/generation?id=$ID" \
  -H "Authorization: Bearer $ROUTERAI_API_KEY"
```

## Best Practices

1. **Use `GET /v1/models` (and the per-model `/endpoints` endpoint) before building a request** to discover `supported_parameters`, `supported_apis`, pricing, context length, and routing-priority order — capabilities vary per model and per provider.
2. **Use the OpenAI or Anthropic SDK** rather than hand-rolling HTTP; both are supported as drop-in clients via base URL override.
3. **Pin `provider.only` or `provider.order`** when a workflow depends on a specific provider's behavior; leave `allow_fallbacks` on only when provider-agnostic.
4. **Track cost by `X-Generation-Id`** (`GET /v1/generation` → `total_cost`) instead of estimating; prices are ruble-denominated and provider-specific.
5. **For video, always pass `callback_url`** (an absolute `https://` URL) instead of tight polling loops; the platform POSTs the job body on terminal status.
6. **For team provisioning, prefer invitations** (`POST /v1/team/invitations`) when the email may already exist, and reserve `POST /v1/team/members` for net-new accounts.
7. **Never return raw `key` values** from `POST /v1/keys` — the key value is shown only once at creation.
8. **Respect member invariants**: don't attempt to demote/deactivate/remove the owner or the last active admin (the API returns `422`).

## Common Pitfalls

- **Confusing base URL:** the OpenAPI `servers` URL is `https://routerai.ru/api`, but endpoints are under `/v1/…`; use `https://routerai.ru/api/v1` as the SDK/base URL.
- **Master key vs member key:** `/v1/keys*` and `/v1/team*` reject keys created by a `role=member` account (`403`). Create the master key in team settings.
- **Video is async, images are sync:** do not expect image-like instant responses from `/v1/videos`; poll or use `callback_url`.
- **Image `prompt` is optional only with `input_references`:** omitting both is invalid; model-specific fields (`aspect_ratio`, `resolution`, `size`, etc.) are silently limited to what the model supports.
- **`allow_fallbacks` can mask provider failures:** if exact-provider behavior matters, set `allow_fallbacks: false`.
- **`session_id` length cap:** over 256 chars is rejected; prefer the body field over the header when both are set (body wins).
- **Speech returns binary, not JSON:** don't JSON-parse the body; read `X-Generation-Id` for cost.
- **Team soft-delete:** `DELETE /v1/team/members/{id}` only deactivates the membership; expense history is retained.

## Version Notes

- OpenAPI `info.version`: `1.0.0`. The spec exposes no per-resource versioning or deprecation fields.
- The reference page uses Scalar's "modern" layout with `hideModels: true`; the authoritative machine-readable contract is `/api/openapi.json`.
