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
/** A titled setting and its control, the row shape every account panel uses. */
export function AccountSettingRow({ title, description, children }: {
    title: React.ReactNode;
    description: React.ReactNode;
    children: React.ReactNode;
}) {
    return (
        <div className="flex flex-col gap-3 px-4 py-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
                <p className="text-sm font-medium text-gray-900">{title}</p>
                <p className="text-sm text-gray-500">{description}</p>
            </div>
            {children}
        </div>
    );
}
