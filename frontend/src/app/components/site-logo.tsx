import { Link } from "react-router-dom";
import { BeaverIcon } from "@/app/components/chat/beaver-icon";
interface SiteLogoProps {
    size?: "sm" | "md" | "lg" | "xl";
    className?: string;
    iconClassName?: string;
    asLink?: boolean;
}
export function SiteLogo({
    size = "md",
    className = "",
    iconClassName = "",
    asLink = false,
}: SiteLogoProps) {
    const landingHref =
        process.env.NODE_ENV === "production"
            ? "https://mikeoss.com"
            : "http://localhost:3000";
    const sizeClasses = {
        sm: "text-xl",
        md: "text-2xl",
        lg: "text-4xl",
        xl: "text-6xl",
    };
    const iconSizes = {
        sm: 20,
        md: 22,
        lg: 30,
        xl: 48,
    };
    const logo = (
        <h1
            className={`flex items-center gap-1.5 ${sizeClasses[size]} font-light font-serif ${className}`}
        >
            <span
                className={`inline-flex shrink-0 items-center leading-none ${iconClassName}`}
            >
                <BeaverIcon size={iconSizes[size]} />
            </span>
            <span>Beaver</span>
        </h1>
    );
    if (asLink) {
        return (
            <Link
                to={landingHref}
                className="cursor-pointer hover:opacity-80"
            >
                {logo}
            </Link>
        );
    }
    return logo;
}
