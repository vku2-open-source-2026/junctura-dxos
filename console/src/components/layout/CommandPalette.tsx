// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React, { useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, Search } from "lucide-react";
import {
  MODULES,
  getModuleGroup,
  type ModuleDef,
  type ModuleId,
  type ScreenId,
} from "../../constants/modules";
import { useI18n } from "../../locales/i18n";
import { useSession } from "../../services/session";
import {
  PLATFORM_FUNCTION_LIST,
  type PlatformFunctionId,
} from "../../constants/platformFunctions";

export function normalizeForSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .trim();
}

interface PaletteItem {
  id: string;
  screen: ScreenId | null;
  platform: PlatformFunctionId | null;
  label: string;
  description: string;
  group: string;
}

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate: (screen: ScreenId) => void;
  onNavigatePlatform: (functionId: PlatformFunctionId) => void;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  open,
  onOpenChange,
  onNavigate,
  onNavigatePlatform,
}) => {
  const { t } = useI18n();
  const { can } = useSession();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        onOpenChange(!open);
        return;
      }
      if (
        !open &&
        event.key === "/" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !isEditableTarget(event.target)
      ) {
        event.preventDefault();
        onOpenChange(true);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const allItems = useMemo<PaletteItem[]>(() => {
    const moduleDefs: readonly ModuleDef[] = MODULES;
    const moduleItems = moduleDefs
      .filter((module) => can(module.perm) && module.id !== "services")
      .map((module) => {
        const id = module.id as ModuleId;
        const text = t.modules[id];
        const group = getModuleGroup(module.group);
        return {
          id: id,
          screen: id as ScreenId,
          platform: null,
          label: text.label,
          description: text.desc,
          group: group ? t.moduleGroups[group.id] : "",
        };
      });
    const platformItems: PaletteItem[] = PLATFORM_FUNCTION_LIST.map((fn) => {
      const text = t.platform.functions[fn.id];
      return {
        id: `platform:${fn.id}`,
        screen: null,
        platform: fn.id,
        label: text.name,
        description: text.short,
        group: t.platform.tierLabel,
      };
    });
    return [...platformItems, ...moduleItems];
  }, [can, t]);

  const items = useMemo<PaletteItem[]>(() => {
    const needle = normalizeForSearch(query);
    if (!needle) return allItems;
    return allItems.filter((item) => {
      const haystack = normalizeForSearch(
        `${item.label} ${item.description} ${item.group}`
      );
      return haystack.includes(needle);
    });
  }, [allItems, query]);

  useEffect(() => {
    if (activeIndex > items.length - 1) {
      setActiveIndex(Math.max(0, items.length - 1));
    }
  }, [items, activeIndex]);

  if (!open) return null;

  const selectableIndexes = items.map((_item, index) => index);

  const moveActive = (direction: 1 | -1) => {
    if (selectableIndexes.length === 0) return;
    const currentPosition = selectableIndexes.indexOf(activeIndex);
    const nextPosition =
      currentPosition < 0
        ? direction === 1
          ? 0
          : selectableIndexes.length - 1
        : (currentPosition + direction + selectableIndexes.length) %
          selectableIndexes.length;
    setActiveIndex(selectableIndexes[nextPosition]);
  };

  const choose = (item: PaletteItem | undefined) => {
    if (!item) return;
    if (item.platform) onNavigatePlatform(item.platform);
    else if (item.screen) onNavigate(item.screen);
    onOpenChange(false);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onOpenChange(false);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActive(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(items[activeIndex]);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center bg-slate-900/50 px-4 pt-[12vh] backdrop-blur-xs"
      onClick={() => onOpenChange(false)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t.palette.title}
        className="w-full max-w-xl overflow-hidden rounded-lg border border-slate-200 bg-white shadow-2xl dark:border-[#243843] dark:bg-[#0D1A22]"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-center gap-2.5 border-b border-slate-100 px-4 py-3 dark:border-[#243843]/70">
          <Search
            className="h-4 w-4 flex-shrink-0 text-slate-400"
            aria-hidden="true"
          />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            placeholder={t.palette.placeholder}
            aria-label={t.palette.placeholder}
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent text-sm text-stone-ink outline-none placeholder:text-slate-400 dark:text-slate-100"
          />
          <kbd className="hidden rounded border border-slate-200 px-1.5 py-0.5 text-sm text-slate-500 sm:inline dark:border-slate-700 dark:text-slate-400">
            Esc
          </kbd>
        </div>

        <div className="max-h-[55vh] overflow-y-auto py-1.5">
          {items.length === 0 ? (
            <p className="px-4 py-6 text-sm text-slate-500 dark:text-slate-400">
              {t.palette.noResults}
            </p>
          ) : (
            items.map((item, index) => {
              const active = index === activeIndex;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => choose(item)}
                  onMouseEnter={() => setActiveIndex(index)}
                  className={`flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                    active
                      ? "bg-[#E8F3F5] dark:bg-[#1B303B]"
                      : "hover:bg-slate-50 dark:hover:bg-[#1B303B]/50"
                  }`}
                >
                  <span className="flex-1 min-w-0">
                    <span className="block truncate text-sm font-medium text-stone-ink dark:text-slate-100">
                      {item.label}
                    </span>
                    <span className="block truncate text-sm text-slate-500 dark:text-slate-400">
                      {item.description}
                    </span>
                  </span>
                  <span className="hidden flex-shrink-0 text-sm text-slate-400 sm:block">
                    {item.group}
                  </span>
                  {active && (
                    <CornerDownLeft
                      className="h-3.5 w-3.5 flex-shrink-0 text-junctura-blue dark:text-[var(--accent)]"
                      aria-hidden="true"
                    />
                  )}
                </button>
              );
            })
          )}
        </div>

        <div className="border-t border-slate-100 px-4 py-2 text-sm text-slate-500 dark:border-[#243843]/70 dark:text-slate-400">
          {t.palette.hint}
        </div>
      </div>
    </div>
  );
};
