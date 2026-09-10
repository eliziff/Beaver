import { cloneElement, type ComponentPropsWithoutRef, type ReactElement, type ReactNode } from "react";
import { cn } from "@/app/lib/utils";
export function FieldGroup({ legend, children, className, ...props }:
    ComponentPropsWithoutRef<"fieldset"> & { legend: ReactNode }) {
    return <fieldset className={cn("space-y-2", className)} {...props}>
        <legend className="mb-2 block text-xs font-medium text-gray-700">{legend}</legend>
        {children}
    </fieldset>;
}
export function FormField({ label, htmlFor, children }: {
    label: ReactNode; htmlFor: string;
    children: ReactElement<Record<string, unknown>>;
}) {
    return <div>
        <ModalFieldLabel htmlFor={htmlFor}>{label}</ModalFieldLabel>
        {cloneElement(children, { id: htmlFor })}
    </div>;
}
export function ModalFieldLabel({
    children,
    className,
    ...props
}: ComponentPropsWithoutRef<"label"> & { children: ReactNode }) {
    return (
        <label className={cn("mb-2 block text-xs font-medium text-gray-700", className)} {...props}>
            {children}
        </label>
    );
}
