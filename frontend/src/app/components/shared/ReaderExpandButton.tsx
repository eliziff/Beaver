import { Maximize2, Minimize2 } from "lucide-react";
import { Button } from "../ui/button";

export function ReaderExpandButton({ expanded, onChange }: {
    expanded: boolean; onChange: (expanded: boolean) => void;
}) {
    const Icon = expanded ? Minimize2 : Maximize2;
    const label = expanded ? "Restore reader size" : "Expand reader";
    return <Button type="button" variant="outline" size="icon-sm"
        aria-label={label} title={label} aria-pressed={expanded}
        onClick={() => onChange(!expanded)}>
        <Icon className="size-3.5" aria-hidden="true" />
    </Button>;
}
