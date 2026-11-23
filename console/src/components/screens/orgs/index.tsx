// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React, { useEffect, useState } from "react";
import { Building2 } from "lucide-react";
import { ApiError, api } from "../../../services/apiClient";
import { useSession } from "../../../services/session";
import { useI18n } from "../../../locales/i18n";
import type { ApiPage, Application, DirectoryMember, DirectoryUnit } from "../../../types";
import { PageHeader } from "../../layout/PageHeader";
import { Button } from "../../common/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../../common/Card";
import { ErrorState } from "../../common/ErrorState";
import { ForbiddenNotice } from "../../common/ForbiddenNotice";
import { appDetailHash } from "../apps/route";

const emptyPage = { items: [], nextCursor: null };

const UnitDetail: React.FC<{ unit: DirectoryUnit }> = ({ unit }) => {
  const { t } = useI18n();
  const a = t.appAccess;
  const [members, setMembers] = useState<ApiPage<DirectoryMember>>(emptyPage);
  const [apps, setApps] = useState<ApiPage<Application>>(emptyPage);
  const [memberError, setMemberError] = useState(false);
  const [appsError, setAppsError] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let current = true;
    void Promise.all([
      api.listDirectoryMembers(unit.unit).then(page => { if (current) setMembers(page); })
        .catch(() => { if (current) setMemberError(true); }),
      api.listApplications({ unit: unit.unit }).then(page => { if (current) setApps(page); })
        .catch(() => { if (current) setAppsError(true); }),
    ]).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [unit.unit]);

  return (
    <Card>
      <CardHeader><CardTitle>{unit.name}</CardTitle></CardHeader>
      <CardContent className="space-y-5">
        {loading && <p role="status">{a.loading}</p>}
        <section>
          <h3 className="font-semibold">{a.members}</h3>
          {memberError ? <p role="alert">{a.failed}</p> : (
            <>
              {!loading && members.items.length === 0 && <p className="text-sm text-[var(--muted)]">{a.noMembers}</p>}
              <ul className="divide-y divide-[var(--border)] text-sm">
                {members.items.map(member => <li className="break-words py-2" key={member.subject}>
                  <span>{member.subject}</span>
                  {member.groups.length > 0 && <span className="ml-2 text-[var(--muted)]">{member.groups.join(", ")}</span>}
                </li>)}
              </ul>
              {members.nextCursor && <Button size="sm" variant="outline" onClick={() => {
                void api.listDirectoryMembers(unit.unit, members.nextCursor ?? undefined)
                  .then(page => setMembers({ ...page, items: [...members.items, ...page.items] }))
                  .catch(() => setMemberError(true));
              }}>{a.nextPage}</Button>}
            </>
          )}
        </section>
        <section className="border-t border-[var(--border)] pt-4">
          <h3 className="font-semibold">{a.unitApps}</h3>
          {appsError ? <p role="alert">{a.failed}</p> : (
            <>
              {!loading && apps.items.length === 0 && <p className="text-sm text-[var(--muted)]">{a.noUnitApps}</p>}
              <ul className="space-y-1 text-sm">
                {apps.items.map(app => <li key={app.appId}>
                  <a className="text-[var(--accent)] underline" href={appDetailHash(app.appId)}>{app.displayName}</a>
                </li>)}
              </ul>
              {apps.nextCursor && <Button size="sm" variant="outline" onClick={() => {
                void api.listApplications({ unit: unit.unit, cursor: apps.nextCursor ?? undefined })
                  .then(page => setApps({ ...page, items: [...apps.items, ...page.items] }))
                  .catch(() => setAppsError(true));
              }}>{a.nextPage}</Button>}
            </>
          )}
        </section>
      </CardContent>
    </Card>
  );
};

export const OrganizationsScreen: React.FC = () => {
  const { t } = useI18n();
  const { user } = useSession();
  const a = t.appAccess;
  const [units, setUnits] = useState<ApiPage<DirectoryUnit>>(emptyPage);
  const [unitKey, setUnitKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(null);
    void api.listDirectoryUnits().then(page => { if (current) setUnits(page); })
      .catch(failure => { if (current) setError(failure instanceof ApiError ? failure.status : 503); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [nonce]);

  const unit = units.items.find(item => item.unit === unitKey);
  return (
    <div className="space-y-6">
      <PageHeader title={t.orgs.title} subtitle={a.orgSubtitle}
        actions={<Button variant="outline" isLoading={loading} onClick={() => setNonce(value => value + 1)}>{t.common.refresh}</Button>} />
      {error === 403 ? <ForbiddenNotice /> : error ? (
        <ErrorState title={error === 401 ? t.orgs.sessionExpiredTitle : t.orgs.loadErrorTitle}
          message={error === 401 ? t.orgs.sessionExpiredDesc : a.failed} onRetry={() => setNonce(value => value + 1)} />
      ) : loading ? <p role="status">{a.loading}</p> : (
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(12rem,1fr)_minmax(0,2fr)]">
          <Card>
            <CardHeader><CardTitle>{a.unitTree}</CardTitle></CardHeader>
            <CardContent>
              <p className="flex items-center gap-2 font-semibold"><Building2 size={16} aria-hidden="true" />{user?.tenantId}</p>
              {units.items.length === 0 && <p className="text-sm text-[var(--muted)]">{a.noUnits}</p>}
              <ul className="ml-2 border-l border-[var(--border)] pl-3">
                {units.items.map(item => <li key={item.unit}>
                  <button type="button" aria-pressed={item.unit === unitKey}
                    className="w-full break-words rounded px-2 py-1.5 text-left text-sm aria-pressed:bg-[var(--surface-alt)] aria-pressed:font-semibold"
                    onClick={() => setUnitKey(item.unit)}>{item.name}</button>
                </li>)}
              </ul>
              {units.nextCursor && <Button size="sm" variant="outline" onClick={() => {
                void api.listDirectoryUnits(units.nextCursor ?? undefined)
                  .then(page => setUnits({ ...page, items: [...units.items, ...page.items] }))
                  .catch(() => setError(503));
              }}>{a.nextPage}</Button>}
            </CardContent>
          </Card>
          {unit && <UnitDetail key={unit.unit} unit={unit} />}
        </div>
      )}
    </div>
  );
};
