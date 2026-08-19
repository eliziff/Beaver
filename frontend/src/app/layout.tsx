import { Outlet } from "react-router-dom";
import { Providers } from "@/app/components/providers";

export default function Root() {
    return (
        <Providers>
            <Outlet />
        </Providers>
    );
}
