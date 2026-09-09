import { FilePlus2 } from "lucide-react";
import { buttonClassName } from "@/app/components/ui/button";
import { cn } from "@/app/lib/utils";

export function FileInputButton({ multiple, disabled, label, ariaLabel, accept, onFiles, variant = "primary", compact = false, className }: {
  multiple: boolean; disabled: boolean; label: string; accept: string; className?: string;
  ariaLabel?: string;
  onFiles: (files: File[]) => void; variant?: "primary" | "outline"; compact?: boolean;
}) {
  return <label className={buttonClassName({
    variant: variant === "primary" ? "default" : "outline",
    size: compact ? "compact" : "default",
    className: cn("cursor-pointer focus-within:ring-3 focus-within:ring-ring/50",
      disabled && "pointer-events-none opacity-50", className),
  })}><FilePlus2 className="h-4 w-4" /> {label}
    <input className="sr-only" type="file" aria-label={ariaLabel} multiple={multiple} accept={accept} disabled={disabled}
      onChange={(event) => { onFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
  </label>;
}
