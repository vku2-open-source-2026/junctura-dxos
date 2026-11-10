// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React from "react";
import type { DirectoryRelation } from "../../../types";
import { useI18n } from "../../../locales/i18n";
import { Card, CardContent, CardHeader, CardTitle } from "../../common/Card";

interface OrgRelationsProps {
  relations: DirectoryRelation[];
  highlightId: string | null;
  nameOf: (id: string) => string;
}

export const OrgRelations: React.FC<OrgRelationsProps> = ({
  relations,
  highlightId,
  nameOf,
}) => {
  const { t } = useI18n();
  const o = t.orgs;
  return (
    <Card>
      <CardHeader>
        <div className="min-w-0">
          <CardTitle>{o.relationsTitle}</CardTitle>
          <p className="mt-1 text-sm text-[var(--muted)]">{o.relationsHint}</p>
        </div>
      </CardHeader>
      <CardContent>
        {relations.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">{o.relationsEmpty}</p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {relations.map((relation, index) => {
              const involved =
                relation.from === highlightId || relation.to === highlightId;
              const dimmed = highlightId !== null && !involved;
              return (
                <li
                  key={`${relation.from}-${relation.to}-${index}`}
                  className={`rounded-md border-l-2 px-2 py-1.5 text-sm transition-opacity ${
                    involved
                      ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                      : "border-transparent"
                  } ${dimmed ? "opacity-40" : "opacity-100"}`}
                >
                  <span className="block break-words text-[var(--text)]">
                    {nameOf(relation.from)} → {nameOf(relation.to)}
                  </span>
                  <span className="block break-words text-xs text-[var(--muted)]">
                    {relation.label}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
};
