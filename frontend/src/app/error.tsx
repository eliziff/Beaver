import { useEffect, type ReactNode } from "react";
import { Link, useRouteError } from "react-router-dom";
import { buttonClassName } from "@/app/components/ui/button";

/** The centred card the error and not-found routes both render. */
export function MessagePage({ title, message, action }: {
    title: string; message: ReactNode; action: string;
}) {
    return (
        <div className="min-h-screen bg-white flex items-center justify-center px-4">
            <div className="text-center max-w-md">
                <h1 className="mb-3 text-3xl font-light text-gray-900">{title}</h1>
                <p className="text-[0.9375rem] text-gray-500 leading-relaxed mb-8">{message}</p>
                <Link to="/" className={buttonClassName()}>{action}</Link>
            </div>
        </div>
    );
}

export default function RouteError() {
    const error = useRouteError();
    useEffect(() => {
        console.error("App error:", error);
    }, [error]);
    return <MessagePage title="Something went wrong" action="Home"
        message="We encountered an unexpected error. This has been logged and our team will look into it." />;
}
