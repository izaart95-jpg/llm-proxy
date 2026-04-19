# LLM Universal Proxy

A production-grade Node.js proxy that bridges the three major LLM API conventions:

| Endpoint | Convention | Used by |
|---|---|---|
| `/v1/chat/completions` | OpenAI Chat Completions | OpenAI SDK, LiteLLM, LangChain, most OSS tools |
| `/v1/messages` | Anthropic Messages | Anthropic SDK, Claude clients |
| `/v1/responses` | OpenAI Responses API | OpenAI SDK v5+, Agents SDK |

Any client hitting any of those endpoints is **automatically translated** to whichever format your backend actually speaks — including full bidirectional streaming support.

---

## Quick Start

```bash
npm install

# Point at an OpenAI-compatible backend
BACKEND_URL=https://api.openai.com \
BACKEND_FORMAT=chat \
BACKEND_API_KEY=sk-... \
node index.js

# Point at Anthropic
BACKEND_URL=https://api.anthropic.com \
BACKEND_FORMAT=messages \
BACKEND_API_KEY=sk-ant-... \
node index.js

# Point at a local Ollama instance
BACKEND_URL=http://localhost:11434 \
BACKEND_FORMAT=chat \
node index.js
```

The proxy starts on port **4000** by default.  
Open **http://localhost:4000** for the live dashboard.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PROXY_PORT` | `4000` | Port to listen on |
| `BACKEND_URL` | `https://api.openai.com` | Base URL of the LLM backend |
| `BACKEND_FORMAT` | `chat` | Endpoint format the backend exposes: `chat`, `messages`, or `responses` |
| `BACKEND_API_KEY` | _(empty)_ | API key forwarded to backend. If unset, passes through `Authorization` / `x-api-key` from client. |
| `ANTHROPIC_VERSION` | `2023-06-01` | `anthropic-version` header sent when targeting Anthropic |

---

## Usage Examples

### OpenAI SDK → Anthropic backend

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:4000/v1", api_key="any")

# This hits /v1/chat/completions on the proxy
# The proxy translates it to /v1/messages for Anthropic
response = client.chat.completions.create(
    model="claude-3-5-sonnet-20241022",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True,
)
for chunk in response:
    print(chunk.choices[0].delta.content or "", end="")
```

### Anthropic SDK → OpenAI backend

```python
import anthropic

client = anthropic.Anthropic(base_url="http://localhost:4000", api_key="any")

# This hits /v1/messages on the proxy
# The proxy translates it to /v1/chat/completions for OpenAI
message = client.messages.create(
    model="gpt-4o",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}],
)
print(message.content[0].text)
```

### OpenAI Responses API → Anthropic backend

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:4000/v1", api_key="any")

# This hits /v1/responses on the proxy
# The proxy translates it to /v1/messages for Anthropic
response = client.responses.create(
    model="claude-3-5-sonnet-20241022",
    input="What is the capital of France?",
)
print(response.output_text)
```

### Streaming (any combination)

All three endpoints fully support streaming. The proxy translates SSE event formats in real time, including:

- OpenAI `data: {...}` / `data: [DONE]` chunks
- Anthropic `event: content_block_delta` / `event: message_stop` events
- OpenAI Responses `response.output_text.delta` / `response.completed` events

---

## Architecture

```
Client Request
    │
    ▼
┌─────────────────────────────────────────┐
│  Detect inbound format from URL path     │
│  /v1/chat/completions → "chat"           │
│  /v1/messages         → "messages"       │
│  /v1/responses        → "responses"      │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│  Parse inbound body → internal format   │
│  (normalised message array + metadata)  │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│  Build outbound body for BACKEND_FORMAT │
│  chat / messages / responses            │
└────────────────┬────────────────────────┘
                 │
                 ▼
         Backend LLM Server
                 │
                 ▼
┌─────────────────────────────────────────┐
│  Streaming?                             │
│  YES → parse SSE stream, translate      │
│        each chunk to client format      │
│  NO  → parse full response, translate   │
└────────────────┬────────────────────────┘
                 │
                 ▼
         Client Response
```

---

## Runtime Config Update

```bash
# Switch backend without restarting
curl -X PATCH http://localhost:4000/config \
  -H 'Content-Type: application/json' \
  -d '{"backendUrl":"https://api.anthropic.com","backendFormat":"messages","apiKey":"sk-ant-..."}'
```

---

## Running Tests

```bash
node test.js
```

Tests cover all 6 inbound parsers, 3 outbound builders, 6 non-streaming response translators, 6 streaming chunk translators, and 3 roundtrip scenarios (30 tests total).

---

## Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions |
| `POST` | `/v1/messages` | Anthropic Messages |
| `POST` | `/v1/responses` | OpenAI Responses API |
| `GET` | `/v1/models` | Passthrough to backend |
| `GET` | `/health` | Stats + config |
| `GET` | `/config` | Current config (key redacted) |
| `PATCH` | `/config` | Live config update |
| `GET` | `/` | Dashboard UI |