import { Outlet } from "react-router-dom";
import { Providers, type LoginGate } from "@/app/components/providers";

export default function Root({ LoginGate }: { LoginGate?: LoginGate }) {
    return (
        <Providers LoginGate={LoginGate}>
            <Outlet />
        </Providers>
    );
}
