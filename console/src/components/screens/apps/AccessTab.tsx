// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React, { useEffect, useState } from "react";
import type { AppAccessRole, AppAccessTarget, AppAssignment, Application } from "../../../types";
import { useI18n } from "../../../locales/i18n";
import { api } from "../../../services/apiClient";
import { Button } from "../../common/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../../common/Card";

export const AccessTab: React.FC<{ app: Application; canManage: boolean }> = ({ app, canManage }) => {
  const { t } = useI18n();
  const a = t.appAccess;
  const units = app.deploymentUnits ?? [];
  const [assignments, setAssignments] = useState<AppAssignment[]>([]);
  const [unit, setUnit] = useState(units[0] ?? "");
  const [targetType, setTargetType] = useState<AppAccessTarget>("unit");
  const [target, setTarget] = useState("");
  const [role, setRole] = useState<AppAccessRole>("viewer");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [revision, reload] = useState(0);

  useEffect(() => {
    let current = true;
    void api.listApplicationAssignments(app.appId)
      .then(page => { if (current) setAssignments(page.items); })
      .catch(() => { if (current) setFailed(true); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [app.appId, revision]);

  async function apply(action: () => Promise<unknown>) {
    setBusy(true);
    setFailed(false);
    try { await action(); }
    catch { setFailed(true); }
    finally { setBusy(false); reload(value => value + 1); }
  }

  return (
    <Card>
      <CardHeader><CardTitle>{a.title}</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        {failed && <p role="alert">{a.failed}</p>}
        {loading && <p role="status">{a.loading}</p>}
        {!loading && !failed && assignments.length === 0 && <p>{a.empty}</p>}
        {assignments.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead><tr>
                <th scope="col" className="p-2">{a.unit}</th>
                <th scope="col" className="p-2">{a.target}</th>
                <th scope="col" className="p-2">{a.role}</th>
                <th scope="col" className="p-2">{a.status}</th>
                {canManage && <th scope="col" className="p-2">{t.applications.columnActions}</th>}
              </tr></thead>
              <tbody>{assignments.map(item => (
                <tr key={item.assignmentId} className="border-t border-[var(--border)]">
                  <td className="p-2">{item.unit}</td>
                  <td className="p-2">{a.targets[item.targetType]} · {item.target}</td>
                  <td className="p-2">{a.roles[item.role]}</td>
                  <td className="p-2">{item.synchronized ? a.synchronized : a.waiting}</td>
                  {canManage && <td className="p-2"><Button size="sm" variant="outline" disabled={busy}
                    onClick={() => void apply(() => api.revokeApplicationAccess(app.appId, item.assignmentId))}>{a.revoke}</Button></td>}
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        {canManage && app.state === "active" && units.length > 0 && (
          <form className="flex flex-wrap items-end gap-3 border-t border-[var(--border)] pt-4" onSubmit={event => {
            event.preventDefault();
            void apply(() => api.assignApplicationAccess(app.appId, {
              unit, targetType, target: targetType === "unit" ? unit : target.trim(), role,
            }));
          }}>
            <label className="grid gap-1 text-sm">{a.unit}
              <select value={unit} onChange={event => setUnit(event.target.value)}>
                {units.map(key => <option key={key}>{key}</option>)}
              </select>
            </label>
            <label className="grid gap-1 text-sm">{a.target}
              <select value={targetType} onChange={event => { setTargetType(event.target.value as AppAccessTarget); setTarget(""); }}>
                {(["unit", "group", "subject"] as const).map(key => <option key={key} value={key}>{a.targets[key]}</option>)}
              </select>
            </label>
            {targetType !== "unit" && <label className="grid gap-1 text-sm">{a.targetId}
              <input required maxLength={128} value={target} onChange={event => setTarget(event.target.value)} />
            </label>}
            <label className="grid gap-1 text-sm">{a.role}
              <select value={role} onChange={event => setRole(event.target.value as AppAccessRole)}>
                {(["viewer", "editor", "manager"] as const).map(key => <option key={key} value={key}>{a.roles[key]}</option>)}
              </select>
            </label>
            <Button type="submit" disabled={busy || !unit}>{a.assign}</Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
};
