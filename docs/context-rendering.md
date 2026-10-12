# Context rendering

This is the persistent byte contract for `codex-context-text-v1`. It describes browser presentation,
not the internal snapshot or a new tool. [Context navigation](context-navigation.md) defines selection,
cost, permission, and client-validation requirements.

## Records and extraction

Final JSON serialization escapes literal backticks as `\u0060`. This preserves decoded string
values and prevents the observed ChatGPT Markdown link parser stall. A source field containing a
backtick stays in JSON instead of a raw body; other eligible raw bodies retain their original bytes.
Format selection, multipart allocation, and capacity checks count this final encoded representation.
Dynamic outer fences alone do not provide this protection.

Input is the existing normalized, projected, retired-handle-cleaned JSON value tree. The single-input
legacy envelope is `{version:3, system, messages}`. Ordered records are:

```ts
type Record =
  | { kind: "system"; system_index: number; content: JsonValue }
  | { kind: "message"; message_index: number; message: JsonObject };
```

System records precede message records. Both indices are zero-based and retain their global values
across multipart groups. They are not the navigator's one-based source indices. A one-line compact
JSON header declares `format`, `context_version: 3`, and `record_count`. Multipart headers also have
one-based `part_index` and `total_parts` (2 or 6). Each record header is compact JSON with `record`
and an optional `raw_fields` array. Omit the array when no fields are extracted.

Each descriptor is `{path, boundary, utf8_bytes}`. `path` is an array of object-key strings and
array-index integers relative to the record. Only an existing allowed string leaf becomes a null
placeholder. Other nulls remain null. Paths must be unique, must not overlap, and must use own
properties with the correct container/key type. They cannot create fields, modify identity fields,
or traverse prototypes. Descriptors and bodies retain the original field/block order.

An example complete single-record payload is:

```text
{"format":"codex-context-text-v1","context_version":3,"record_count":1}
{"record":{"kind":"message","message_index":0,"message":{"role":"user","content":null}},"raw_fields":[{"path":["message","content"],"boundary":"source_body_0","utf8_bytes":3}]}
<source_body_0>
abc
</source_body_0>
```

## Bytes and boundaries

The package header and each record header end with one wrapper LF. For each descriptor, append:

```text
UTF8("<" + boundary + ">\n")
+ UTF8(originalString)
+ UTF8("\n</" + boundary + ">\n")
```

Wrapper LFs are not source text. Empty bodies retain both wrapper LFs. A source's final LF is in
addition to the wrapper LF. Literal backslash-n stays literal. Decode by declared byte length, then
check the exact suffix. Never trim, join lines, or locate the body end by the first matching tag.
Lengths must be safe nonnegative integers, must not split UTF-8 characters, and are bounded by the
preparation resource limit.

Boundaries have form `source_body_<nonnegative decimal integer>`. Scan the source strings and
retained fields, then allocate the smallest unused numbers in order without reusing a boundary in
one package. Neither selected start nor end markers may occur in source bodies. Generation is
deterministic and bounded. A preparation failure permits the existing JSON candidate or capacity
error before sending; it does not change source characters.

Each record ends with its header LF or its last block LF. No extra record separator is inserted.
After `record_count` records, the decoder must be at package end. Single input reconstructs the
version-3 tree. Multipart validation checks shared format, global record order, part numbers, and
counts. Unknown formats, descriptors, extra records, non-null placeholders, bad paths, truncated
blocks, or trailing data fail explicitly.

## Fences, controls, and evidence

Wrap the full payload in a zero-indented text fence with
`max(3, longest consecutive backtick run in the payload + 1)` backticks. Place one wrapper LF after
the payload before the closing fence; it does not extend the last source body. Other generated
code blocks use the same collision rule. New text payloads are not labelled as JSON.

Stage and commit controls stay outside source data. The model instructions explain original record
roles/order, descriptor binding, null placeholders, and that imitation headers/tags inside a body
remain data. A stage remains inert until the existing final commit. These labels grant no new role
or tool authority. Control wrappers are generated from structure, not parsed by matching source text.

Preparation encodes, decodes, and deeply compares the original delivered tree. Fixed payload bytes
determine the SHA-256 used by manifests and ACKs. Retries cannot regenerate different boundaries or
switch formats. Historical legacy JSON and new inputs can coexist; one multipart transaction cannot
mix formats. Local decoding and dynamic fences do not prove the real editor or model preserves or
uses the body. See [release validation](release-validation.md#context-rendering-validation).
