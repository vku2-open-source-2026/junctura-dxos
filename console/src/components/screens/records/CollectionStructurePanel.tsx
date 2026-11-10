// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React from "react";
import { Table2, X } from "lucide-react";
import type { StorageCollectionStructure } from "../../../types";
import { useI18n } from "../../../locales/i18n";
import { Button } from "../../common/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../../common/Card";
import { EmptyState } from "../../common/EmptyState";
import { ErrorState } from "../../common/ErrorState";
import { LoadingSkeleton } from "../../common/LoadingSkeleton";

export type StructureStatus =
  | "idle"
  | "loading"
  | "ready"
  | "error"
  | "permission";

interface CollectionStructurePanelProps {
  status: StructureStatus;
  collection: StorageCollectionStructure | null;
  appName: string;
  number: (value: number) => string;
  dateFormat: Intl.DateTimeFormat;
  onRetry: () => void;
  onClose: () => void;
}

export const CollectionStructurePanel: React.FC<
  CollectionStructurePanelProps
> = ({
  status,
  collection,
  appName,
  number,
  dateFormat,
  onRetry,
  onClose,
}) => {
  const { t } = useI18n();
  const r = t.records;

  const updated = collection?.updatedAt
    ? dateFormat.format(new Date(collection.updatedAt))
    : r.neverUpdated;

  return (
    <Card className="min-w-0">
      <CardHeader>
        <div className="min-w-0">
          <CardTitle>{r.structureTitle}</CardTitle>
          <p className="mt-1 text-sm text-[var(--muted)]">{r.structureHint}</p>
        </div>
        {status !== "idle" && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label={r.structureClose}
            leftIcon={<X className="h-4 w-4" aria-hidden="true" />}
          >
            <span className="sr-only">{r.structureClose}</span>
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {status === "idle" && (
          <EmptyState
            title={r.structurePromptTitle}
            description={r.structurePromptDesc}
            icon={<Table2 className="h-6 w-6" aria-hidden="true" />}
          />
        )}

        {status === "loading" && (
          <div>
            <p className="sr-only">{r.structureLoading}</p>
            <LoadingSkeleton rows={5} />
          </div>
        )}

        {status === "error" && (
          <ErrorState
            title={r.structureErrorTitle}
            message={r.structureErrorDesc}
            onRetry={onRetry}
          />
        )}

        {status === "permission" && (
          <ErrorState
            title={r.structurePermissionTitle}
            message={r.structurePermissionDesc}
            onRetry={onRetry}
          />
        )}

        {status === "ready" && collection && (
          <div className="space-y-4">
            <div>
              <h3 className="text-lg font-semibold text-[var(--text)]">
                {collection.name}
              </h3>
              <p className="mt-1 text-sm text-[var(--muted)]">
                {r.structureBelongs.replace("{app}", appName)}
              </p>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-[var(--muted)]">
                <span>
                  {r.structureRecords.replace(
                    "{n}",
                    number(collection.records)
                  )}
                </span>
                <span>{r.structureUpdated.replace("{time}", updated)}</span>
              </div>
            </div>

            <div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
                  {r.fieldsTitle}
                </h4>
                <span className="text-xs text-[var(--muted)]">
                  {r.fieldsCount.replace(
                    "{n}",
                    String(collection.fields.length)
                  )}
                </span>
              </div>
              {collection.fields.length === 0 ? (
                <p className="mt-2 text-sm text-[var(--muted)]">
                  {r.noFields}
                </p>
              ) : (
                <ul className="mt-2 space-y-2">
                  {collection.fields.map((field) => (
                    <li
                      key={field.name}
                      className="rounded-md border border-[var(--border)] p-2.5"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="min-w-0 break-words font-mono text-sm text-[var(--text)]">
                          {field.name}
                        </span>
                        <span className="rounded border border-[var(--border)] bg-[var(--accent-soft)]/50 px-2 py-0.5 text-xs text-[var(--muted)]">
                          {r.fieldTypes[field.type]}
                        </span>
                      </div>
                      <div className="mt-2 flex items-center gap-2">
                        <div
                          role="img"
                          aria-label={r.fieldFillAria
                            .replace("{name}", field.name)
                            .replace("{percent}", String(field.fillRate))}
                          className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"
                        >
                          <span
                            className="block h-full rounded-full bg-[var(--accent)]"
                            style={{ width: `${field.fillRate}%` }}
                          />
                        </div>
                        <span className="w-10 text-right text-xs text-[var(--muted)]">
                          {field.fillRate}%
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        {status === "ready" && !collection && (
          <EmptyState
            title={r.structurePromptTitle}
            description={r.noFields}
            icon={<Table2 className="h-6 w-6" aria-hidden="true" />}
          />
        )}
      </CardContent>
    </Card>
  );
};
