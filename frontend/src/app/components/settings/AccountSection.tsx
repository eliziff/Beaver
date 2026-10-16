import { cn } from "@/app/lib/utils";

export const accountGlassInputClassName = cn(
    "rounded-lg px-3 text-gray-900 placeholder:text-gray-400",
    "border border-gray-200 bg-gray-50 shadow-none",
    "focus-visible:border-gray-200 focus-visible:ring-2 focus-visible:ring-gray-300/45",
    "disabled:cursor-not-allowed disabled:text-gray-700 disabled:opacity-100 disabled:placeholder:text-gray-600",
);
export const accountGlassPrimaryButtonClassName =
    "rounded-lg border border-transparent bg-transparent px-3 text-gray-900 shadow-none hover:bg-gray-100 hover:text-gray-950 active:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-45";
export const accountGlassDangerOutlineButtonClassName =
    "rounded-lg border border-transparent bg-transparent px-3 text-red-600 shadow-none hover:bg-red-50 hover:text-red-700 active:bg-red-100 disabled:cursor-not-allowed disabled:opacity-45";
export const accountGlassIconButtonClassName =
    "justify-center rounded-lg bg-transparent px-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:cursor-not-allowed disabled:opacity-40";

/** The bordered panel settings sit in. */
export function AccountSection({ children, className, ...props }:
    React.HTMLAttributes<HTMLDivElement> & { children: React.ReactNode }) {
    return <div className={cn("overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm", className)} {...props}>
        {children}
    </div>;
}

/** A settings section: its heading, an optional sentence saying what it does, and its controls. */
export function SettingsSection({ title, description, action, children }: {
    title: string; description?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode;
}) {
    return <section>
        <div className="mb-3 flex items-start justify-between gap-3">
            <div className="min-w-0">
                <h2 className="text-base font-semibold text-gray-900">{title}</h2>
                {description && <p className="mt-1 max-w-2xl text-sm leading-6 text-gray-600">{description}</p>}
            </div>
            {action}
        </div>
        {children}
    </section>;
}

/** A titled setting and its control. */
export function SettingRow({ title, description, children }: {
    title: React.ReactNode; description: React.ReactNode; children: React.ReactNode;
}) {
    return <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-0.5">
            <p className="text-sm font-medium text-gray-900">{title}</p>
            <p className="text-sm text-gray-500">{description}</p>
        </div>
        {children}
    </div>;
}
