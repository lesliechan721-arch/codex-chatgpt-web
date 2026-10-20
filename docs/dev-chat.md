# DEV chat harness

The repository DEV chat exercises current source code without routing the native Codex app through
that working tree. It is intended for browser, MCP, tool-round, retry, and compaction development
while the normal launcher, its ChatGPT account, and the maintainer's active Codex session remain
usable.

## Prerequisites

- Use the repository-pinned Bun version.
- Install a launcher built from the same working tree.
- Start the isolated launcher with `bun run dev:launcher`.
- It skips the normal marketing onboarding and opens the setup surface directly. Sign in inside the
  window labelled **DEV**. This may be a different ChatGPT account.
- Run its browser smoke test and initialize the DEV profile. Complete MCP setup only when testing
  simulated tool rounds; browser, effort, context-limit, and compaction work in browser-only mode.
  The launcher stores any MCP credentials only in the DEV home and supervises only that isolated
  tunnel. Create `Codex Native5 DEV` as a new ChatGPT plugin; keep production `Codex Native5`
  separate. Preserve `Codex Native4 DEV` and earlier retired connectors unchanged. Never rename
  or refresh an old DEV connector. Setup preserves custom names that are not retired defaults;
  a custom plugin with an old cached schema needs a newly named plugin. Complete the required
  configuration steps. **Verify runtime** is optional for troubleshooting; when requested, it checks
  the installed schema and requires six successful read-only context returns over fixed small text,
  with ordinary and independent compaction credentials. Zero Risk keeps manual selection, Send,
  start, and its Sent policy. This proves callability, not raw cloud schema or image understanding.

The equivalent repository command is `bun run src/cli.ts verify-context --dev-profile` with the
matching DEV Launcher signed in and its isolated tunnel running. Production verification uses
`codex-chatgpt-web verify-context` and never shares its result with DEV. The historical long-wait
probe contract does not expose the three context tools and cannot pass this check. Use the normal
DEV MCP contract and a newly created identity for context navigation; verification does not change
the configuration, rename a plugin, or refresh its remote cache. Bound
profile/mode/plugin/tunnel/runtime/schema changes affect diagnostic comparison only; there is no
time-based expiry. DEV tasks, navigation, compaction, and recovery do not require a saved result
or run diagnostic calls automatically. Production follows the same rule with its own configuration
and credentials. Failure or cancellation of diagnosis does not clear completed configuration.
If an existing DEV profile retains the long-wait probe flag on `Codex Native5 DEV`, select a new
custom identity through normal DEV setup, for example
`bun run src/cli.ts dev setup --full --automatic-browser-interaction --connector-name-suffix "Native5 DEV Context"`.
Create `Codex Native5 DEV Context` as a new ChatGPT plugin on the configured DEV tunnel.
Run Verify runtime if a diagnostic check is useful. This custom name selects the normal native
contract; the old probe plugin remains unchanged. Omitting the probe flag alone does not clear a
previously stored probe configuration.

Nothing is copied from the normal launcher. The DEV command fails closed if its own launcher,
browser descriptor, credentials, or connector are not ready. It never falls back to the production
profile, another model, a fake browser, or a second connector.

## Run

One browser-only message:

```bash
bun run dev:launcher
bun run src/cli.ts dev status
bun run dev:chat smoke "Reply with exactly: DEV READY"
```

Persistent interactive chat:

```bash
bun run dev:chat compaction-lab
```

After optional Full/MCP setup, the same command also exposes simulated outer tools:

```bash
bun run dev:chat tool-lab "Use a command tool and explain the simulated receipt"
```

The direct DEV tool `mcp__dev_simulator__large_context_payload` accepts the explicit arguments
`segment` (1, 2, or 3) and `target_tokens` (1,000 to 95,000). It returns deterministic, coherent,
inert prose through the real simulated MCP-result path so a live named chat can exercise retention
and automatic compaction without embedding a giant fixture in the user prompt. It is advertised
directly rather than through deferred tool search so the test can prove the requested call happened.

The direct DEV tool `mcp__dev_simulator__image_probe` accepts only `image_id` (the integer 1, 2,
or 3). It returns one inert PNG fixture through the actual Responses tool-result and MCP image
path. Each fixed 720 × 240 image contains its own visual information. Repeated IDs return identical
bytes. Descriptions do not reveal visual answers. Probe receipts and tool events contain image
metadata only; canonical chat history retains the image. The tool reads no user files and needs no
image attachment. Other outer tools retain
their simulation behavior. This probe uses the existing connector ABI.

Use a fresh Full/MCP named chat for each Automatic and Zero Risk A14 check:

```text
In this same response, call mcp__dev_simulator__image_probe in order with image_id 1, 2, 3, 1.
After each call, read the complete number from the returned image itself. Do not infer it from
metadata. After all four calls, list the four numbers in call order and state whether the first
and fourth match. Do not use other tools.
```

Record the model and mode, connector and transport, effective input budget, PNG dimensions, byte
counts and digests from receipts, call count, elapsed time, actual output, and observed attachment
uploads. Keep evidence that all calls occur in one Web response. In Zero Risk, use the normal manual
send process. Local tests verify the result chain; they do not prove live ChatGPT image consumption
or increased attachment capacity.

The recorded A14 checks used the preceding connector ABI. They establish only the limited image
feasibility described in [release validation](release-validation.md#context-navigation-validation),
not adoption of the new ABI or complete context-navigation acceptance. Current Full/MCP source
delivery follows the [context navigation contract](context-navigation.md).

Reusing the same name continues its canonical Responses history. Sequential native messages in the
same compatible task lease one chat. Every message receives a
new turn-bound MCP token, and all MCP tool rounds for that message remain inside the same ChatGPT
response. On an exact native compaction request, the same Web agent submits the checkpoint through
a one-shot MCP control call in that chat. Applicable Full Native + Launcher paths retain the
healthy page across compaction; other paths keep their existing lifecycle. The complete named history remains owned by the existing prompt compiler. New
chats follow the configured **Save chats in ChatGPT** setting (on by default) and use the cheapest
account-supported browser mode:
Instant (`light`) when Sol is available, otherwise Luna. Override it with `--model` or `/model`.

Interactive commands:

```text
/status
/fill 30000
/send-fill 12000
/compact
/model high
/reset yes
/help
/exit
```

`/fill N` appends deterministic inert text measured by the production tokenizer. It does not open
ChatGPT. The next message checks the real model-specific auto-compaction threshold and calls the
same `compactRequest` handler when the threshold is crossed. `/compact` forces that handler
immediately. Luna keeps its production rolling-checkpoint contract and therefore rejects the
separate compact command.

`/send-fill N` sends deterministic inert text as the current message through the live browser. Use
it to exercise the one-message composer budget and multi-chunk prompt insertion independently of
history growth. The normal model-specific browser preflight still applies and fails closed above
the measured transport limit.

## Skills as files experiment

**Settings → Skills as files (experimental)** is off by default in both launcher profiles.
It uploads only skills explicitly selected in Codex and identified by native selected-skill
metadata. Skill discovery and reading other skills through tools are unchanged. The CLI setup
flags are `--skill-attachments` and `--inline-skills`; Zero Risk does not support automated uploads.

Each UTF-8 `.txt` attachment contains the original skill envelope, including its path or resource
authority. Its filename uses the skill name and a content digest to distinguish changed versions.
Files are generated in memory, with no persistent file cache. Retained chats send only new context;
a fresh chat reconstructs its attachments from canonical history. Files and images share the
10-attachment limit, and skill content still counts toward context and message token budgets.
An unsupported browser helper or rejected upload produces an error instead of silently omitting
instructions. This remains experimental: moving instructions into attachments does not guarantee
that ChatGPT will follow them more reliably.

## Bigger Context experiment

Both launcher profiles expose **Bigger Context (experimental)** in Settings. It is disabled by
default. The switch updates the profile's canonical runtime configuration through the normal setup
transaction; it is not a launcher-only preference. Production setup also rewrites the managed
Codex model catalog and asks you to restart Codex. Applicable unified routes advertise a
1,000,000-token history window and 900,000-token compaction threshold independently of browser
delivery capacity. GPT-5.6 and GPT-6 Pro keep their three-times budgets. GPT-6 Sol uses
240,000 context tokens and a 220,000-token compaction threshold only on Pro accounts at Medium,
High, or Extra High. GPT-6 Instant and GPT-6 Sol on other account plans keep standard budgets.
The DEV CLI reads the same setting from its isolated runtime configuration on each command.

When enabled, a normal turn stays on the original single-message path while its estimated input
is below the selected mode's existing auto-compaction threshold. At the first threshold it uses two
messages; at twice that threshold it uses six messages. The final context part also commits the
transaction and starts the task, so there is no extra request. The named DEV driver keeps its own compaction trigger; it does not demonstrate the public
Codex history threshold. Delivery still obeys the selected model and account limits.

Each stage contains complete semantic records, never a raw JSON string cut in the middle. The model
must return an exact transaction-bound SHA-256 acknowledgement before the next part is sent.
Actual fallback image attachments, the MCP connector, and the private `turn_token` belong only to
the final part. MCP-routed images are read through the selected navigation entry after submission.
In Full/MCP mode, compaction does not replay the expanded history into an unrelated summarizer. If
the source Web response is still waiting on a tool boundary, its canonical tool results finish that
response first without a compaction suffix. If those results are enough for an ordinary final
answer, that committed answer remains owned by the logical Responses turn even if the page is
later replaced. If the Web model instead requests another tool, the broker blocks that new execution
and tells the response to stop; the compacted continuation then resumes the unfinished work. The
exact retained chat receives one strict checkpoint message with the one-shot MCP submission
capability and, when needed, an independent `compaction_token` for read-only sources. It grants no
ordinary work capability. The model chooses which sources to read; no full-reading threshold is
required. Source failures, remaining summary reserve, and in-flight reads still gate submission.
The checkpoint never rides in the tail of a potentially
huge tool result, and its wait is capped at five minutes independently of the normal turn timeout.
For supported Full Native + Launcher tasks, accepting a structured handoff does not require
closing the page. The checkpoint commits once after its bound execution, source and real-result
checks; a healthy compatible page remains available for continuation. If a page replacement is
needed, old project authority must be durably isolated before the successor is activated. Physical
cleanup runs separately and still consumes its slot until exact destruction. Neither ending the
one-purpose response nor clicking close proves dispatched operations settled.

Non-applicable paths keep their existing compaction lifecycle: the one-purpose response ends,
physical Launcher settlement is awaited where required, and the old surface closes before a fresh
chat. This control-only completion does not depend on assistant prose or a Copy action.
If an applicable task's retained chat was lost without user stop, its uncommitted compaction uses
legal rebuilt sources and an actual read-only on-demand plan, with the same logical target,
deadline and retry budget. An existing stop is never cleared. Non-applicable fallback paths retain
their original source and transport checks. Browser-only has no retained MCP boundary and uses
the six-message compaction path with its complete expanded history.

Any missing or malformed acknowledgement fails the whole transaction. No later part or final
commit is sent, and a retry starts again from part one in a fresh chat. The model context
and auto-compaction ceilings follow the model and account rules above. Every individual stage
must still fit the selected ChatGPT mode's measured one-message boundary. Bigger Context uses only the existing supported model/account and staged-send paths. Unified
task continuity does not exclude it by mode; Zero Risk retains its prohibition. The applicable
1,000,000 / 900,000-token history budget does not increase the browser input boundary.

Small turns use one request. Two-part turns use one inert staging request and one final request;
six-part turns use five staging requests and one final request. Browser-only compaction also uses
six parts. Inert stages use the fastest available mode that fits their complete messages; the final
part uses the selected execution effort. Plus Instant uploads keep the same input headroom as
ordinary Instant turns; the selected final mode can receive a larger share of the context.
Large turns may increase the probability of
rate limits or a temporary account cooldown. The experiment is intentionally unavailable for Luna:
Luna's later requests still include the accumulated transcript inside the same measured
28,000-token browser transport budget.

Browser-only chats do not advertise outer tools and never claim simulated effects. Full setup keeps
the launcher-owned DEV tunnel ready so ChatGPT can create and validate `Codex Native5 DEV` before a
CLI chat starts. Each named chat attaches its broker to that tunnel, while every dispatched action
still returns an explicit simulation receipt.

The default isolated home is:

```text
~/.codex-chatgpt-web-dev/
├── config.json
├── codex-home/
├── launcher/                 # Electron userData, cookies, login, logs, window state
├── chats/<name>.json
├── runtime/
└── tunnel/
```

Set `CODEX_WEB_GPT_DEV_HOME` to choose another absolute DEV home. Generic `--home`,
`CODEX_CHATGPT_WEB_HOME`, `CODEX_HOME`, and `CODEX_WEB_GPT_LAUNCHER_DATA_DIR` never collapse the DEV
launcher into production storage.

## Isolation contract

The DEV driver:

- requires a descriptor explicitly marked `development` and a config explicitly marked
  `dev-harness`;
- uses a separate Electron `userData` directory and a separate persistent browser partition, so
  cookies, OAuth state, local storage, account selection, and launcher state cannot cross profiles;
- uses an isolated sandbox `CODEX_HOME` but never writes a Codex route into it;
- does not call setup, route connect/disconnect, service start/stop, or uninstall;
- does not start `Bun.serve` or bind the configured Responses port;
- rejects any attempt to start the Responses server from a `dev-harness` config;
- does not edit the normal `~/.codex/config.toml` or integration journal;
- leases an isolated DEV-launcher browser tab and runs the working-tree browser helper;
- owns the private DEV broker socket only for the command's lifetime;
- reuses the isolated tunnel supervised by the DEV launcher and never starts a competing alias;
- can run beside the production launcher, Responses port, and tunnel because none of their homes,
  browser partitions, descriptors, broker sockets, profiles, or aliases are shared;
- refuses to run Full-mode tool rounds until the launcher-owned DEV tunnel is ready;
- exposes ordinary structural tools, then returns a universal receipt containing
  `simulated: true` and `side_effects_performed: false` for every dispatched action.

The simulator has no keyword-to-result table and never claims that a command, patch, user-file read,
user interaction, or external mutation actually happened. The dedicated image probe delivers inert
fixture pixels through the real MCP result transport.
