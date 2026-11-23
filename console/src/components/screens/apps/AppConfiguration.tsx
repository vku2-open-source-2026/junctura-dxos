// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React, { useEffect, useState } from "react";
import type { AppKeyRotation, Application } from "../../../types";
import { useI18n } from "../../../locales/i18n";
import { api } from "../../../services/apiClient";
import { Button } from "../../common/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../../common/Card";

export const AppConfiguration: React.FC<{ app: Application; canManage: boolean; onUpdated: () => void }> = ({ app, canManage, onUpdated }) => {
  const { t, language } = useI18n();
  const a = t.appAccess;
  const [displayName, setDisplayName] = useState(app.displayName);
  const [ownerUnit, setOwnerUnit] = useState(app.ownerUnit ?? "");
  const [deploymentUnits, setDeploymentUnits] = useState((app.deploymentUnits ?? []).join(", "));
  const [history, setHistory] = useState<AppKeyRotation[]>([]);
  const [rotationKey, setRotationKey] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [keysLoaded, setKeysLoaded] = useState(false);
  const editable = canManage && app.state !== "revoked";

  useEffect(() => {
    if (!canManage) return;
    let current = true;
    void api.listApplicationOidcKeys(app.appId)
      .then(page => { if (current) { setHistory(page.items); setKeysLoaded(true); } })
      .catch(() => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [app.appId, canManage]);

  async function apply(run: () => Promise<void>) {
    setBusy(true);
    setFailed(false);
    try { await run(); }
    catch { setFailed(true); }
    finally { setBusy(false); }
  }

  return (
    <Card>
      <CardHeader><CardTitle>{a.configuration}</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        {failed && <p role="alert">{a.failed}</p>}
        {editable ? <form className="grid max-w-xl gap-3 text-sm" onSubmit={event => {
          event.preventDefault();
          void apply(async () => {
            await api.updateApplication(app, {
              displayName: displayName.trim(), ownerUnit: ownerUnit.trim() || null,
              deploymentUnits: deploymentUnits.split(",").map(unit => unit.trim()).filter(Boolean),
            });
            onUpdated();
          });
        }}>
          <label className="grid gap-1">{a.displayName}<input required maxLength={120} value={displayName}
            onChange={event => setDisplayName(event.target.value)} /></label>
          <label className="grid gap-1">{a.ownerUnit}<input maxLength={64} value={ownerUnit}
            onChange={event => setOwnerUnit(event.target.value)} /></label>
          <label className="grid gap-1">{a.deploymentUnits}<input value={deploymentUnits}
            onChange={event => setDeploymentUnits(event.target.value)} /></label>
          <div><Button type="submit" disabled={busy}>{a.save}</Button></div>
        </form> : (
          <dl className="grid gap-1 text-sm">
            <dt>{a.ownerUnit}</dt><dd>{app.ownerUnit ?? "—"}</dd>
            <dt>{a.deploymentUnits}</dt><dd>{app.deploymentUnits?.join(", ") || "—"}</dd>
          </dl>
        )}
        {canManage && <div className="space-y-2 border-t border-[var(--border)] pt-4">
          <h3 className="font-semibold">{a.keyHistory}</h3>
          {keysLoaded && history.length === 0 && <p className="text-sm">{a.noRotations}</p>}
          <ul className="space-y-1 text-sm">{history.map(item => (
            <li key={item.rotationId}>
              <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString(language)}</time>
              {" · "}{item.appliedAt ? a.synchronized : a.waiting}
            </li>
          ))}</ul>
          {editable && <Button variant="outline" disabled={busy || !keysLoaded} onClick={() => {
            if (!window.confirm(a.rotationConfirm)) return;
            const key = history.find(item => !item.appliedAt)?.rotationId ?? rotationKey ?? crypto.randomUUID();
            setRotationKey(key);
            void apply(async () => {
              setHistory((await api.rotateApplicationOidcKey(app.appId, key)).items);
              setRotationKey(undefined);
            });
          }}>{a.rotate}</Button>}
        </div>}
      </CardContent>
    </Card>
  );
};
