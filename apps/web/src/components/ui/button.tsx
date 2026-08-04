import { cva } from "class-variance-authority";

export const buttonVariants = cva(
  "inline-flex min-h-11 items-center justify-center rounded border px-4 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "border-transparent bg-[var(--accent)] text-[var(--accent-contrast)] hover:bg-[var(--accent-strong)]",
        outline: "border-[var(--border-strong)] bg-transparent text-[var(--fg-primary)] hover:bg-[var(--bg-subtle)]",
        destructive: "border-transparent bg-[var(--danger)] text-white hover:brightness-90",
      },
    },
    defaultVariants: { variant: "default" },
  },
);
