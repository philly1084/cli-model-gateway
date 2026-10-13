> Historical audit/proposal at published commit843ec4a or earlier. The local runtime follow-up is described in [manual catalog implementation](manual-catalog-implementation.md); it now adds manual entries to the examples but is not published or deployed.

# All-provider catalog follow-up — checked 2026-10-13

This local follow-up completes the provider scope omitted from PR23's first pass. It covers all 18 provider IDs in the union of the repository examples and mounted production configuration. No runtime YAML, mapping, default, allowlist, cap, credential, or routing code is changed. The 13 new records in provider-candidates-2026-10-13.json supplement the original five reference records; none is loaded. Some describe selectors already mounted in production but missing from the repository.

The sanitized provider-inventory-2026-10-13.json gives exact existing IDs by surface and actual read-only discovery results. Discovery used existing credentials only inside the gateway against configured official hosts, GET /models only, redirect rejection and 12-second deadlines. No inference. HTTP200 means catalog advertised, not successful generation. Moonshot and Groq returned401; no retry or credential change.

| Provider | Existing versus latest verified | Local addition / remaining boundary |
| --- | --- | --- |
| gemini-api (production only) | Mounted3.7/3.6Flash,3.1ProPreview,3.5Flash/Lite,3FlashPreview,3.1Lite; endpoint advertises4Argon and3.8Flash | Add4Argon,3.8Flash,3.6Flash,3.5Lite references; no runtime enablement |
| gemini-cli | Repository3.1Pro,3.5Flash,3FlashPreview,3.1Lite,2.5family | Google API discovery does not establish CLI/OAuth support; no guessed CLI mapping |
| gemini-flash-free | Repository3/3.5Flash,3.1Lite,2.5Flash/Lite | No free entitlement inferred from API model existence |
| gemini-audio | gemini-audio-flash maps2.5Flash | Native Live/TTS/transcribe IDs are different protocols; not silently substituted |
| kimi-code-api | Repo k3 plus incorrect Moonshot-style2.7 upstream IDs; mounted uses Code aliases correctly | Reference k3-256k and proposed gateway alias kimi-code-standard -> kimi-for-coding; currently K2.8Preview. Existing mappings untouched |
| kimi-code-cli | k3 and kimi-for-coding | Same Code family; installed ACP picker compatibility unverified; do not equate with Moonshot IDs |
| kimi-api | k2.6/k2.5; official Moonshot K3 and2.7Code lanes | Reference proposed gateway moonshot-kimi-k3 -> upstream kimi-k3 avoids Code selector collision. Account discovery401 |
| openrouter-free | Static list; six repo free aliases absent from current public461-model catalog | Five curated reference candidates, exact metadata snapshot. Paid Gemini/Kimi remain separate and excluded |
| groq-api | Compound/mini,OSS,olderLlama in repo; live alsoQwen3.6 | Qwen3.8-27b reference; account discovery401; unchanged narrow discovery whitelist |
| groq-whisper | whisper-large-v3 and erroneous whisper-v3-turbo upstream spelling | Correct documented upstream is whisper-large-v3-turbo; proposed mapping correction only, no change |
| codex-cli | GPT5.6 and older; mounted6.1Sol/Astra | Original four GPT6 references; configured0.161.0 model/list verified; no inference |
| deepseek-api | Live V4Flash/Pro; repo also retired aliases | Original deepseek-flash reference now confirmed by configured /models HTTP200 |
| grok-build-cli | grok-build local selector | Official current Grok4.7 does not prove installed CLI selector; no invented mapping |
| antigravity-cli | default local selector, repository only | Current product plans are not a CLI-ID contract; exact installed selection unknown |
| ollama-local | llama3.2,mistral,codellama,phi4,qwen2.5 | Library existence checked; local installed tags/hardware unknown; no downloads or cloud replacements |
| huggingface-whisper | whisper-large-v3/base | Hub repositories exist; large-v3/turbo have inference mappings, base does not in snapshot; adapter compatibility still unknown |
| huggingface-tts | SpeechT5,Bark,FastSpeech2 | Repositories exist but no inference-provider mappings in snapshot; existence does not certify hosted service |
| piper-tts-local | en_US-lessac-medium,en_GB-alan-medium,de_DE-thorsten-medium | Official voice registry confirms IDs; installed voice files unverified |

## Gemini and Kimi details

[Google catalog](https://ai.google.dev/gemini-api/docs/models), [lifecycle](https://ai.google.dev/gemini-api/docs/deprecations), [Argon](https://ai.google.dev/gemini-api/docs/models/gemini-4-argon), [3.8Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash), [migration](https://ai.google.dev/gemini-api/docs/latest-model), [CLI](https://geminicli.com/docs/cli/model/), all checked2026-10-13:

- Argon stable Oct13: unified1,048,576 input/thinking/output; ordinary synchronous output65,536. Long decode requires continuation/background support, not assumed here. Tools/structured output supported; explicit cache unsupported; sampling controls ignored.
- 3.8Flash input1,048,576/output65,536, tools/structured output. Minimal thinking errors; review adapter reasoning translation before activation.
- 3.7Flash is a deprecated alias to3.8;3.5Flash alias to3.6. These are not shutdown endpoints.2.5family restricted to prior active users, not generally deprecated.3.1Lite earliest shutdownMay7,2027. CLI --model does not constrain subagent models.

[Kimi Code models](https://www.kimi.com/code/docs/en/kimi-code/models.html), [release log](https://www.kimi.com/code/docs/en/kimi-code/whats-new.html), [Moonshot models](https://platform.kimi.ai/docs/models), [K3](https://platform.kimi.ai/docs/guide/kimi-k3-quickstart), [K2.7](https://platform.kimi.ai/docs/guide/kimi-k2-7-code-quickstart), checked2026-10-13:

- Code exact upstream IDs: k3,k3-256k,kimi-for-coding,kimi-for-coding-highspeed. Standard alias becameK2.8Preview Sept11; highspeed remainsK2.7. Do not invent a kimi-k2.8 ID.
- Configured Code discovery reports k3 andk3-256k262,144, standard1,048,576, highspeed262,144. Official K3 maximum1M depends on tier; retain observed account limit rather than replacing it with global maximum.
- Thinking disabled can redirect K3 toK2.8. Tools and multimodal support are upstream capabilities, not gateway end-to-end certification.
- Moonshot upstream uses kimi-k3 andkimi-k2.7-code/highspeed. K2.5 retiredAug31. Both repository samples wrongly send those2.7 names to Code endpoint; current live mappings use the correct Code aliases, but gateway name2.7 now labelsK2.8.

## OpenRouter selection and discovery

[Public catalog](https://openrouter.ai/api/v1/models), checked2026-10-13, returned461 entries both publicly and through configured GET. Exact selected context, supported_parameters, pricing and descriptions are in openrouter-discovery-2026-10-13.json. Prices are timestamped source data, not a budget guarantee.

Curated additions: poolside/laguna-s-2.1:free (262144; already live), nvidia/nemotron-3.5-lightning:free (1000000), thinkingmachines/inkling-small:free (1048576), cohere/north-mini-code:free (256000), google/gemma-4-31b-it:free (262144). Each has tools in supported_parameters and zero prompt/completion snapshot pricing. Poolside free promotion endsOct31; do not rely on it indefinitely.

Absent existing sample IDs: qwen/qwen3-coder:free,moonshotai/kimi-k2.6:free,openai/gpt-oss-120b:free,openai/gpt-oss-20b:free,meta-llama/llama-3.3-70b-instruct:free,qwen/qwen3-next-80b-a3b-instruct:free. Absence is not a dated retirement notice. Retained Nemotron3Super now advertises262144 rather than sample1M description. openrouter/pareto-code is not a free-price guarantee (dynamic pricing sentinel), despite residing in a provider named free.

Paid exact routes google/gemini-4-argon,google/gemini-3.8-flash,moonshotai/kimi-k3 are distinct from direct-provider IDs. No :free suffix invented; no paid route enabled.

Existing OpenRouter models are static, with discovery absent in repo and mounted file. resolveProviderModels discovers only when enabled or model list empty. Its merge follows discovered order, retains missing configured models, and discards context/tool/pricing metadata. Enabling it wholesale would admit paid/nonchat IDs, shift rankings, and fail to retire stale entries. Recommended future strategy: offline snapshot + reviewed explicit allowlist with exact pricing/tools/context/lifecycle checks, atomic routing migration; do not flip broad discovery on.

## Other dated primary sources

[Groq models](https://console.groq.com/docs/models), [deprecations](https://console.groq.com/docs/deprecations), [Qwen3.8](https://console.groq.com/docs/model/qwen/qwen3.8-27b), [speech](https://console.groq.com/docs/speech-to-text): Compound/mini shutdownSept21; Qwen3.6 stoppedSept14 for free/developer with enterprise exception; olderLlama stoppedAug16 for those tiers. Qwen3.8 preview131072context/16384output supports tools/vision/JSON. Do not broaden account entitlement after401.

[xAI models](https://docs.x.ai/docs/models), [Ollama library](https://ollama.com/library), [Whisper largeV3](https://huggingface.co/openai/whisper-large-v3), [Whisper turbo](https://huggingface.co/openai/whisper-large-v3-turbo), [SpeechT5](https://huggingface.co/microsoft/speecht5_tts), [Bark](https://huggingface.co/suno/bark), [FastSpeech2](https://huggingface.co/facebook/fastspeech2-en-ljspeech), [Piper registry](https://huggingface.co/rhasspy/piper-voices/blob/main/voices.json). All checked2026-10-13; local models were not downloaded or executed.

## Publication boundary

PR23 commitb63a03c already consumed its single approved CI run (passed68seconds). This follow-up is local and uncommitted. Draft pull_request synchronize jobs are gated off in current reviewed workflow, and feature push has no trigger; nevertheless recheck remote draft status and every workflow before proposing publication. No additional push, PR write, CI, inference, client upgrade or deployment is authorized by this follow-up.

Additional boundaries: [Grok Build](https://docs.x.ai/build/overview) and [Grok4.7](https://docs.x.ai/developers/grok-4-7) document the current product; installed grok-build remains unverified. [Antigravity's model table](https://antigravity.google/docs/models) lists current display names and November2 removal of older models, not an executable CLI mapping. [HF Inference documentation](https://huggingface.co/docs/inference-providers/providers/hf-inference) uses router.huggingface.co/hf-inference/models; this repository's legacy api-inference.huggingface.co adapter needs separate compatibility work. The adjacent huggingface-discovery snapshot preserves public evidence. Ollama's published newer qwen3.8/gemma4 tags are not added because installed weights, hardware and local-versus-cloud tags remain unverified.
