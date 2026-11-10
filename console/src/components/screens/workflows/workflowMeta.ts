// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import type { useI18n } from "../../../locales/i18n";

type WorkflowStrings = ReturnType<typeof useI18n>["t"]["workflows"];

interface DefinitionLike {
  id?: string | null;
  key?: string | null;
  name?: string | null;
}

export function definitionKeyOf(definition: DefinitionLike): string | null {
  if (definition.key) return definition.key;
  if (definition.id) return definition.id.split(":")[0] || null;
  return null;
}

export function friendlyWorkflowName(
  definition: DefinitionLike,
  strings: WorkflowStrings
): string {
  const key = definitionKeyOf(definition);
  const mapped = key
    ? (strings.nameMap as Record<string, string>)[key]
    : undefined;
  if (mapped) return mapped;
  const name = definition.name?.trim();
  if (name && !/^core checkpoint$/i.test(name)) return name;
  return strings.unknownDefinition;
}
