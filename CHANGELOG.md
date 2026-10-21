# Changelog

## Unreleased

- Accept OpenRouter's repeated terminal choice on usage trailers when the finish matches and no new output is present. Preserve usage and emit one client finish followed by `[DONE]`; continue rejecting changed finishes, post-finish output and incomplete streams. Add the captured 50-chunk/double-stop shape as a mocked `/v1/chat/completions` regression.
- Remember auth-failed providers for the entire request in both buffered and streaming fallback paths. Skip their sibling models without dispatch, retain the original model's remaining fallback candidates across failed branches, and follow blocked siblings' fallback edges. Auth failures have no same-provider retry; mocked Moonshot 401 tests prove recovery through a working provider even after shared cooldown expiry.

- Repair ordinary Brain chat streaming through OpenAI-compatible providers: tolerate SSE comments, empty choices, usage trailers and vendor extensions; preserve content and require terminal evidence. Vendor `reasoning`/`reasoning_details` stay opaque; existing DeepSeek `reasoning_content` and tool/signature handling remain supported.
- Decode object and Gemini array error envelopes into sanitized status/code errors for buffered and streamed requests. Classify 401/403 as auth, 404 as model_unavailable, and 429/503 as transient. Log status and safe codes without upstream messages, prompts or credentials.
- Apply configured fallbacks before ordinary chat output starts, including buffered CLI/Kimi Code fallbacks. Skip auth-blocked provider siblings, allow one 150ms retry for transient failures, and honor cancellation, deadlines and attempt limits. Tool/session streams, uncertain delivery and partial output are not replayed.
- Add mocked Brain-format HTTP/SSE regression tests. No model additions, dependency changes, unified-agent changes or deployment changes.

Provider catalog note: the Oct 21 diagnosis reports `z-ai/glm-5.2:free` is no longer free upstream. That ID is absent from this checkout's example configuration; no paid replacement was added. This note uses the supplied diagnosis, without network verification.
