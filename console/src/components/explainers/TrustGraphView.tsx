// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Round-node trust map. Layout never changes on selection: the chosen node grows,
// its connections stay bright, everything else fades, and a detail card opens.
import React, { useMemo, useState } from "react";
import { X } from "lucide-react";
import type { TrustGraph, TrustGraphEdge, TrustGrantState } from "../../types";
import { useI18n } from "../../locales/i18n";
import { Button } from "../common/Button";
import { TRUST_GRAPH_STRINGS } from "./trustGraph.i18n";

const W = 680;
const H = 420;
const R = 30;
const STATES: TrustGrantState[] = ["active", "pending", "expired", "revoked"];
export const EDGE_COLOR: Record<TrustGrantState, string> = {
  active: "#0F9F8F",
  pending: "#D08A1C",
  expired: "#94A3B8",
  revoked: "#DC2626",
};
const NODE_FILL = ["#E5F0F3", "#E6F5F3", "#FBF4EE", "#EDEFF6", "#F7ECE8", "#E4F2F0", "#F1EFE6", "#EEF1F2"];
const SOON_MS = 7 * 86_400_000;

export function circleLayout(count: number): Array<{ x: number; y: number }> {
  if (count === 1) return [{ x: W / 2, y: H / 2 }];
  return Array.from({ length: count }, (_, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / count;
    return { x: W / 2 + 230 * Math.cos(a), y: H / 2 + 150 * Math.sin(a) };
  });
}

function curve(from: { x: number; y: number }, to: { x: number; y: number }, lane: number, rTo: number) {
  const dx = to.x - from.x, dy = to.y - from.y, len = Math.hypot(dx, dy) || 1;
  const bend = 26 + lane * 22;
  const cx = (from.x + to.x) / 2 + (-dy / len) * bend;
  const cy = (from.y + to.y) / 2 + (dx / len) * bend;
  const trim = (px: number, py: number, by: number) => {
    const l = Math.hypot(cx - px, cy - py) || 1;
    return { x: px + ((cx - px) / l) * by, y: py + ((cy - py) / l) * by };
  };
  const s = trim(from.x, from.y, R + 2);
  const e = trim(to.x, to.y, rTo + 8);
  return { d: `M ${s.x} ${s.y} Q ${cx} ${cy} ${e.x} ${e.y}`, mx: (s.x + 2 * cx + e.x) / 4, my: (s.y + 2 * cy + e.y) / 4 };
}

const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => [...w][0]?.toUpperCase() ?? "").join("");
const shortName = (n: string) => ([...n].length > 20 ? [...n].slice(0, 19).join("") + "…" : n);

type Selection = { kind: "node"; id: string } | { kind: "edge"; id: string } | null;

interface Props {
  graph: TrustGraph;
  canRevoke?: boolean;
  onRevoke?: (edge: TrustGraphEdge, reason: string) => Promise<void> | void;
  now?: number;
}

export const TrustGraphView: React.FC<Props> = ({ graph, canRevoke = false, onRevoke, now = Date.now() }) => {
  const { language } = useI18n();
  const s = TRUST_GRAPH_STRINGS[language];
  const [filter, setFilter] = useState<TrustGrantState | "all">("all");
  const [sel, setSel] = useState<Selection>(null);
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  const pos = useMemo(() => {
    const pts = circleLayout(graph.nodes.length);
    return new Map(graph.nodes.map((n, i) => [n.appId, { ...pts[i], color: NODE_FILL[i % NODE_FILL.length] }]));
  }, [graph.nodes]);
  const name = (id: string) => graph.nodes.find((n) => n.appId === id)?.displayName ?? "—";
  const edges = graph.edges.filter((e) => (filter === "all" || e.state === filter) && pos.has(e.providerAppId) && pos.has(e.consumerAppId));
  const lanes = useMemo(() => {
    const seen = new Map<string, number>();
    return new Map(edges.map((e) => {
      const k = `${e.providerAppId}>${e.consumerAppId}`;
      const l = seen.get(k) ?? 0;
      seen.set(k, l + 1);
      return [e.grantId, l];
    }));
  }, [edges]);

  const selNode = sel?.kind === "node" ? sel.id : null;
  const selEdge = sel?.kind === "edge" ? graph.edges.find((e) => e.grantId === sel.id) ?? null : null;
  const related = (e: TrustGraphEdge) =>
    sel === null ||
    (selNode !== null && (e.providerAppId === selNode || e.consumerAppId === selNode)) ||
    (selEdge !== null && e.grantId === selEdge.grantId);
  const nodeLit = (id: string) =>
    sel === null || selNode === id || (selEdge !== null && (selEdge.providerAppId === id || selEdge.consumerAppId === id)) ||
    (selNode !== null && graph.edges.some((e) => related(e) && (e.providerAppId === id || e.consumerAppId === id)));
  const soon = (e: TrustGraphEdge) => e.state === "active" && Date.parse(e.expiresAt) - now < SOON_MS;
  const fmt = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString(language === "vi" ? "vi-VN" : "en-GB", { dateStyle: "medium" }) : "—";
  const rel = (iso: string) => {
    const days = Math.round((Date.parse(iso) - now) / 86_400_000);
    return new Intl.RelativeTimeFormat(language, { numeric: "auto" }).format(days, "day");
  };
  const pick = (next: Selection) => {
    setSel((cur) => (cur && next && cur.kind === next.kind && cur.id === next.id ? null : next));
    setConfirming(false);
    setReason("");
  };
  const keyPick = (next: Selection) => (ev: React.KeyboardEvent) => {
    if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); pick(next); }
  };

  if (graph.nodes.length === 0) return <p className="py-10 text-center text-sm text-slate-500">{s.empty}</p>;

  return (
    <div>
      <p className="mb-3 text-base text-slate-600 dark:text-slate-300">{s.desc}</p>
      <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label={s.status}>
        {(["all", ...STATES] as const).map((st) => (
          <button key={st} type="button" aria-pressed={filter === st} onClick={() => setFilter(st)}
            className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm ${filter === st
              ? "border-slate-800 bg-slate-800 text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900"
              : "border-slate-200 text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"}`}>
            {st !== "all" && <span className="h-2.5 w-2.5 rounded-full" style={{ background: EDGE_COLOR[st] }} />}
            {st === "all" ? s.all : s.state[st]} · {st === "all" ? graph.edges.length : graph.edges.filter((e) => e.state === st).length}
          </button>
        ))}
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="overflow-hidden rounded-md border border-slate-200 bg-slate-50/60 dark:border-slate-700 dark:bg-slate-900/40">
        <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label={s.diagram(graph.nodes.length, graph.edges.length)}
          onClick={(ev) => { if (ev.target === ev.currentTarget) pick(null); }}>
          <defs>
            {STATES.map((st) => (
              <marker key={st} id={`tg-arrow-${st}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 0 L10 5 L0 10z" fill={EDGE_COLOR[st]} />
              </marker>
            ))}
          </defs>
          {edges.map((e) => {
            const target = selNode === e.consumerAppId ? R * 1.25 : R;
            const p = curve(pos.get(e.providerAppId)!, pos.get(e.consumerAppId)!, lanes.get(e.grantId) ?? 0, target);
            const on = selEdge?.grantId === e.grantId;
            return (
              <g key={e.grantId} data-testid={`tg-edge-${e.grantId}`} role="button" tabIndex={0}
                aria-label={`${s.arrow(name(e.providerAppId), name(e.consumerAppId))} ${e.title ?? ""} — ${s.state[e.state]}`}
                className="cursor-pointer outline-none" onClick={() => pick({ kind: "edge", id: e.grantId })}
                onKeyDown={keyPick({ kind: "edge", id: e.grantId })}
                style={{ opacity: related(e) ? 1 : 0.12, transition: "opacity 200ms" }}>
                <title>{`${s.arrow(name(e.providerAppId), name(e.consumerAppId))}: ${e.title ?? ""}`}</title>
                <path d={p.d} fill="none" stroke="transparent" strokeWidth={16} />
                <path d={p.d} fill="none" stroke={EDGE_COLOR[e.state]} strokeWidth={on ? 4.5 : 2.5}
                  strokeDasharray={e.state === "revoked" ? "6 5" : e.state === "pending" ? "2 5" : undefined}
                  markerEnd={`url(#tg-arrow-${e.state})`} style={{ transition: "stroke-width 200ms" }} />
                {e.state === "active" && !reduced && (
                  <circle r={3.5} fill={EDGE_COLOR.active}>
                    <animateMotion dur={`${2.6 + (lanes.get(e.grantId) ?? 0) * 0.4}s`} repeatCount="indefinite" path={p.d} />
                  </circle>
                )}
                {soon(e) && !on && <circle cx={p.mx} cy={p.my} r={5} fill="#D08A1C" stroke="#fff" strokeWidth={1.5}><title>{s.soon}</title></circle>}
                {on && e.title && (
                  <text x={p.mx} y={p.my - 7} textAnchor="middle" fontSize="14" fontWeight="600"
                    className="fill-slate-700 stroke-slate-50 dark:fill-slate-100 dark:stroke-slate-900" style={{ paintOrder: "stroke", strokeWidth: 4 }}>
                    {e.title}
                  </text>
                )}
              </g>
            );
          })}
          {graph.nodes.map((n) => {
            const p = pos.get(n.appId)!;
            const big = selNode === n.appId;
            const lit = nodeLit(n.appId);
            return (
              <g key={n.appId} data-testid={`tg-node-${n.appId}`} role="button" tabIndex={0} aria-pressed={big}
                aria-label={`${n.displayName} — ${s.appState[n.state] ?? n.state}`}
                className="cursor-pointer outline-none" onClick={() => pick({ kind: "node", id: n.appId })}
                onKeyDown={keyPick({ kind: "node", id: n.appId })}
                style={{ opacity: lit ? 1 : 0.35, transition: "opacity 200ms" }}>
                <title>{n.displayName}</title>
                <g style={{ transform: `translate(${p.x}px, ${p.y}px) scale(${big ? 1.25 : 1})`, transition: "transform 220ms ease-out" }}>
                  {big && <circle r={R + 8} fill="none" stroke="#0F9F8F" strokeOpacity={0.35} strokeWidth={6} />}
                  <circle r={R} fill={p.color} stroke={big ? "#0F9F8F" : n.state === "active" ? "#64748B" : "#D08A1C"}
                    strokeWidth={big ? 3 : 1.5} strokeDasharray={n.state === "active" ? undefined : "4 3"} />
                  <text y={5} textAnchor="middle" fontSize="15" fontWeight="700" fill="#1E293B">{initials(n.displayName)}</text>
                </g>
                <text x={p.x} y={p.y + (big ? R * 1.25 : R) + 18} textAnchor="middle" fontSize="15" fontWeight="600"
                  className="fill-slate-700 stroke-slate-50 dark:fill-slate-100 dark:stroke-slate-900"
                  style={{ paintOrder: "stroke", strokeWidth: 4, transition: "y 220ms" }}>{shortName(n.displayName)}</text>
              </g>
            );
          })}
        </svg>
      </div>

        {sel ? (
          <aside aria-live="polite"
            className="relative max-h-[420px] overflow-y-auto rounded-md border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
            <button type="button" onClick={() => pick(null)} aria-label={s.close}
              className="absolute right-2 top-2 rounded-md p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">
              <X className="h-4 w-4" />
            </button>
            {selNode && (() => {
              const node = graph.nodes.find((x) => x.appId === selNode)!;
              const out = graph.edges.filter((e) => e.providerAppId === selNode);
              const inc = graph.edges.filter((e) => e.consumerAppId === selNode);
              return (
                <div className="space-y-3 text-sm">
                  <p className="text-xs uppercase tracking-wide text-slate-500">{s.appCard}</p>
                  <p className="pr-6 text-lg font-semibold text-slate-900 dark:text-slate-100">{node.displayName}</p>
                  <p className="text-slate-600 dark:text-slate-300">{s.appState[node.state] ?? node.state}</p>
                  <ul className="space-y-1 text-slate-700 dark:text-slate-200">
                    <li>{s.provides(out.length)}</li>
                    <li>{s.uses(inc.length)}</li>
                  </ul>
                  <p className="font-medium text-slate-800 dark:text-slate-100">{s.connections}</p>
                  {out.length + inc.length === 0 ? <p className="text-slate-500">{s.noConnections}</p> : (
                    <ul className="space-y-1.5">
                      {[...out, ...inc].map((e) => (
                        <li key={e.grantId}>
                          <button type="button" onClick={() => pick({ kind: "edge", id: e.grantId })}
                            className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-left hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">
                            <span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: EDGE_COLOR[e.state] }} />
                            {e.title ?? "—"}
                            <span className="block text-xs text-slate-500">{s.arrow(name(e.providerAppId), name(e.consumerAppId))}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })()}
            {selEdge && (
              <div className="space-y-3 text-sm">
                <p className="text-xs uppercase tracking-wide text-slate-500">{s.edgeCard}</p>
                <p className="pr-6 text-lg font-semibold text-slate-900 dark:text-slate-100">{selEdge.title ?? "—"}</p>
                <p className="text-slate-700 dark:text-slate-200">{s.arrow(name(selEdge.providerAppId), name(selEdge.consumerAppId))}</p>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
                  <dt className="text-slate-500">{s.status}</dt>
                  <dd><span className="font-medium" style={{ color: EDGE_COLOR[selEdge.state] }}>{s.state[selEdge.state]}</span>
                    {soon(selEdge) && <span className="ml-1 text-amber-700 dark:text-amber-300">· {s.soon}</span>}</dd>
                  <dt className="text-slate-500">{s.can}</dt>
                  <dd>{selEdge.operations.map((o) => s.op[o] ?? o).join(", ")}</dd>
                  <dt className="text-slate-500">{s.activated}</dt><dd>{fmt(selEdge.activatedAt)}</dd>
                  <dt className="text-slate-500">{s.expires}</dt><dd>{fmt(selEdge.expiresAt)} ({rel(selEdge.expiresAt)})</dd>
                  {selEdge.revokedAt && (<><dt className="text-slate-500">{s.revokedAt}</dt><dd>{fmt(selEdge.revokedAt)}</dd></>)}
                </dl>
                {canRevoke && onRevoke && (selEdge.state === "active" || selEdge.state === "pending") && (
                  confirming ? (
                    <div className="space-y-2 border-t border-slate-200 pt-3 dark:border-slate-700">
                      <label htmlFor="tg-reason" className="block text-sm font-medium">{s.reason}</label>
                      <input id="tg-reason" value={reason} maxLength={512} placeholder={s.reasonPh} onChange={(e) => setReason(e.target.value)}
                        className="w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800" />
                      <div className="flex gap-2">
                        <Button size="sm" variant="destructive" disabled={!reason.trim()}
                          onClick={async () => { await onRevoke(selEdge, reason.trim()); setConfirming(false); setReason(""); }}>{s.confirm}</Button>
                        <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>{s.cancel}</Button>
                      </div>
                    </div>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => setConfirming(true)}>{s.revoke}</Button>
                  )
                )}
              </div>
            )}
          </aside>
        ) : (
          <p className="flex items-center justify-center rounded-md border border-dashed border-slate-300 p-4 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">{s.hint}</p>
        )}
      </div>
    </div>
  );
};

export default TrustGraphView;
