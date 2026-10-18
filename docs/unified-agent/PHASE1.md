# Unified agent phase 1

This is an experimental coordinator skeleton, disabled by default. The existing
gateway keeps its normal behavior. Nothing in this feature calls administrative
CLI endpoints, runs Docker, deploys, sends messages or changes infrastructure.

## Built

`src/agent/` contains AES-256-GCM envelopes and SOPS/static key providers; an
fsynced sealed JSONL hash chain with a single-writer lock; native and scripted
router clients; per-resource fencing leases; a concurrency/owner-limited worker
pool; in-process runner and pinned Docker argv builder; v2 handoff and v1
adapters; delegate tools; digest-bound single-use approval inbox; inbox notifier;
sealed layered memory and keyword retrieval; deterministic checker and sealed
child-process protocol; MAC receipt gate; coordinator replay and approval claims;
and an interval scheduler with injectable timers.

Workers stop at `awaiting_check`. The model-only development runtime sends
results through a separate checker process before accepting them. Completion
requires passing child and parent receipts. A checker failure parks for review.
No write-capable tool backend is implemented.

## Configuration

| Environment variable        | Default               |
| --------------------------- | --------------------- |
| AGENT_ENABLED               | false                 |
| AGENT_DATA_DIR              | agent-data            |
| AGENT_POOL_MAX              | 4                     |
| AGENT_KEYS_SOPS_FILE        | required when enabled |
| AGENT_CHECKER_KEY_SOPS_FILE | required when enabled |
| AGENT_APPROVAL_TTL_MS       | 86400000              |

Provision SOPS-encrypted key documents separately. The data document has a `keys`
object mapping `data` (and optionally older key ids) to base64-encoded 32-byte
keys. The separate checker document has `macKey` in the same encoding. This
repository deliberately includes no key values or recipient configuration.
SOPS must be installed for the enabled runtime. Decryption uses stdout in memory.

A data directory has one writer. Lock files hold only PID/nonce metadata. Stale
locks fail closed; an operator must reconcile interrupted work before removing
one. Back up the encrypted log and preserve old key ids for replay.

## Admin API

All routes are under `/admin/agent` and use the gateway admin key, via
`x-admin-key` or bearer authorization. They do not exist when disabled.

| Method | Suffix                               | Behavior                                 |
| ------ | ------------------------------------ | ---------------------------------------- |
| POST   | /submit                              | sealed task envelope, AAD `agent:submit` |
| GET    | /delegate/:id/status                 | state/event metadata                     |
| POST   | /delegate/:id/stop                   | cooperative stop                         |
| POST   | /delegate/:id/summarize              | router-generated summary                 |
| GET    | /delegate/:id/log?fromSeq=0&toSeq=10 | explicit untrusted raw-log range         |
| GET    | /inbox                               | approval items                           |
| POST   | /inbox/:id/approve                   | single-use approval and resume           |
| POST   | /inbox/:id/deny                      | deny a pending item                      |

No response includes raw logs except the explicit log route. In-memory response
content is untrusted. Configure transport and request-body logging appropriately
outside this prototype; task bodies must stay sealed.

## Offline validation

```sh
npm ci
npm run check
npm run build
npm test
```

The compiled test runner discovers `src/test/agent-core.test.ts` automatically.
Tests use random in-memory keys, scripted router output and in-process handlers.
The checker test spawns the compiled checker CLI with sealed stdin/stdout. Tests
never run Docker, SOPS, a provider, or a network request. Docker argv is compared
to the isolated profile. Store tests check plaintext markers are absent and
detect reordered ciphertext. Existing tests are unchanged.

## Off, stubbed and limits

- Docker execution, wrapped worker key exchange, real sandbox enforcement and
  hard-kill escalation are deferred. An in-process handler must cooperate with
  abort; it is a development mechanism, not isolation for untrusted code.
- Coding backend names are reserved but rejected. The enabled runtime only
  requests model text. It cannot perform approved side effects.
- The optional independent model checker is an injectable primitive; the process
  checker runs deterministic checks. A passing deterministic receipt verifies
  integrity and scans, not semantic correctness of arbitrary acceptance text.
- Checker failure goes directly to review; automated rework rounds and router
  backoff remain future work. Interrupted reads require explicit review after
  replay; uncertain writes require reconciliation.
- The scheduler is a tested primitive, not started by the runtime. AutoRun digest
  grants must be supplied by a trusted approval integration; the helper alone is
  not an authorization service.
- Memory promotion requires receipt provenance; richer caller verification and
  embeddings are deferred. No outbound notification implementation exists.
- No live-provider, SOPS integration, container or deployment checks run in P1.

The [design](DESIGN.md) describes P2 through P6: MCP write review, real containers,
live scheduling/notifications, coding backends and memory evaluation.
