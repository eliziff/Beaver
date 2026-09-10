import { cn } from "@/app/lib/utils";
export function AccountSection({
    children,
    className,
    heading,
    ...props
}: React.HTMLAttributes<HTMLDivElement> & {
    children: React.ReactNode;
    heading?: React.ReactNode;
}) {
    const panel = (
        <div className={cn("overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm", className)} {...props}>
            {children}
        </div>
    );
    return heading ? (
        <section className="space-y-3">
            <h2 className="text-lg font-semibold text-gray-900">
                {heading}
            </h2>
            {panel}
        </section>
    ) : (
        panel
    );
}
