// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React, { useState } from "react";
import { Check, Copy } from "lucide-react";
import { useI18n } from "../../locales/i18n";
import { maskValue, type MaskKind } from "../../services/masking";

interface MaskedValueProps {
  value: string;
  kind?: MaskKind;
  canCopy?: boolean;
  className?: string;
  fullClassName?: string;
}

export const MaskedValue: React.FC<MaskedValueProps> = ({
  value,
  kind = "auto",
  canCopy = false,
  className = "",
  fullClassName = "",
}) => {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // The masked value remains readable when the clipboard is unavailable.
    }
  };

  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 ${className}`}>
      <span
        title={t.common.maskedHint}
        className={`min-w-0 break-all font-mono text-slate-500 dark:text-slate-400 ${fullClassName}`}
      >
        {maskValue(value, kind)}
      </span>
      {canCopy && (
        <button
          type="button"
          onClick={() => void handleCopy()}
          aria-label={copied ? t.common.copied : t.common.copyFull}
          title={copied ? t.common.copied : t.common.copyFull}
          className="flex-shrink-0 rounded p-0.5 text-slate-400 transition-colors hover:text-[var(--text)]"
        >
          {copied ? (
            <Check className="h-3 w-3 text-teal-600 dark:text-teal-400" aria-hidden="true" />
          ) : (
            <Copy className="h-3 w-3" aria-hidden="true" />
          )}
        </button>
      )}
    </span>
  );
};
