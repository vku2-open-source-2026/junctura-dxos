// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Building2, Network, X } from "lucide-react";
import type { DirectoryNode, DirectoryTree } from "../../../types";
import { useI18n } from "../../../locales/i18n";
import { Card, CardContent, CardHeader, CardTitle } from "../../common/Card";
import { Badge } from "../../common/Badge";
import { EmptyState } from "../../common/EmptyState";
import { flattenNodes, nodeName, treeSummary, unitStats } from "./orgGraph";
import { OrgNote } from "./OrgDetail";
import { OrgRelations } from "./OrgRelations";

interface OrgChartProps {
  tree: DirectoryTree;
}

interface NotePosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

const NOTE_WIDTH = 340;
const VIEWPORT_MARGIN = 8;
const ESTIMATED_NOTE_HEIGHT = 360;

function notePosition(anchor: HTMLElement): NotePosition {
  const rect = anchor.getBoundingClientRect();
  const width = Math.min(NOTE_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2);
  const maxHeight = window.innerHeight - VIEWPORT_MARGIN * 2;
  const height = Math.min(ESTIMATED_NOTE_HEIGHT, maxHeight);

  let left = rect.right + VIEWPORT_MARGIN;
  if (left + width > window.innerWidth - VIEWPORT_MARGIN) {
    left = rect.left - width - VIEWPORT_MARGIN;
  }
  if (left < VIEWPORT_MARGIN) left = VIEWPORT_MARGIN;

  let top = rect.top;
  if (top + height > window.innerHeight - VIEWPORT_MARGIN) {
    top = window.innerHeight - VIEWPORT_MARGIN - height;
  }
  if (top < VIEWPORT_MARGIN) top = VIEWPORT_MARGIN;

  return { top, left, width, maxHeight };
}

export const OrgChart: React.FC<OrgChartProps> = ({ tree }) => {
  const { t } = useI18n();
  const o = t.orgs;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [position, setPosition] = useState<NotePosition | null>(null);
  const anchorRefs = useRef(new Map<string, HTMLButtonElement>());
  const popoverRef = useRef<HTMLDivElement>(null);

  const units = useMemo(
    () => flattenNodes(tree.root).filter((node) => node.id !== tree.root.id),
    [tree.root]
  );
  const nodeById = useMemo(() => {
    const map = new Map<string, DirectoryNode>();
    for (const node of flattenNodes(tree.root)) map.set(node.id, node);
    return map;
  }, [tree.root]);
  const summary = useMemo(() => treeSummary(tree), [tree]);

  const selectedNode = selectedId ? nodeById.get(selectedId) : undefined;
  const highlightId = selectedNode ? selectedId : null;
  const nameOf = useCallback(
    (id: string) => {
      const node = nodeById.get(id);
      return node ? nodeName(node, o.platformRootName) : id;
    },
    [nodeById, o.platformRootName]
  );

  const closeNote = useCallback(
    (restoreFocus: boolean) => {
      const currentId = selectedId;
      setSelectedId(null);
      setPosition(null);
      if (restoreFocus && currentId) {
        anchorRefs.current.get(currentId)?.focus();
      }
    },
    [selectedId]
  );

  const openNote = (id: string, anchor: HTMLButtonElement) => {
    if (selectedId === id) {
      closeNote(true);
      return;
    }
    setSelectedId(id);
    setPosition(notePosition(anchor));
  };

  const setAnchorRef = (id: string) => (element: HTMLButtonElement | null) => {
    if (element) anchorRefs.current.set(id, element);
    else anchorRefs.current.delete(id);
  };

  useEffect(() => {
    if (selectedId) popoverRef.current?.focus();
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId) return;

    const updatePosition = () => {
      const anchor = anchorRefs.current.get(selectedId);
      if (anchor) setPosition(notePosition(anchor));
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeNote(true);
      }
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (popoverRef.current?.contains(target)) return;
      if (anchorRefs.current.get(selectedId)?.contains(target)) return;
      closeNote(false);
    };

    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [selectedId, closeNote]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="min-w-0">
            <CardTitle>{o.treeTitle}</CardTitle>
            <p className="mt-1 text-sm text-[var(--muted)]">{o.treeHint}</p>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {tree.truncated && (
            <p className="text-sm text-[var(--muted)]">{o.truncated}</p>
          )}

          <div className="flex flex-col items-center">
            <button
              ref={setAnchorRef(tree.root.id)}
              type="button"
              onClick={(event) =>
                openNote(tree.root.id, event.currentTarget)
              }
              aria-expanded={selectedId === tree.root.id}
              aria-haspopup="dialog"
              aria-label={o.platformRootName}
              className={`w-full max-w-md rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                selectedId === tree.root.id
                  ? "border-[var(--accent)] bg-[var(--accent-soft)] shadow-sm"
                  : "border-[var(--border)] bg-[var(--card)] hover:border-[var(--accent)]"
              }`}
            >
              <span className="flex items-center gap-2">
                <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-[var(--accent-soft)] text-[var(--accent)]">
                  <Network className="h-4 w-4" aria-hidden="true" />
                </span>
                <span className="min-w-0">
                  <span className="block break-words text-base font-semibold text-[var(--text)]">
                    {o.platformRootName}
                  </span>
                  <span className="block text-xs text-[var(--muted)]">
                    {o.kindPlatform}
                  </span>
                </span>
              </span>
              <span className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--muted)]">
                <span>{o.unitsCount.replace("{n}", String(summary.units))}</span>
                <span>
                  {o.relationCount}: {summary.relations}
                </span>
                <span>
                  {o.totalCapabilities}: {summary.capabilities}
                </span>
              </span>
            </button>
            {units.length > 0 && (
              <span
                aria-hidden="true"
                className="h-4 w-px bg-[var(--chart-grid)]"
              />
            )}
          </div>

          {units.length === 0 ? (
            <EmptyState
              title={o.noUnitsTitle}
              description={o.noUnitsDesc}
              icon={<Building2 className="h-6 w-6" aria-hidden="true" />}
            />
          ) : (
            <ul className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-x-0 gap-y-4">
              {units.map((unit) => {
                const stats = unitStats(tree.relations, unit.id);
                const active = selectedId === unit.id;
                return (
                  <li
                    key={unit.id}
                    className="relative min-w-0 px-1.5 pt-6"
                  >
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-x-0 top-0 h-px bg-[var(--chart-grid)]"
                    />
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute left-1/2 top-0 h-6 w-px bg-[var(--chart-grid)]"
                    />
                    <button
                      ref={setAnchorRef(unit.id)}
                      type="button"
                      onClick={(event) =>
                        openNote(unit.id, event.currentTarget)
                      }
                      aria-expanded={active}
                      aria-haspopup="dialog"
                      aria-label={nodeName(unit, o.platformRootName)}
                      className={`flex h-full w-full flex-col gap-2 rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                        active
                          ? "border-[var(--accent)] bg-[var(--accent-soft)] shadow-sm"
                          : "border-[var(--border)] bg-[var(--card)] hover:border-[var(--accent)]"
                      }`}
                    >
                      <span className="flex items-start gap-2">
                        <span className="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded bg-[var(--accent-soft)] text-[var(--accent)]">
                          <Building2
                            className="h-3.5 w-3.5"
                            aria-hidden="true"
                          />
                        </span>
                        <span className="min-w-0 flex-1 break-words text-sm font-semibold text-[var(--text)]">
                          {nodeName(unit, o.platformRootName)}
                        </span>
                      </span>
                      <Badge variant="outline">
                        {unit.kind === "application"
                          ? o.kindApplication
                          : o.kindOrganization}
                      </Badge>
                      <span className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-tight text-[var(--muted)]">
                        <span>
                          {o.provideShort.replace("{n}", String(stats.provided))}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>
                          {o.useShort.replace("{n}", String(stats.used))}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>
                          {o.relationShort.replace("{n}", String(stats.relations))}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <p className="text-xs text-[var(--muted)]">{o.selectHint}</p>
        </CardContent>
      </Card>

      <OrgRelations
        relations={tree.relations}
        highlightId={highlightId}
        nameOf={nameOf}
      />

      {selectedNode && position && (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label={o.detailTitle}
          tabIndex={-1}
          style={{
            top: position.top,
            left: position.left,
            width: position.width,
            maxHeight: position.maxHeight,
          }}
          className="fixed z-50 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--card)] p-4 text-[var(--text)] shadow-xl outline-none"
        >
          <div className="mb-2 flex items-start justify-end">
            <button
              type="button"
              onClick={() => closeNote(true)}
              aria-label={t.common.close}
              className="rounded p-1 text-[var(--muted)] transition-colors hover:bg-[var(--accent-soft)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          <OrgNote
            selected={selectedNode}
            isRoot={selectedNode.id === tree.root.id}
            relations={tree.relations}
            summary={summary}
            nameOf={nameOf}
          />
        </div>
      )}
    </div>
  );
};

