<!-- SPDX-FileCopyrightText: 2026 Junctura Contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Business workflow deployment directory

This is the default, empty business definitions directory. It contains no BPMN
files, so a default deployment installs only the technical checkpoint.

Set `WORKFLOW_DEFINITIONS_DIR` to an operator-provided application directory
(for example `../junctura-workspace/workflows`). Compose mounts it read-only at
`/definitions/business`; the initializer recursively collects `*.bpmn20.xml`.

Every business definition must pass the strict policy before any definition is
deployed: bounded XML, one executable process with a safe non-reserved key and
name, allowlisted elements, literal assignments and groups, and simple equality
or inequality conditions. DTDs, entities, executable service/script elements,
engine hooks, attribute expressions and namespace aliasing are rejected. A rejection prevents both
business and technical deployments for that run.

See [workflow deployment](../../docs/CORE_API.md#business-workflow-definitions)
for the complete policy, tenant configuration and redeployment behavior.
