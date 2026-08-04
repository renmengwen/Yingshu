import * as AccordionPrimitive from "@radix-ui/react-accordion";
import type * as React from "react";

import { cn } from "../../lib/utils";

export const Accordion = AccordionPrimitive.Root;
export const AccordionItem = AccordionPrimitive.Item;

export function AccordionTrigger({ className, children, ...props }: React.ComponentProps<typeof AccordionPrimitive.Trigger>) {
  return (
    <AccordionPrimitive.Header className="flex">
      <AccordionPrimitive.Trigger
        className={cn(
          "group flex min-h-11 flex-1 items-center justify-between gap-3 rounded px-3 py-2 text-left text-sm font-semibold transition-colors hover:bg-[var(--bg-hover)] data-[state=open]:bg-[var(--bg-subtle)]",
          className,
        )}
        {...props}
      >
        {children}
        <span className="font-mono text-[11px] text-[var(--fg-tertiary)] group-data-[state=open]:hidden" aria-hidden="true">展开</span>
        <span className="hidden font-mono text-[11px] text-[var(--fg-tertiary)] group-data-[state=open]:inline" aria-hidden="true">收起</span>
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  );
}

export function AccordionContent({ className, ...props }: React.ComponentProps<typeof AccordionPrimitive.Content>) {
  return (
    <AccordionPrimitive.Content
      className={cn(
        "overflow-hidden border-t border-[var(--border-subtle)] data-[state=closed]:animate-none",
        className,
      )}
      {...props}
    />
  );
}
