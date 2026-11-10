// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { CheckCircle2, X } from "lucide-react";
import { useI18n } from "../../locales/i18n";

const TOAST_DURATION_MS = 3500;

interface ToastMessage {
  id: number;
  text: string;
}

interface ToastContextValue {
  showToast: (text: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const { t } = useI18n();
  const [messages, setMessages] = useState<ToastMessage[]>([]);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setMessages((previous) => previous.filter((message) => message.id !== id));
  }, []);

  const showToast = useCallback(
    (text: string) => {
      const id = nextId.current++;
      setMessages((previous) => [...previous, { id, text }]);
      const timer = setTimeout(() => dismiss(id), TOAST_DURATION_MS);
      timers.current.set(id, timer);
    },
    [dismiss]
  );

  useEffect(() => {
    const activeTimers = timers.current;
    return () => {
      activeTimers.forEach((timer) => clearTimeout(timer));
      activeTimers.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div
        className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 w-[min(22rem,calc(100vw-2rem))]"
        aria-live="polite"
      >
        {messages.map((message) => (
          <div
            key={message.id}
            role="status"
            className="flex items-start gap-2.5 rounded-md border border-teal-200 bg-white px-4 py-3 text-sm text-stone-ink shadow-lg dark:border-teal-800 dark:bg-[#13242D] dark:text-slate-100"
          >
            <CheckCircle2
              className="mt-0.5 h-4 w-4 flex-shrink-0 text-teal-600 dark:text-teal-400"
              aria-hidden="true"
            />
            <span className="flex-1 leading-relaxed">{message.text}</span>
            <button
              type="button"
              onClick={() => dismiss(message.id)}
              className="rounded p-0.5 text-slate-400 transition-colors hover:text-slate-700 dark:hover:text-slate-200"
              aria-label={t.toast.close}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return context;
}
