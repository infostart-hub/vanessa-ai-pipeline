---
name: edt-mcp-project-query-dcs
description: "Locate, inspect, validate, and safely change 1C queries or Data Composition Schemas through EDT-MCP. Separates supported schema writes from runtime data proof."
---

# EDT-MCP query and DCS workflow

## Purpose and trigger

Use this skill to locate, inspect, validate, or change a 1C query or supported
Data Composition Schema surface.

## Operating rule

Read and apply [the common operating rules](references/COMMON.md) before this workflow.

## Task boundary

Resolve the exact project, owning method or schema FQN, dataset, exact settings
variant/default settings, and business grain. Route form-only work elsewhere
and never edit `.dcs` directly to bypass an unsupported structured operation.

## Primary workflow

1. Locate the owner with `search_in_code`, `get_module_structure`,
   `read_method_source`, or `get_metadata_details`.
2. Read the complete owning method for an embedded BSL query. For DCS,
   read current `get_tool_guide('dcs')` and the live schema, then use `dcs`
   get for the exact root and returned node addresses. A summary or dataset
   node may omit query text: read its advertised query address and all pages.
   Pass only the complete query text, excluding Markdown framing, to
   `validate_query` in the exact project. Use `dcsMode=true` for DCS queries
   and plain mode for ordinary queries. Inspect `valid` and `issues`;
   tool-call success does not imply validity.
3. Preserve business grain and cardinality. Hand an embedded BSL query mutation
   to `edt-mcp-project-local-fix` and require its guarded lost-update workflow;
   use the existing `dcs` owner for supported schema/settings mutations.
   Copy addresses and root hash from get. Indexed edits and replace/remove
   require `expectedHash`; prefer update of the exact existing node.
   Preserve dependencies, disabled settings, user identities, and designer
   content outside the target. Replace resets omitted members. Do not drop
   charts or switch to raw file edits when a typed operation is unsupported.
4. Re-read the owner, validate the final query, and inspect targeted
   `get_project_errors` when markers matter.
5. Run an authorized report/runtime check only when rows, totals, RLS,
   parameters, performance, or presentation are part of acceptance.

## Authority rule

Do not broaden source/DCS changes, bypass access restrictions, execute against
runtime data, or alter report settings beyond the authorized target.

## Stop rule

Stop on ambiguous ownership, unresolved model validation, unsupported DCS
write capability, unsafe cardinality, or missing runtime target/read authority.

## Completion signal

Return the exact owner and dataset, confirmed source/schema diff, successful
readback and static validation, business-grain reasoning, and explicit gaps.
Static validation never proves returned rows, totals, RLS, performance, or UI.
