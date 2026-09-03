import { useEffect } from "react";
import { Link, useRouteError } from "react-router-dom";
import { buttonClassName } from "@/app/components/ui/button";

export default function RouteError() {
    const error = useRouteError();
    useEffect(() => {
        console.error("App error:", error);
    }, [error]);
    return (
        <div className="min-h-screen bg-white flex items-center justify-center px-4">
            <div className="text-center max-w-md">
                <h1 className="mb-3 text-3xl font-light text-gray-900">
                    Something went wrong
                </h1>
                <p className="text-[0.9375rem] text-gray-500 leading-relaxed mb-8">
                    We encountered an unexpected error. This has been logged and
                    our team will look into it.
                </p>
                <Link to="/" className={buttonClassName({ variant: "black", size: "normal" })}>
                    Home
                </Link>
            </div>
        </div>
    );
}
