import { cn } from "@/lib/utils";

export function Logo({
  className,
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <span className="relative grid size-9 place-items-center rounded-xl bg-gradient-to-br from-[var(--ember)] to-[var(--primary)] p-1 shadow-[0_4px_14px_-4px_rgba(219,74,11,0.7)]">
        {/* KAP Branding Logo */}
        <img src="/kap-logo.webp" alt="KAP Logo" className="size-7 object-contain invert brightness-200" />
      </span>
      {!compact && (
        <span className="flex flex-col leading-none">
          <span className="font-display text-[15px] font-extrabold tracking-tight">
            RAIN OF PHYSICS
          </span>
          <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
            Live Classroom
          </span>
        </span>
      )}
    </span>
  );
}
