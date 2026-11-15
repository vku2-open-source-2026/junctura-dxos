<!-- SPDX-FileCopyrightText: 2026 Junctura Contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Development and Release Workflow

## Before editing

1. Read `docs/DEVELOPING.md`, relevant module docs and existing code; inspect current repo conventions.
2. Define the smallest change, impacted APIs/schemas, risks and expected tests.
3. Confirm new dependencies and license decisions before installation.

## While editing

- Keep Core and Apps separated; avoid unrelated refactoring, duplicate utilities, unnecessary abstractions and stray scratch files.
- Never commit `.env`, secrets, access tokens, private data, caches, dumps or generated binaries without explicit need.
- Use input validation, safe SQL queries, backend authorization, constrained upload handling and sensible timeouts.
- For retries with side effects, use an idempotency strategy; fail closed when permissions cannot be confirmed.
- Do not disable validation, tests or security scanning merely to obtain a green result.
- Document public API/contract changes and update tests as part of the code change.

## Business workflow definitions supplied by applications

Core no longer ships business BPMN in its image. Applications maintain these
definitions in a Layer-2 repository; an operator supplies their directory with
`WORKFLOW_DEFINITIONS_DIR` (for example `../junctura-workspace/workflows`). Empty
or unset uses [infra/workflows](../infra/workflows/README.md), which contains no
business BPMN. The [temporary samples](../examples/workflows/README.md) are not
deployed by default and will move to a Layer-2 application repository.

`workflow-init` mounts that directory read-only at `/definitions/business` and
recursively collects `*.bpmn20.xml`. The technical checkpoint mount is separate
and unchanged. `WORKFLOW_TENANTS` selects a comma-separated list of tenants
(default `tenant-a,tenant-b`); whitespace around items is trimmed. Each tenant
must match `^[a-z0-9][a-z0-9-]{0,62}$`; empty or invalid items abort initialization.

All business files must pass the pure safety policy in
`src/modules/workflow/definition-policy.mjs` before any business or technical
definition is deployed:

- XML must be a string of at most 262144 UTF-8 bytes. `DOCTYPE` and `ENTITY`
  declarations are forbidden anywhere.
- Exactly one process must have `isExecutable="true"`. Its id must match
  `^[a-z][a-z0-9_]{2,63}$`; `junctura_c4a_single` and `junctura_checkpoint` are
  reserved. Its name must contain 1–120 characters without control characters.
- Allowed element local names are `definitions`, `process`, `documentation`,
  `extensionElements`, `startEvent`, `endEvent`, `userTask`, `sequenceFlow`,
  `exclusiveGateway`, `parallelGateway`, `conditionExpression`, `laneSet`, `lane`
  and `flowNodeRef`. Diagram prefixes `bpmndi:`, `omgdc:`, `omgdi:`, `dc:`, `di:`
  and metadata prefix `junctura:` (only `junctura:owner` and `junctura:group`)
  are allowed. Service/script tasks, subprocesses, calls and execution/task
  listeners are rejected by this allowlist.
- Flowable resolves names by namespace URI, so every namespace declaration must
  bind a known prefix to its canonical URI: default and `bpmn` to the BPMN 2.0
  model, `bpmndi`, `omgdc`/`dc`, `omgdi`/`di` to diagram interchange, `flowable`
  to `http://flowable.org/bpmn`, `xsi` to XML Schema instance and `junctura` to
  `https://junctura.studio/schema/bpmn/1`. Aliasing an allowed prefix to another
  namespace is rejected (`namespace_forbidden`). Attributes may only use the
  `flowable:` and `xsi:` prefixes; `expressionLanguage`, `typeLanguage` and
  `language` are forbidden, and a condition may only carry
  `xsi:type="tFormalExpression"`.
- Forbidden attributes are `flowable:class`, `flowable:expression`,
  `flowable:delegateExpression`, `flowable:resultVariable`, `flowable:async`,
  `flowable:formKey` and `flowable:skipExpression`. Any attribute value containing
  `${` or `#{` is forbidden, including assignee or candidate-user expressions.
- Each condition must compare a single variable using `==` or `!=`, such as
  `${decision == 'approved'}`. Variable names start with a lowercase letter and
  contain at most 41 letters, digits or underscores. Literals are `true`, `false`,
  an optional minus sign followed by 1–9 digits, or a single-quoted string of at
  most 64 characters excluding quotes, dollar signs, backslashes and braces.
  Whitespace and a CDATA wrapper are allowed; method calls are forbidden.
- `flowable:candidateGroups` is a comma-separated list whose trimmed items each
  match `^[a-z][a-z0-9-]{1,63}$`.

A rejected file produces one line per policy problem with its file name and
rule, without XML contents. The initializer exits with status 1 and deploys
nothing for that run. The policy scans tags and attributes; Flowable remains
responsible for BPMN/XML schema validation.

After configuring the directory and tenants in `.env`, run:

```sh
docker compose run --rm workflow-init
```

For each definition and tenant, initialization looks up the latest definition
by key. A new key is deployed. An existing key is skipped only when its original
resource XML exactly matches the supplied file; changed XML creates a new
deployment. The final line reports business and technical file counts, tenants
and the number of deployments. Engine failures retain a generic error message
that does not expose private configuration.

### Workflow display metadata

Layer-2/3 applications supply owner and group labels in the deployed BPMN;
Core has no business label tables or local business-definition fallback. Bind
`xmlns:junctura="https://junctura.studio/schema/bpmn/1"` on `definitions`, and
put the declarations directly in the process's `extensionElements`:

```xml
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:flowable="http://flowable.org/bpmn"
             xmlns:junctura="https://junctura.studio/schema/bpmn/1"
             targetNamespace="https://example.invalid/workflows">
  <process id="quy_trinh_a" name="Quy trình A" isExecutable="true">
    <extensionElements>
      <junctura:owner id="nhom-a" name="Nhóm chủ trì" />
      <junctura:group id="nhom-a" name="Nhóm A" />
      <junctura:group id="nhom-b" name="Nhóm B" />
    </extensionElements>
    <startEvent id="start" />
    <sequenceFlow id="to_review" sourceRef="start" targetRef="review" />
    <userTask id="review" name="Bước 1" flowable:candidateGroups="nhom-a,nhom-b" />
    <sequenceFlow id="to_end" sourceRef="review" targetRef="end" />
    <endEvent id="end" />
  </process>
</definitions>
```

Owner and group IDs must match `^[a-z][a-z0-9-]{1,63}$`. Display names must
contain 1–200 characters without control characters. Declare one group per
candidate group used by the tasks. The owner supplies the summary's
`application: { id, name }`, or `null` when absent or invalid. Named user tasks
become steps in document order, deduplicated by name. Each step uses the first
candidate group with a declared valid name as its `owner`; if none has a name,
the owner is `null`. Core never displays a raw candidate-group ID as that label.
Metadata outside the process's own `extensionElements`, including task-level
extensions, is ignored. Attribute order and single or double quotes are allowed.

Core reads the XML through Flowable's
`GET repository/process-definitions/{id}/resourcedata` and caches successfully
parsed metadata by immutable definition ID (200 entries, oldest evicted first).
Loading or parsing one resource can fail without failing the summary: that
definition has `steps: []` and `application: null`, and a later request can retry.
Definitions that remain only in history also have empty metadata. Technical
Core definitions stay excluded; definition-list or history failures still
propagate. Changing labels requires a new deployment, as with other XML changes.

Execution-list case titles use only the definition name and a valid
`input.reference` matching `^[A-Z][A-Z0-9-]{0,31}$`, for example
`Quy trình A HS-0002`. Without a valid reference the title is the definition
name alone; without a definition name it is `null`. Other input fields never
contribute to case titles.

## Completion report (mandatory)

Include:
- Files changed and why.
- Exact tests/build/lint commands run with results, plus checks you could not run.
- New dependencies, license impact and unresolved risks.
- Any required human approvals or migration/rollback steps.

## Release procedure

1. Run test, build, security and license checks on a clean checkout.
2. Confirm readable README, build instructions, `.env.example`, changelog, issue tracker, license and dependency inventory.
3. Tag a version and publish a source release in a format accepted by the organizer; verify the current rules.
4. Verify deployment and the Core-to-App end-to-end demo.

Do not claim a build or release is reproducible unless it has been tested.
