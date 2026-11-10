// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import type { DirectoryNode, DirectoryRelation, DirectoryTree } from "../../../types";

export interface UnitStats {
  provided: number;
  used: number;
  relations: number;
}

export function flattenNodes(root: DirectoryNode): DirectoryNode[] {
  const nodes: DirectoryNode[] = [root];
  for (const child of root.children) {
    nodes.push(...flattenNodes(child));
  }
  return nodes;
}

export function nodeName(node: DirectoryNode, platformName: string): string {
  return node.kind === "platform" ? platformName : node.name;
}

export function relationsFor(
  relations: DirectoryRelation[],
  id: string
): DirectoryRelation[] {
  return relations.filter(
    (relation) => relation.from === id || relation.to === id
  );
}

export function uniqueLabels(relations: DirectoryRelation[]): string[] {
  return Array.from(new Set(relations.map((relation) => relation.label)));
}

export function unitStats(
  relations: DirectoryRelation[],
  id: string
): UnitStats {
  const incoming = relations.filter((relation) => relation.to === id);
  const outgoing = relations.filter((relation) => relation.from === id);
  return {
    provided: uniqueLabels(outgoing).length,
    used: uniqueLabels(incoming).length,
    relations: incoming.length + outgoing.length,
  };
}

export interface TreeSummary {
  units: number;
  relations: number;
  capabilities: number;
}

export function treeSummary(tree: DirectoryTree): TreeSummary {
  return {
    units: flattenNodes(tree.root).length - 1,
    relations: tree.relations.length,
    capabilities: uniqueLabels(tree.relations).length,
  };
}
