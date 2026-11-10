// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React, { useState } from "react";
import { Check, ChevronDown, ChevronRight, Copy } from "lucide-react";
import {
  generateMaskedCurl,
  getApiAccess,
  getApiCopy,
} from "../../constants/apiDocsData";
import type { ApiDocEndpoint } from "../../constants/apiReferenceData";
import { useI18n } from "../../locales/i18n";
import { Badge, type BadgeVariant } from "../common/Badge";
import { Button } from "../common/Button";
import { Card } from "../common/Card";
import { CodeBlock } from "../common/CodeBlock";


const HIDDEN_RESPONSE_FIELDS = new Set([
  "digest",
  "hash",
  "headHash",
  "resourceDigest",
  "requestId",
  "appId",
  "tenantId",
  "oauthClientId",
  "providerOrigin",
  "resourceId",
  "requesterAppId",
  "granteeAppId",
  "ownerSubject",
  "approvalId",
  "shareId",
]);

function readableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(readableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !HIDDEN_RESPONSE_FIELDS.has(key))
        .map(([key, entry]) => [
          key,
          key === "id" ? "example-id" : readableValue(entry),
        ])
    );
  }
  if (typeof value === "string") {
    if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value)) return "example";
    if (/^sha256:/i.test(value) || /^[0-9a-f]{16,}$/i.test(value)) {
      return "example";
    }
  }
  return value;
}

function readableResponse(raw: string): string {
  try {
    return JSON.stringify(readableValue(JSON.parse(raw)), null, 2);
  } catch {
    return raw;
  }
}

function methodVariant(method: string): BadgeVariant {
  switch (method) {
    case "GET":
    case "HEAD":
      return "method-get";
    case "POST":
      return "method-post";
    case "PUT":
    case "PATCH":
      return "method-put";
    case "DELETE":
      return "method-delete";
    default:
      return "default";
  }
}

function fill(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replace(`{${key}}`, String(value)),
    template,
  );
}

interface ApiDocsRowProps {
  endpoint: ApiDocEndpoint;
  expanded: boolean;
  onToggle: () => void;
  baseUrl: string;
}

export const ApiDocsRow: React.FC<ApiDocsRowProps> = ({
  endpoint,
  expanded,
  onToggle,
  baseUrl,
}) => {
  const { t, language } = useI18n();
  const copy = t.docs.apiDocs;
  const text = getApiCopy(endpoint, language);
  const access = getApiAccess(endpoint);
  const detailsId = `api-doc-${endpoint.operationId}`;
  const curl = generateMaskedCurl(endpoint, baseUrl);
  const [copied, setCopied] = useState(false);

  const accessLabel =
    access.kind === "public"
      ? copy.accessPublic
      : access.kind === "authenticated"
        ? copy.accessAuth
        : fill(copy.accessPermission, {
            permission: access.permissions.join(", "),
          });

  const accessClass =
    access.kind === "public"
      ? "border-teal-200 bg-teal-50 text-teal-700 dark:border-teal-800 dark:bg-teal-950/50 dark:text-teal-300"
      : access.kind === "authenticated"
        ? "border-slate-200 bg-slate-50 text-slate-600 dark:border-[#243843] dark:bg-[#1B303B]/50 dark:text-slate-300"
        : "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-300";

  const parameters = [
    ...endpoint.pathParameters.map((parameter) => ({
      ...parameter,
      location: copy.path,
    })),
    ...endpoint.queryParameters.map((parameter) => ({
      ...parameter,
      location: copy.query,
    })),
    ...endpoint.headerParameters.map((parameter) => ({
      ...parameter,
      location: copy.header,
    })),
  ];

  const handleCopyCurl = async () => {
    try {
      await navigator.clipboard.writeText(curl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied; the code block still allows manual copy.
    }
  };

  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={detailsId}
        aria-label={`${expanded ? copy.collapse : copy.expand}: ${endpoint.method} ${endpoint.path}`}
        className="w-full p-3.5 text-left transition-colors hover:bg-slate-50/80 dark:hover:bg-[#1B303B]/30"
      >
        <div className="flex items-start gap-3">
          <Badge variant={methodVariant(endpoint.method)}>
            {endpoint.method}
          </Badge>
          <div className="min-w-0 flex-1">
            <code className="block break-all font-mono text-sm font-semibold text-stone-ink dark:text-slate-100">
              {endpoint.path}
            </code>
            <p className="mt-1 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              {text.summary}
            </p>
          </div>
          <div className="hidden flex-shrink-0 items-center gap-2 sm:flex">
            <span
              className={`rounded border px-2 py-0.5 text-xs font-medium ${accessClass}`}
            >
              {accessLabel}
            </span>
            {expanded ? (
              <ChevronDown className="h-4 w-4 text-slate-400" aria-hidden="true" />
            ) : (
              <ChevronRight className="h-4 w-4 text-slate-400" aria-hidden="true" />
            )}
          </div>
        </div>
        <div className="mt-2 flex items-center justify-between gap-2 sm:hidden">
          <span
            className={`rounded border px-2 py-0.5 text-xs font-medium ${accessClass}`}
          >
            {accessLabel}
          </span>
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-slate-400" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-4 w-4 text-slate-400" aria-hidden="true" />
          )}
        </div>
      </button>

      {expanded && (
        <div
          id={detailsId}
          className="space-y-5 border-t border-slate-100 bg-slate-50/40 p-4 dark:border-[#243843]/70 dark:bg-[#1B303B]/20 sm:p-5"
        >
          <section>
            <h4 className="mb-1 text-sm font-semibold text-stone-ink dark:text-slate-200">
              {copy.whenLabel}
            </h4>
            <p className="text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              {text.when}
            </p>
          </section>

          <section>
            <h4 className="mb-2 text-sm font-semibold text-stone-ink dark:text-slate-200">
              {copy.parameters}
            </h4>
            {parameters.length === 0 ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">
                {copy.noParameters}
              </p>
            ) : (
              <div className="overflow-x-auto rounded border border-slate-200 bg-white/70 dark:border-[#243843] dark:bg-[#13242D]">
                <table className="w-full min-w-[32rem] text-left text-sm">
                  <thead className="bg-slate-100/70 text-xs uppercase tracking-wide text-slate-500 dark:bg-[#1B303B] dark:text-slate-400">
                    <tr>
                      <th className="px-3 py-2 font-semibold">{copy.paramName}</th>
                      <th className="px-3 py-2 font-semibold">{copy.paramIn}</th>
                      <th className="px-3 py-2 font-semibold">
                        {copy.paramRequired}
                      </th>
                      <th className="px-3 py-2 font-semibold">
                        {copy.paramDescription}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-[#243843]/70">
                    {parameters.map((parameter) => (
                      <tr key={`${parameter.location}-${parameter.name}`}>
                        <td className="px-3 py-2">
                          <code className="font-mono text-xs font-semibold text-stone-ink dark:text-slate-100">
                            {parameter.name}
                          </code>
                        </td>
                        <td className="px-3 py-2 text-slate-500 dark:text-slate-400">
                          {parameter.location}
                        </td>
                        <td className="px-3 py-2 text-slate-500 dark:text-slate-400">
                          {parameter.required
                            ? copy.requiredLabel
                            : copy.optionalLabel}
                        </td>
                        <td className="px-3 py-2 leading-relaxed text-slate-600 dark:text-slate-300">
                          {parameter.description || "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <section>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <h4 className="text-sm font-semibold text-stone-ink dark:text-slate-200">
                  {copy.curlExample}
                </h4>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void handleCopyCurl()}
                  leftIcon={
                    copied ? (
                      <Check className="h-3.5 w-3.5 text-teal-500" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )
                  }
                >
                  {copied ? t.common.copied : copy.copyCurl}
                </Button>
              </div>
              <CodeBlock code={curl} language="bash" />
            </section>
            <section>
              <h4 className="mb-1.5 text-sm font-semibold text-stone-ink dark:text-slate-200">
                {copy.responseExample}
              </h4>
              {endpoint.responseExample ? (
                <CodeBlock
                  code={readableResponse(endpoint.responseExample)}
                  language="json"
                />
              ) : (
                <p className="rounded border border-slate-200 bg-white/60 p-3 text-sm text-slate-500 dark:border-[#243843] dark:bg-[#13242D] dark:text-slate-400">
                  {copy.noResponseBody}
                </p>
              )}
            </section>
          </div>

          <section>
            <h4 className="mb-2 text-sm font-semibold text-stone-ink dark:text-slate-200">
              {copy.responses}
            </h4>
            <div className="flex flex-wrap gap-1.5">
              {endpoint.responses.map((code) => {
                const label =
                  copy.codes[code as keyof typeof copy.codes] ?? code;
                const tone = code.startsWith("2")
                  ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300"
                  : code.startsWith("3")
                    ? "border-[var(--accent)]/30 bg-[var(--accent-soft)] text-[var(--accent)] dark:bg-[var(--accent)]/10"
                    : code.startsWith("4")
                      ? "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-300"
                      : "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950/60 dark:text-rose-300";
                return (
                  <span
                    key={code}
                    className={`rounded border px-2 py-0.5 font-mono text-xs ${tone}`}
                  >
                    <span className="font-semibold">{code}</span> {label}
                  </span>
                );
              })}
            </div>
          </section>
        </div>
      )}
    </Card>
  );
};
