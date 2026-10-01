# API Key upstream provider and model metadata

This document maintains the routing, model-selection, credential, and Codex metadata contracts for the optional upstream provider. For the local access key, save-and-restart behavior, cleanup of ownership for earlier configuration, and manual client export, see [API Key mode](api-key-mode.md).

## Scope and routing

API Key access mode supports one OpenAI-compatible upstream provider. The upstream becomes available after a valid Base URL and proxy policy are configured and the current runtime can read an upstream key whose digest matches the configuration. Deleting the configuration disables the upstream. OpenAI forwarding mode does not read this configuration. There is no multi-provider mode, load balancing, or provider failover after a request failure.

The local Web namespaces are `chatgpt-web/*` and `chatgpt-web-continuity/*`. They always belong to local models and browser routing; an upstream model with the same name cannot override them. The continuity prefix uses the same namespace isolation. For its session contract, see [Session continuity](session-continuity.md).

| Request | When upstream is available | When upstream is unavailable |
| --- | --- | --- |
| `/v1/models` | Merge the local catalog with upstream models that are selected and discovered in the current request | Return the local catalog |
| Non-Web `/v1/responses`, `/v1/responses/compact` | Verify that the model exists in loaded `config.models[]`, then forward it | Reject non-Web models |
| `/v1/alpha/search`, `/v1/images/generations`, `/v1/images/edits` | Forward after local API Key authentication; model selection does not restrict these endpoints | Return `endpoint_not_supported` |
| Local Web model requests | Always use the existing Web adapter, MCP, continuation, compaction, and cancellation paths | Same |

Every `/v1/*` request first validates the local Bearer. If the upstream key is unavailable, local Web routing still works, but the server must not substitute official OpenAI credentials, the client key, or another credential. The Launcher reports that the upstream key must be entered or applied again.

Upstream 4xx/5xx responses are returned according to the forwarding contract; network failures return a safe `upstream_error`. Except for falling back to the local catalog when catalog discovery fails, the service does not automatically switch to official OpenAI or ChatGPT Web and does not replay image or other side-effecting POST requests automatically. Before a request crosses the local Web provider boundary, local-only reasoning/compaction wrappers are removed while the existing request-body, SSE, and response-header handling boundaries remain.

## Configuration and activation

The Base URL is an HTTP or HTTPS API root and can contain a fixed path prefix, for example `https://provider.example/v1`. Appending `models`, `responses`, and other endpoints preserves that prefix. Relative URLs, empty hosts, userinfo, query strings, fragments, and control characters are rejected.

Upstream configuration uses a separate private `upstream-provider.json`; it does not extend version 1 of the local-authentication `api-access.json`. The current configuration shape is:

```ts
type MetadataMode = "upstream" | "default" | "fallback";
type UpstreamModelConfig = {
  id: string;
  metadata?:
    | { mode: MetadataMode }
    | { mode: "custom"; baseMode: MetadataMode; overrides: Record<string, unknown> };
};

type UpstreamProviderConfig = {
  version: 2;
  baseUrl: string;
  apiKeySha256: string;
  proxy: { mode: "global" } | { mode: "direct" } | { mode: "custom"; url: string };
  models: UpstreamModelConfig[];
  supportsOpenAiServerCompaction: boolean;
};
```

The configuration is written atomically, has a fixed size limit, and rejects unknown fields and damaged structures. Model IDs are validated, de-duplicated, and stored in a stable order. A local Web namespace cannot be selected. `apiKeySha256` binds the secure-storage copy and the configuration identity; it is not the upstream authentication value.

The configuration is saved first, then a controlled restart is attempted. Active HTTP, browser, or MCP work is not force-cancelled. The Launcher does not force-stop an externally managed daemon. Stop/start failures do not roll back the saved intent and must not be reported as active. The daemon loads configuration and key once at startup and does not replace them online.

Health data contains only non-sensitive load state, key-match state, and an HMAC revision calculated with the management token. The revision covers the endpoint, proxy, key digest, all selected models, metadata configuration, and the compaction-capability declaration. A revision from an old daemon cannot prove that a new setting has been loaded.

## Discovery, selection, and catalog publication

The Launcher's **Fetch models** action is explicit. Opening Settings or polling status does not request the upstream catalog. The request uses the draft Base URL, proxy, and a newly entered key. If the draft contains no new key, the main process may reuse the matching saved key only when the draft's baseline revision is still current and the draft Base URL is identical to the Base URL saved in that revision. An old key must not be sent to a modified draft address.

A fetch result updates only temporary candidates. It does not save configuration, change the revision, or restart the daemon. Failure does not clear existing selection or metadata and does not reuse an old fetch result as if the current request succeeded. Adding a new model requires successful discovery evidence. Search filters only the visible candidate list; it does not change the selected set.

`data[].id` and `models[].slug` are independent discovery sources. If one source has an invalid structure, the other can still be used. The whole catalog fails only when both sources are unusable. Invalid rows are ignored. Within a valid slug row, an invalid metadata field is ignored independently so that it does not invalidate other valid fields in the same row or other models. IDs must be non-empty, contain no control characters, contain no leading/trailing whitespace, and stay within the project limit. Duplicate IDs are collapsed and cannot be used to bypass field validation or trust boundaries.

**Routing authorization and catalog visibility are separate.** `models[]` in the loaded v2 configuration is the only upstream-model allowlist. Every Responses/compact request checks this allowlist; directly entering an unselected model ID cannot bypass it.

The catalog publishes only upstream models in `selected ∩ successfully discovered in this request`. A selected model that is missing from the current successful discovery keeps its saved configuration and routing authorization, so the upstream can decide whether a direct request still works, but no catalog row is fabricated. If the whole catalog request fails, `/v1/models` still returns HTTP 200 with a fresh local catalog and does not reuse a stale upstream catalog. The Launcher distinguishes **successful discovery but this model is missing** from **catalog request failed**.

This separation preserves the user's explicit selection while preventing one catalog failure from deleting configuration. Filling metadata from bundled or fallback sources does not prove that the remote model still exists.

## Metadata modes and sources

The automatic default follows this precedence: valid upstream metadata, exact-slug bundled metadata, then the project's conservative fallback. Automatic state is represented by the absence of a `metadata` override; it does not add a fifth visible mode.

| Matching `models[]` row exists now | Exact slug exists in bundled metadata | Available modes | Automatic default |
| --- | --- | --- | --- |
| Yes | Yes | Upstream / Default fill / Fallback fill / Custom | Upstream |
| Yes | No | Upstream / Fallback fill / Custom | Upstream |
| No | Yes | Default fill / Fallback fill / Custom | Default fill |
| No | No | Fallback fill / Custom | Fallback fill |

`upstream` starts from an exact bundled baseline or the generic baseline, then absorbs valid upstream fields that are allowed to override project-owned values. `default` uses only exact bundled metadata and ignores upstream metadata; it does not infer by name prefix, family, or similarity. `fallback` uses only the project generic baseline. A partial upstream row with a valid slug can still provide an Upstream source, but it cannot be passed to Codex without completion.

The generic baseline uses the model ID as its display name, empty reasoning/tools arrays, `priority: 99`, `support_verbosity: false`, and `bytes / 10000` truncation. Its shell is `unified_exec` in Full mode and `disabled` otherwise. Instructions are project-owned. The project does not guess context window, default reasoning level, search, image, or multi-agent capability for an unknown model.

Persisted configured mode and current effective mode are separate. Losing a source does not rewrite the user's configuration. `upstream` degrades to exact bundled metadata and then generic metadata; `default` degrades to generic metadata. The UI keeps the configured value visible, marks the source unavailable, and shows the effective fallback. An unavailable configured source must not be presented as a currently selectable valid option.

### Custom mode and safe degradation

Custom metadata persists `baseMode + overrides`. The base mode is not recomputed from the automatic default on every load. Missing fields inherit from the base; `null` is valid only when the target schema allows it. Object and array values replace the whole field; there is no implicit deep merge.

When custom metadata is created or modified, unknown fields, wrong types, and protected fields are rejected, and the final complete `ModelInfo` must pass validation. Failure preserves the previous saved configuration. If the base source later becomes unavailable, the resolver first obtains that base mode's valid fallback and then applies the saved overrides. If the result is valid, it continues to use the custom result while reporting degradation. If it is invalid, the runtime uses the valid baseline without the overrides and marks the custom configuration for repair.

An older custom configuration that becomes invalid after a schema upgrade must still be structurally readable and preservable without modification. When another setting is changed, the main process compares that custom value against the authoritative optimistic revision and can round-trip it unchanged. It must not trust a renderer claim that an arbitrary value is "old". Once the custom value itself is edited, it must pass the current validation. Degradation must not silently delete user intent and must not publish an invalid result.

## Codex schema and project instruction boundary

Every published model always satisfies `slug == selected ID`, `visibility == "list"`, and `supported_in_api == true`. The following Agent-control metadata can come only from trusted project bundled or generic baselines:

```text
base_instructions
model_messages (the entire object and any future fields)
include_skills_usage_instructions
include_plugin_usage_instructions
include_apps_usage_instructions
```

Upstream values for these fields are ignored; custom attempts to override them are rejected. Project invariants are applied again after merging. Protecting only the `instructions_template` leaf is not sufficient because other policy fields in `model_messages` could cross the trust boundary.

Bundled data and the `ModelInfo` field/type schema are tied to the same immutable Codex source lock. `models.json` is a data source and cannot define the complete schema by "which keys appear". Upstream-field recognition, custom validation, and the final full validator share the generated schema. Dynamic catalog generation, Launcher preview, and static export share the same normalizer or consume its final result. Runtime does not fetch metadata online and does not require Codex source code on the user's machine.

Generated artifacts are rooted at [generated](../launcher/electron/generated/codex-source-lock.json) and synchronized by the [generation script](../scripts/generate-codex-model-artifacts.ts). When the target revision changes, bundled metadata and schema must be regenerated together; exact slugs must remain unique, full rows must validate, and repeated generation must be stable. Release validation must use the real Codex parser tied to the same source lock through the [smoke test](../scripts/smoke-codex-catalog.ts). An arbitrary local binary, or a binary that only reports the same version string, does not prove parser identity.

## Export and compaction capability

Static `api-key-models.json` stores the normalized `models[]` from the exact local `/v1/models` response that the export flow fetched and validated. It does not perform a second partial-row merge. Export verifies both the API-access revision and upstream-configuration revision. The static file must equal the dynamic result consumed by that export, but it does not have to equal a later remote catalog fetched under the same configuration revision: configuration identity is not remote-catalog snapshot identity.

`supportsOpenAiServerCompaction` defaults to `false`. It declares that the upstream truly supports the Responses `compaction_trigger` / remote compaction v2 protocol; it does not mean only that `/responses/compact` exists. When explicitly enabled by the user, the exported provider `name` is exactly `OpenAI` so that Codex detects the capability. Provider ID, local Base URL, independent authentication, and Web routing do not change. The setting is never inferred from a brand, model name, or endpoint probe. Non-Web compaction still checks selected models; Web compaction is not sent to the third-party upstream.

Codex TOML is a sensitive export that contains the local service API Key through `experimental_bearer_token`; it does not emit `env_key` at the same time. The GUI must recover a key whose digest matches the current policy. The CLI reads `CODEX_CHATGPT_WEB_API_KEY` from the current process and validates it. A missing or stale plaintext key cannot produce placeholder configuration. The upstream API Key never enters this TOML.

Codex process proxy variables are exported separately from TOML. Only the Launcher global proxy is exported, together with a merged and de-duplicated loopback `NO_PROXY`. Upstream `custom` / `direct` are server-side policies and are not passed to the client. A proxy environment containing userinfo and a bearer-containing TOML are both sensitive data and must not enter normal logs, diagnostics, or persistent renderer state.

## Network and credential boundaries

The upstream API Key is strictly separate from the local client key, daemon control token, official login credentials, and Tunnel credentials. An upstream key only has to be non-empty, contain no CR/LF/NUL, and stay at or below 4,096 characters; it does not use the local key character-set restriction. Forwarding always sets upstream `Authorization: Bearer` explicitly and does not pass inbound Authorization, Proxy-Authorization, x-api-key, Cookie, ChatGPT account headers, or organization/project authentication headers directly to the upstream.

The upstream key uses its own OS-encrypted vault. On Linux, `basic_text` / `unknown` do not count as secure storage. When secure persistence is unavailable, the key stays only in the current Launcher session memory and is not downgraded to a plaintext file. A copy with a mismatched digest cannot be reused, and deleting the provider configuration clears the related vault. The key is decrypted only when starting the daemon and is injected into that child process through the dedicated `CODEX_CHATGPT_WEB_UPSTREAM_API_KEY`. The Launcher must not modify global `process.env` in a way that lets the Tunnel, browser, or MCP helper inherit it. An externally managed daemon must provide a matching key itself.

| Policy | Network boundary |
| --- | --- |
| `global` | Consume the existing global proxy; when none is configured, keep normal system/process proxy resolution |
| `direct` | Force a direct connection for this request, ignoring global, system, and proxy environment state without changing the process environment of concurrent requests |
| `custom` | Use only the specified HTTP/HTTPS proxy; do not fall back to global or system proxy handling |

A dedicated proxy accepts only HTTP/HTTPS URLs validated by `normalizeUpstreamProxyUrl`; SOCKS is not supported. Proxy userinfo follows the private plaintext-configuration boundary of the [global proxy](network-proxy.md). The global Electron authentication-cache switching transaction is not the same as the upstream per-request proxy policy. Normal logs, health data, and errors do not expose upstream/proxy URLs, hosts, ports, or credentials.

The accepted risks are that an upstream can use remote plaintext HTTP, which can expose the request and upstream key in transit, and that proxy userinfo can exist in a private readable configuration file. These exceptions do not allow the upstream key to be stored as plaintext and do not change the [remote deployment](../deploy/server/README.md#network-contract) requirement that public `/v1` and desktop entry points use HTTPS.

## Explicit retirement of legacy v1 configuration

The accepted model-metadata design replaces legacy `all / regex / selected` configuration with v2 explicit selection. v1 is not migrated and is not executed as a compatibility mode. Detection applies only to a file that successfully parses as a JSON object with `version === 1`. Damaged JSON or an unknown version must fail closed and must not be deleted as v1.

The storage layer first writes a non-sensitive `upstream-provider-reset.json` with `reason: "legacy-v1-removed"`, then removes the legacy provider file. Core/CLI/runtime immediately treats the provider as unconfigured; it does not wait for the Launcher to start before dropping old authorization. After the Launcher consumes the marker, it clears the old upstream vault and then removes the marker. Cleanup must finish before a new v2 configuration is saved, so that an old key is not reused and a later cleanup cannot erase the new key.

The user must fetch models again, select them, and save v2 configuration. Old regex patterns, model lists, and keys are not migrated automatically. Local API access configuration, the main key vault, and other settings are not deleted. If marker creation or legacy-file removal fails, v1 still is not executed and the UI reports an actionable cleanup error.

This destructive upgrade gives routing permission one explicit source. Writing the marker before deleting the old file also preserves crash-recovery evidence for old-credential cleanup. Future maintenance must not reinterpret the retired filtering semantics as a current compatibility contract.

## Implementation and validation entry points

The current implementation is in [provider](../src/upstream-provider.ts), [configuration storage](../src/upstream-provider-config.ts), [catalog](../src/upstream-model-catalog.ts), [shared metadata](../launcher/electron/codex-model-metadata.cjs), [network](../src/upstream-network.ts), [forwarding](../src/upstream-passthrough.ts), and [Codex export](../src/api-key-codex-config.ts). Launcher [configuration](../launcher/electron/upstream-provider-config.cjs), [discovery networking](../launcher/electron/upstream-provider-network.cjs), and [vault](../launcher/electron/upstream-api-key-vault.cjs) define the trusted main-process boundary.

[Provider tests](../tests/upstream-provider.test.ts), [network tests](../tests/upstream-network.test.ts), [API server tests](../tests/api-key-server.test.ts), and [metadata tests](../launcher/tests/codex-model-metadata.test.cjs) cover repeatable component contracts. Release acceptance for real third-party upstream providers, the system keyring, proxies, and the target Codex parser is listed in [Release validation](release-validation.md#api-access-upstream-and-proxy-validation); historical pass counts from implementation reports do not replace it.
