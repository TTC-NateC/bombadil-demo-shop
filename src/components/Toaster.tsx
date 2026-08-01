"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Toasts. specs/03 §4.
 *
 * Hand-rolled rather than shadcn/ui Toast or Sonner: §4.2's requirements are
 * specific and directly testable (3s/5s auto-dismiss, hover pauses the timer,
 * manual close always available, aria-live polite vs assertive per variant),
 * and owning the markup is what makes `data-variant` and the aria-live split
 * assertable without fighting a library's DOM.
 */

export type ToastVariant = "success" | "info" | "warning";

export interface ToastPayload {
  message: string;
  variant?: ToastVariant;
  action?: { label: string; run: () => void | Promise<void> };
}

interface ActiveToast extends ToastPayload {
  id: number;
  variant: ToastVariant;
}

const TOAST_EVENT = "cart:toast";
const DURATION: Record<ToastVariant, number> = {
  success: 3000,
  info: 3000,
  warning: 5000, // longer, so it can actually be read
};

/** Fire a toast from anywhere in the client tree. */
export function toast(payload: ToastPayload) {
  window.dispatchEvent(new CustomEvent<ToastPayload>(TOAST_EVENT, { detail: payload }));
}

export function Toaster() {
  const [toasts, setToasts] = useState<ActiveToast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  useEffect(() => {
    const onToast = (event: Event) => {
      const detail = (event as CustomEvent<ToastPayload>).detail;
      setToasts((current) => {
        const next = [...current, { ...detail, variant: detail.variant ?? "info", id: nextId.current++ }];
        // Never more than a few visible at once; oldest expire first.
        return next.slice(-3);
      });
    };

    window.addEventListener(TOAST_EVENT, onToast);
    return () => window.removeEventListener(TOAST_EVENT, onToast);
  }, []);

  return (
    <>
      {/* Split regions: errors interrupt, everything else waits its turn. */}
      <div
        aria-live="polite"
        data-testid="toast-region-polite"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4 sm:items-end"
      >
        {toasts
          .filter((t) => t.variant !== "warning")
          .map((t) => (
            <ToastCard key={t.id} toast={t} onDismiss={dismiss} />
          ))}
      </div>
      <div
        aria-live="assertive"
        data-testid="toast-region-assertive"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4 sm:items-end"
      >
        {toasts
          .filter((t) => t.variant === "warning")
          .map((t) => (
            <ToastCard key={t.id} toast={t} onDismiss={dismiss} />
          ))}
      </div>
    </>
  );
}

const STYLES: Record<ToastVariant, string> = {
  success:
    "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100",
  info: "border-neutral-300 bg-white text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100",
  warning:
    "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100",
};

function ToastCard({
  toast: item,
  onDismiss,
}: {
  toast: ActiveToast;
  onDismiss: (id: number) => void;
}) {
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) return;
    const timer = setTimeout(() => onDismiss(item.id), DURATION[item.variant]);
    return () => clearTimeout(timer);
  }, [paused, item.id, item.variant, onDismiss]);

  return (
    <div
      role="status"
      data-testid="toast"
      data-variant={item.variant}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      className={`pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg border px-4 py-3 text-sm shadow-lg ${STYLES[item.variant]}`}
    >
      <span className="flex-1">{item.message}</span>

      {item.action && (
        <button
          type="button"
          data-testid="toast-action"
          onClick={() => {
            void item.action?.run();
            onDismiss(item.id);
          }}
          className="font-medium underline underline-offset-2"
        >
          {item.action.label}
        </button>
      )}

      <button
        type="button"
        data-testid="toast-close"
        aria-label="Dismiss notification"
        onClick={() => onDismiss(item.id)}
        className="opacity-60 transition hover:opacity-100"
      >
        ×
      </button>
    </div>
  );
}
