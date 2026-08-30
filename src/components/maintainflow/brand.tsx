import { cn } from "@/lib/utils";

export function MaintainFlowBrand({
  compact = false,
  className,
}: {
  compact?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("inline-flex items-center gap-2.5", className)}>
      <span className="relative grid size-8 shrink-0 place-items-center overflow-hidden rounded-lg bg-primary shadow-sm">
        <span className="absolute left-1.5 top-2 h-1.5 w-5 rounded-full bg-white/95" />
        <span className="absolute bottom-2 left-1.5 h-1.5 w-3.5 rounded-full bg-white/70" />
      </span>
      {!compact && (
        <span className="text-[15px] font-semibold tracking-[-0.02em] text-foreground">
          MaintainFlow
        </span>
      )}
    </div>
  );
}
