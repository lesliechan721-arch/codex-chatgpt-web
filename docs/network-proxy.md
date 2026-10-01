# Global network proxy

Launcher supports one global HTTP or HTTPS proxy, with optional URL userinfo authentication.
It does not support SOCKS5 or start a protocol-conversion proxy. Clearing the setting restores the
Electron system proxy and the child-process proxy environment inherited when Launcher started.
Custom upstream `global`, `direct`, and `custom` policies are described separately in the
[upstream provider guide](upstream-provider.md#network-and-credential-boundaries).

## Configuration and credential boundary

Supported forms include `http://host:port`, `https://host:port`, and their
`scheme://user:password@host:port` equivalents. The existing input displays the saved full URL;
status, logs, errors, and diagnostic exports must not expose the endpoint or credentials.

Input is limited to 2,048 characters. It must use an HTTP/HTTPS authority and a nonempty host.
The raw suffix after the authority can only be empty or `/`. Reject paths, dot-segment forms,
backslashes, query/fragment markers even when empty, control characters, and malformed slash
forms before URL normalization can conceal them. Schemes are case-insensitive.

Encode special username/password characters with URL percent encoding. Decode each field once;
reject malformed encoding and a nonempty password with an empty username. A nonempty username
can have an empty password. Normalize host case, IPv6 brackets, and default ports consistently;
implicit and explicit HTTP 80 or HTTPS 443 identify the same challenge endpoint.

Child-process proxy variables contain the complete configured URL. Electron `session.setProxy`
receives the URL without userinfo. The proxy-authentication handler supplies decoded credentials
only for a Basic proxy challenge from the current ChatGPT browser partition, with a real
`webContents` and the exact current normalized proxy host and port. It does not intercept ordinary
website authentication, another partition, an old proxy, another endpoint, or another scheme.
Unmatched challenges use the existing default cancellation path, not a new interactive prompt.

The full URL, including credentials, uses the existing private Launcher state file: file mode
`0600` and directory mode `0700` where supported. It is not field-encrypted by an OS keychain.
Code with the current OS user's file access or trusted renderer execution can therefore read it.
This accepted proxy-storage boundary does **not** permit plaintext fallback for local or upstream
API key vaults. Treat copied proxy environment values as sensitive exports.

Authentication covers the embedded browser and Responses runtime. The MCP Tunnel receives the
same proxy environment, but its authentication support depends on the Tunnel implementation;
this project does not promise authentication support for every Tunnel implementation.

## Switching and failure handling

Do not change the proxy during an active ChatGPT turn or Launcher lifecycle operation. A normal
change updates the process environment, applies the Electron proxy, closes old connections,
restarts the configured runtime, and then persists the setting. Each Electron application,
including initial setup, clearing, and rollback, uses this order:

```text
disable credentials -> await clearAuthCache -> setProxy
                    -> enable matching credentials -> closeAllConnections
```

A later failure restores the old environment, proxy, and matching authentication state. If proxy
rollback fails, credentials remain disabled rather than being sent to an uncertain endpoint.

An authentication-cache clearing failure has a stronger fail-closed contract. Do not persist the
new setting or enable credentials. Restore the exact pre-transaction proxy environment, destroy
the proxy browser consumers, and request forced shutdown of the existing managed runtime.
Use only a fixed safe fatal message, not the underlying endpoint-bearing exception.

Launcher exits nonzero only after shutdown reports `stopped` or `forced`, or when no supervisor
has yet been created. A `forced-partial` result or thrown shutdown error leaves Launcher alive to
supervise any unconfirmed child processes, with no surviving proxy browser consumers. Preserve
Tunnel PID ownership and use the current valid Full/Tunnel configuration or the last successfully
validated one to resume monitoring. A browser-only configuration cannot replace that cached
Tunnel contract. Without a valid contract, keep the failure and ownership evidence; do not claim
monitoring was restored. A later ordinary quit must check shutdown again before committing exit.

This safety-first choice can interrupt work when cached credentials cannot be cleared. Exiting
while children might still use the old credential state would conceal that risk rather than fix it.

## Diagnostics and maintenance

Redaction uses a bounded registry of inherited, previous, current, and candidate proxy endpoints.
It removes registered full URLs, userinfo-free endpoints, bare hosts, and relevant port forms even
after the proxy changes or is cleared. Unrelated ordinary URLs keep their existing log behavior.
The editable input is not a license to include its value in state summaries or errors.

The accepted scope is HTTP/HTTPS authentication using the existing proxy input and private-state
model, without SOCKS conversion or additional proxy dependencies. The precise challenge match
prevents disclosure to another browser session or endpoint; explicit cache clearing prevents a
previous proxy's authentication from surviving a switch.

See [URL and authentication rules](../launcher/electron/network-proxy-config.cjs),
[proxy transactions](../launcher/electron/network-proxy.cjs),
[Launcher integration](../launcher/electron/main.cjs),
[proxy tests](../launcher/tests/network-proxy.test.cjs), and
[controller tests](../launcher/tests/network-proxy-controller.test.cjs).
Packaged Electron, secure storage, and real network checks remain part of
[release validation](release-validation.md#api-access-upstream-and-proxy-validation).
