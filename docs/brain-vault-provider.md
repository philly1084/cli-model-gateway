# Optional Brain vault provider transport

OpenAI-compatible providers may use `credentialBroker` instead of `apiKeyEnv`.
Exactly one credential source is required. Existing environment-backed providers
and CLI login flows retain their behavior. No providers.yaml migration is implied.

```yaml
credentialBroker:
  url: https://brain-provider-broker.internal:14482
  providerId: configured-provider-id
  certFile: /run/gateway-provider/client.pem
  keyFile: /run/gateway-provider/client-key.pem
  caFile: /run/gateway-provider/ca.pem
  serverFingerprint: REPLACE_WITH_VERIFIED_COLON_SEPARATED_SHA256
```

This fragment is intentionally incomplete. Use an operator-issued dedicated client
identity and a server certificate valid for the configured hostname. Brain must
pin the client to a fixed agent and provider binding. The gateway receives no
provider API key. It verifies the server CA, hostname and fingerprint, uses TLS
1.3, and sends only opaque request identities and the model payload.

Only model listing and buffered OpenAI chat completions are currently supported.
Images, native streaming and messages-protocol providers require separate adapters.
Do not replace working streaming routes with this transport yet. No retries or
redirects are followed. Broker failures are uncertain and stop registry fallback;
reusing the request ID permits Brain to reject duplicate execution after a lost
response. Reconcile unknown outcomes before issuing new IDs.

Limits: 1 MiB request, 4 MiB response, maximum 120-second request lifetime. TLS
private files require owner-controlled mounts and restrictive permissions. Follow
Brain's PROVIDER_VAULT documentation for explicit owner provisioning, revision
checks, revocation and journal persistence. Neither repository enables this path
on the cluster by default.

Validation: `npm run build` then `node --test scripts/test-vault-transport.mjs`.
Tests use ephemeral certificates and synthetic provider data only.
