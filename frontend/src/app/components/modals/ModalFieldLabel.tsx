import { cloneElement, type ComponentPropsWithoutRef, type ReactElement, type ReactNode } from "react";
import { cn } from "@/app/lib/utils";
type ModalFieldLabelProps = ComponentPropsWithoutRef<"label"> & {
    children: ReactNode;
};
export function FieldGroup({ legend, children, className, ...props }:
    ComponentPropsWithoutRef<"fieldset"> & { legend: ReactNode }) {
    return <fieldset className={cn("space-y-2", className)} {...props}>
        <legend className="mb-2 block text-xs font-medium text-gray-700">{legend}</legend>
        {children}
    </fieldset>;
}
export function FormField({ label, htmlFor, hint, children, className }: {
    label: ReactNode; htmlFor: string; hint?: ReactNode;
    children: ReactElement<Record<string, unknown>>; className?: string;
}) {
    const hintId = hint ? `${htmlFor}-hint` : undefined;
    const describedBy = [children.props["aria-describedby"], hintId]
        .filter(Boolean).join(" ") || undefined;
    return <div className={className}>
        <ModalFieldLabel htmlFor={htmlFor}>{label}</ModalFieldLabel>
        {cloneElement(children, { id: htmlFor, "aria-describedby": describedBy })}
        {hint && <p id={hintId} className="mt-1 text-xs text-gray-500">{hint}</p>}
    </div>;
}
export function ModalFieldLabel({
    children,
    className,
    ...props
}: ModalFieldLabelProps) {
    const classes = cn(
        "mb-2 block text-xs font-medium text-gray-700",
        className,
    );
    return (
        <label className={classes} {...props}>
            {children}
        </label>
    );
}
