import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";

import { cn } from "../../lib/utils";

type DialogContextValue = {
  onOpenChange: (open: boolean) => void;
  titleId: string;
  descriptionId: string;
};

const DialogContext = createContext<DialogContextValue | null>(null);
const focusableSelector = "button,a[href],input,textarea,select,[tabindex]:not([tabindex='-1'])";

type DialogProps = Omit<ComponentProps<"dialog">, "open" | "onCancel" | "onClick" | "ref"> & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialFocusRef?: RefObject<HTMLElement | null>;
  triggerRef?: RefObject<HTMLElement | null>;
};

export function Dialog({
  open,
  onOpenChange,
  initialFocusRef,
  triggerRef,
  className,
  children,
  onKeyDown,
  ...props
}: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const wasOpenRef = useRef(false);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      if (!dialog.open) dialog.showModal();
      initialFocusRef?.current?.focus();
    } else {
      if (dialog.open) dialog.close();
      if (wasOpenRef.current && triggerRef?.current?.isConnected) triggerRef.current.focus();
    }

    wasOpenRef.current = open;
  }, [initialFocusRef, open, triggerRef]);

  const requestClose = () => onOpenChange(false);
  const handleBackdropClick = (event: ReactMouseEvent<HTMLDialogElement>) => {
    if (event.target === event.currentTarget) requestClose();
  };
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDialogElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || event.key !== "Tab") return;

    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusableElements = Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector)).filter((element) => {
      const style = window.getComputedStyle(element);
      return !element.matches(":disabled")
        && element.getClientRects().length > 0
        && style.display !== "none"
        && style.visibility !== "hidden";
    });
    const first = focusableElements[0];
    const last = focusableElements.at(-1);
    if (!first || !last) return;

    const activeElement = document.activeElement;
    // Chrome 仍可能把原生 dialog 的末端 Tab 送到 BODY，这里只守住首尾边界。
    if (!activeElement || !dialog.contains(activeElement)) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return <DialogContext.Provider value={{ onOpenChange, titleId, descriptionId }}>
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      className={cn(
        "m-auto max-h-[calc(100dvh-2rem)] w-[min(calc(100vw-2rem),48rem)] max-w-none overflow-y-auto rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-0 text-[var(--fg-primary)] shadow-[var(--shadow-raised)] backdrop:bg-[var(--overlay)] max-sm:h-[calc(100dvh-1rem)] max-sm:max-h-[calc(100dvh-1rem)] max-sm:w-[calc(100vw-1rem)]",
        className,
      )}
      onCancel={(event) => {
        // 阻止浏览器先关闭，让领域层有机会拦截未保存修改。
        event.preventDefault();
        requestClose();
      }}
      onClick={handleBackdropClick}
      onKeyDown={handleKeyDown}
      {...props}
    >
      {children}
    </dialog>
  </DialogContext.Provider>;
}

function useDialogContext() {
  const context = useContext(DialogContext);
  if (!context) throw new Error("Dialog 子组件必须在 Dialog 内使用");
  return context;
}

export function DialogHeader({ className, ...props }: ComponentProps<"header">) {
  return <header className={cn("sticky top-0 z-10 grid gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-raised)] p-5 sm:p-6", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: ComponentProps<"footer">) {
  return <footer className={cn("sticky bottom-0 z-10 flex flex-col-reverse gap-2 border-t border-[var(--border-subtle)] bg-[var(--surface-raised)] p-4 sm:flex-row sm:justify-end sm:p-5", className)} {...props} />;
}

export function DialogTitle({ className, ...props }: Omit<ComponentProps<"h2">, "id">) {
  const { titleId } = useDialogContext();
  return <h2 id={titleId} className={cn("m-0 text-base font-semibold text-[var(--fg-primary)]", className)} {...props} />;
}

export function DialogDescription({ className, ...props }: Omit<ComponentProps<"p">, "id">) {
  const { descriptionId } = useDialogContext();
  return <p id={descriptionId} className={cn("m-0 text-sm leading-6 text-[var(--fg-secondary)]", className)} {...props} />;
}

export function DialogClose({ className, children = "关闭", onClick, type = "button", ...props }: ComponentProps<"button">) {
  const { onOpenChange } = useDialogContext();
  return <button
    type={type}
    className={cn("inline-flex min-h-11 min-w-11 items-center justify-center rounded border border-[var(--border-strong)] bg-transparent px-4 text-sm font-semibold text-[var(--fg-primary)] hover:bg-[var(--surface-secondary)]", className)}
    onClick={(event) => {
      onClick?.(event);
      if (!event.defaultPrevented) onOpenChange(false);
    }}
    {...props}
  >
    {children}
  </button>;
}
