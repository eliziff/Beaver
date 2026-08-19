import { useEffect } from "react";
import { Link, useRouteError } from "react-router-dom";
import { pillButtonClassName } from "@/app/components/ui/pill-button";

export default function RouteError() {
    const error = useRouteError();
    useEffect(() => {
        console.error("App error:", error);
    }, [error]);
    return (
        <div className="min-h-screen bg-white flex items-center justify-center px-4">
            <div className="text-center max-w-md">
                <h1 className="text-3xl font-eb-garamond font-light text-gray-900 mb-3">
                    Something went wrong
                </h1>
                <p className="text-[0.9375rem] text-gray-500 leading-relaxed mb-8">
                    We encountered an unexpected error. This has been logged and
                    our team will look into it.
                </p>
                <Link to="/" className={pillButtonClassName("black", "normal")}>
                    Home
                </Link>
            </div>
        </div>
    );
}
