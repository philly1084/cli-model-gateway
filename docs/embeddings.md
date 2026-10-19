# Embeddings

`POST /v1/embeddings` forwards to one administrator-configured OpenAI-compatible
upstream. `/openai/v1/embeddings` is equivalent. Both use the same Bearer or
`x-api-key` authentication, rate limits, and client keys as chat completions.

## Configuration

Set these environment variables on the gateway:

| Variable | Meaning |
| --- | --- |
| `EMBEDDINGS_UPSTREAM_URL` | Base URL including `/v1`, e.g. `http://embeddings.example.svc.cluster.local:11434/v1`. Unset disables embeddings. Only HTTP(S), without credentials, query, or fragment, is accepted. |
| `EMBEDDINGS_UPSTREAM_API_KEY` | Optional upstream Bearer key. Omit for an upstream that does not require authentication. |
| `EMBEDDINGS_TIMEOUT_MS` | Positive integer milliseconds, default `15000`; covers fetching and reading the response. |
| `EMBEDDINGS_MODELS` | Optional JSON array of model definitions; replaces the default catalog. |

Default catalog (also an example `EMBEDDINGS_MODELS` value):

```json
[{"id":"sentence-transformers/all-MiniLM-L6-v2","aliases":["all-minilm-l6-v2"],"upstreamModel":"all-minilm:l6-v2","dimensions":384}]
```

Each entry requires a non-empty `id` and `upstreamModel`, and positive integer
`dimensions`. `aliases` defaults to `[]`. IDs and aliases must be unique;
`auto` is reserved, and names cannot overlap configured chat model IDs.
Configuration errors fail startup without echoing the URL or model configuration.
When the upstream URL is unset, other embeddings settings are ignored.

Provision the upstream model separately. For Ollama, the gateway calls
`POST {base}/embeddings`, e.g. `/v1/embeddings`, with
`{"model":"all-minilm:l6-v2","input":"hello"}`. It does not use Ollama's native
`/api/embeddings` endpoint. No fallback or automatic model selection is performed.

## Requests and responses

Send to `https://router.example.com/v1/embeddings` with
`Authorization: Bearer REPLACE_ME`:

```json
{"model":"sentence-transformers/all-MiniLM-L6-v2","input":["hello","world"],"encoding_format":"float","dimensions":384}
```

`input` accepts one string or an array of strings. `encoding_format` defaults to
`float`. Optional `dimensions` must match the configured native dimension count.
`user` is ignored and is not forwarded. Aliases resolve to the canonical public ID.

The response has this shape (vectors abbreviated here; each real vector has 384 numbers):

```text
{
  "object": "list",
  "data": [
    {"object":"embedding","index":0,"embedding":[0.1, ...]},
    {"object":"embedding","index":1,"embedding":[0.2, ...]}
  ],
  "model": "sentence-transformers/all-MiniLM-L6-v2",
  "usage": {"prompt_tokens":3,"total_tokens":3}
}
```

Usage comes from valid upstream `prompt_tokens` and `total_tokens` when present;
otherwise both are estimated as `ceil(total input characters / 4)`. Upstream data
must contain exactly one vector per input, in input order, with exactly the native
dimensions and only finite numbers.

`GET /v1/embeddings/models` (also `/openai/v1/embeddings/models`) requires the
same authentication and returns:

```json
{"object":"list","data":[{"id":"sentence-transformers/all-MiniLM-L6-v2","object":"model","type":"embedding","dimensions":384}]}
```

Embedding models are separate from `/v1/models`, chat, responses, and `auto`.
Enabling embeddings does not add entries to the existing model discovery endpoint.

## Limits and errors

- Maximum 256 inputs; each must be non-empty, not whitespace-only, and at most
  8192 JavaScript string characters. Token arrays and base64 encoding are rejected.
- Maximum total JSON body: 512 KiB, including ignored fields; oversized bodies
  return HTTP 413. Invalid fields and input limits return HTTP 400.
- Missing/invalid client key: HTTP 401, same error as chat.
- Disabled: HTTP 404, code `embeddings_not_configured` (including model listing).
- Unknown model or chat model: HTTP 400, code `model_not_found`.
- Upstream non-2xx, redirect, or transport failure: HTTP 502, code `upstream_error`.
- Invalid JSON, wrong vector count/dimensions, non-finite/non-numeric values, or
  malformed usage: HTTP 502, code `upstream_invalid_response`.
- Timeout: HTTP 504, code `upstream_timeout`. Client disconnect also cancels the
  upstream request.

Errors use the OpenAI envelope `{error:{message,type,code}}`. Upstream bodies and
exception messages are never echoed. Existing HTTP metrics count requests by
endpoint and status. Embeddings execution logs contain only the public model ID,
input count, dimensions, latency, and status; no input text, vectors, or keys.

## Security and deployment

The intended upstream is an in-cluster service using plain HTTP. Restrict access
with network policy and cluster networking; HTTP does not encrypt the upstream
hop. Use HTTPS when that hop requires encryption. Keep the upstream internal;
do not add an upstream ingress. The gateway exposes embeddings only through its
authenticated `/v1` and `/openai/v1` API prefixes. Redirects are forbidden.

Store optional upstream and client keys in Secrets or environment injection,
never in manifests or committed config. The upstream key is never logged and is
sent only to the configured upstream, not to callers. API clients cannot choose
an upstream URL or use chat models through this endpoint.

The deployment uses `RollingUpdate` with `maxSurge: 25%` and
`maxUnavailable: 25%`. Commented environment examples show how to enable the
internal service and add a per-client key through a separate Secret reference.
