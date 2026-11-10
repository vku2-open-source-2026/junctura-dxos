// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React from "react";
import type { DirectoryNode, DirectoryRelation } from "../../../types";
import { useI18n } from "../../../locales/i18n";
import { Badge } from "../../common/Badge";
import type { TreeSummary, UnitStats } from "./orgGraph";
import { relationsFor, uniqueLabels } from "./orgGraph";

interface OrgNoteProps {
  selected: DirectoryNode;
  isRoot: boolean;
  relations: DirectoryRelation[];
  summary: TreeSummary;
  nameOf: (id: string) => string;
}

interface StatProps {
  label: string;
  value: number;
}

const Stat: React.FC<StatProps> = ({ label, value }) => (
  <div className="rounded-md border border-[var(--border)] p-2">
    <dt className="text-xs leading-tight text-[var(--muted)]">{label}</dt>
    <dd className="mt-0.5 text-base font-semibold text-[var(--text)]">{value}</dd>
  </div>
);

export const OrgNote: React.FC<OrgNoteProps> = ({
  selected,
  isRoot,
  relations,
  summary,
  nameOf,
}) => {
  const { t } = useI18n();
  const o = t.orgs;
  const selectedRelations = relationsFor(relations, selected.id);
  const incoming = selectedRelations.filter(
    (relation) => relation.to === selected.id
  );
  const outgoing = selectedRelations.filter(
    (relation) => relation.from === selected.id
  );
  const stats: UnitStats = {
    provided: uniqueLabels(outgoing).length,
    used: uniqueLabels(incoming).length,
    relations: selectedRelations.length,
  };
  const displayName =
    selected.kind === "platform" ? o.platformRootName : selected.name;

  const relationList = (
    items: DirectoryRelation[],
    label: string,
    emptyLabel: string,
    direction: "in" | "out"
  ) => (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
        {label}
      </h4>
      {items.length === 0 ? (
        <p className="mt-1 text-xs text-[var(--muted)]">{emptyLabel}</p>
      ) : (
        <ul className="mt-1 space-y-1.5">
          {items.map((relation, index) => (
            <li
              key={`${relation.from}-${relation.to}-${index}`}
              className="rounded-md border border-[var(--border)] px-2 py-1.5"
            >
              <span className="block break-words text-sm font-medium text-[var(--text)]">
                {relation.label}
              </span>
              <span className="block break-words text-xs text-[var(--muted)]">
                {direction === "in"
                  ? `${nameOf(relation.from)} → ${displayName}`
                  : `${displayName} → ${nameOf(relation.to)}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  return (
    <div className="space-y-3">
      <div>
        <h3 className="break-words text-base font-semibold text-[var(--text)]">
          {displayName}
        </h3>
        <p className="mt-1">
          <Badge variant="junctura">
            {selected.kind === "platform"
              ? o.kindPlatform
              : selected.kind === "application"
                ? o.kindApplication
                : o.kindOrganization}
          </Badge>
        </p>
      </div>

      {isRoot ? (
        <>
          <p className="text-sm leading-relaxed text-[var(--muted)]">
            {o.rootDetailDesc}
          </p>
          <dl className="grid grid-cols-3 gap-2 text-sm">
            <Stat label={o.totalUnits} value={summary.units} />
            <Stat label={o.totalRelations} value={summary.relations} />
            <Stat label={o.totalCapabilities} value={summary.capabilities} />
          </dl>
        </>
      ) : (
        <>
          <dl className="grid grid-cols-3 gap-2 text-sm">
            <Stat label={o.capabilityProvided} value={stats.provided} />
            <Stat label={o.capabilityUsed} value={stats.used} />
            <Stat label={o.relationCount} value={stats.relations} />
          </dl>
          {relationList(incoming, o.incoming, o.noIncoming, "in")}
          {relationList(outgoing, o.outgoing, o.noOutgoing, "out")}
        </>
      )}
    </div>
  );
};
