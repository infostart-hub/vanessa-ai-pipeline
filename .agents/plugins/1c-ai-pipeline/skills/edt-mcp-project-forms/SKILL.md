---
name: edt-mcp-project-forms
description: "Execute structured EDT-MCP operations on managed 1C forms: bindings, handlers, dynamic lists and verification. For usability, layout or workflow design, first use onec-managed-form-design to derive the proposal from the user's work."
---

# EDT-MCP managed forms

## Purpose and trigger

Use this skill to inspect or change a managed form's structure, data,
commands, handlers, dynamic lists, or visible layout.

## Operating rule

Read and apply [the common operating rules](references/COMMON.md) before this workflow.

## Task boundary

Work on the exact project and form FQN through structured EDT-MCP operations.
Route code-only fixes to `edt-mcp-project-local-fix` and DCS changes to
`edt-mcp-project-query-dcs`. Direct `Form.form` editing is a last resort only
when the installed project rules describe the procedure, structured operations
cannot represent the change, and the user explicitly authorizes the risk.

## Primary workflow

0. When the request concerns usability, field grouping, reading/editing comfort,
   or the order of user actions, load `onec-managed-form-design` first. Use its
   scenario and composition analysis to derive the change proposal from actual
   metadata. This technical skill executes that proposal; it does not replace
   the subject skill with an arbitrary rearrangement. For a narrowly specified
   binding or handler repair, that design handoff is not required.
1. Read the form with `get_metadata_details` and inspect only relevant handlers
   with `get_module_structure` and `read_method_source`.
2. Consult the current guide, then use the narrowest supported
   `create_metadata`, `modify_metadata`, or `delete_metadata` operation.
3. Re-read the form and verify the requested ownership, binding, data-path,
   command, and handler relationships; validate changed query text with
   `validate_query` when applicable.
4. For a dynamic list, verify its owning form attribute, main table or custom
   query, selected fields, visible item data paths, settings/filter handlers,
   and refresh/requery behavior. Validate changed query text before writing and
   ensure every visible `List.Field` path resolves afterward.
5. Use `get_form_layout_snapshot` when layout structure matters and
   `get_form_screenshot` only when rendered appearance is acceptance evidence.
   `get_form_screenshot` is disabled by default; if it is not in `tools/list`,
   report visual evidence as unavailable. When taking a post-change screenshot, use `refresh=true`. Blank output most
   likely means EDT lacks `-DnativeFormBufferedLayoutRender=true`; report visual
   evidence as unavailable rather than treating the change as failed.
6. Run targeted validation and an authorized runtime UI scenario only when
   interaction behavior must be proven.

## Authority rule

Do not broaden a form mutation, leave dangling bindings, activate UI, launch a
client, or change runtime data without the authority required for that effect.

## Stop rule

Stop when the form target is ambiguous, the structured writer cannot represent
the requested change, required references cannot be preserved, or necessary
visual/runtime evidence is unavailable.

## Completion signal

Return the exact form target, confirmed structural/source diff, targeted
validation, requested layout or runtime evidence, and explicit gaps. A model
read or screenshot proves only the state it actually reports, not user
interaction.

## Runtime-safe form commands

Do not shadow platform form methods with custom handlers: use a semantic name
such as `ОткрытьСпецификацию`, not `Открыть`. Update the command action, element
references and callers together. EDT model validation alone does not prove that
the platform can compile a dynamic form.

Avoid opening an experimental form directly inside application startup. If the
authorized demo requires startup routing, contain exceptions at that boundary,
report the original module/line and keep the application usable. A timer or
automated preparation is not evidence that the agent performed the business task.
Use the existing client for the UI result; do not install or start another EDT.
