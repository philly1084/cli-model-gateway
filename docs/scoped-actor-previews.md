# Scoped actor preview images

`GATEWAY_BRAIN_SCENE_ACTOR_IMAGES=1` admits preview images for the
`gpt-6-astra` model on the `codex-cli` app-server adapter. It defaults off.
Only non-streaming chat-completions requests with a `brain_scene_preview`
marker are admitted. The marker must identify version 1, role `actor`, source
`scene_preview`, and the SHA-256, decoded byte size and MIME of every image.
Images must be in user messages and match that provenance. Authenticated callers
remain responsible for creating truthful provenance; the marker is not an
independent signature or a substitute for API authentication.

Only inline JPEG and PNG data URLs are accepted: at most four images, 300,000
decoded bytes per image, 600,000 bytes total. Remote URLs and filesystem paths
are rejected. Media signatures and canonical base64 are checked. Existing
request-body limits still apply. The Kimi image gate and transport are unchanged.

The bridge sends app-server `turn/start` image items using data URLs, with an
ephemeral thread, one attempt and no fallback. Bytes travel on stdin and are
excluded from the provider request file and debug logs; receipts contain counts
and byte sizes only. The existing temporary directory cleanup still runs.
Do not enable this flag globally or retain image bodies in operational logs.

Verification includes gate and provenance rejection cases, total/per-image caps,
Kimi isolation, and a real bridge process against an offline app-server fixture.
The fixture asserts the image item and ephemeral thread without a provider call.
