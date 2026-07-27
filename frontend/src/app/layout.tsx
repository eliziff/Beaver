import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "@/app/components/providers";

export const metadata: Metadata = {
    metadataBase: new URL("https://app.mikeoss.com"),
    title: "Beaver - AI Legal Platform",
    description:
        "AI-powered legal document analysis and contract review platform.",
    icons: {
        icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
    },
    openGraph: {
        type: "website",
        url: "https://app.mikeoss.com",
        siteName: "Beaver",
        title: "Beaver - AI Legal Platform",
        description:
            "AI-powered legal document analysis and contract review platform.",
    },
    twitter: {
        card: "summary",
        title: "Beaver - AI Legal Platform",
        description:
            "AI-powered legal document analysis and contract review platform.",
    },
};

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html lang="en">
            <body className="font-sans antialiased">
                <Providers>{children}</Providers>
            </body>
        </html>
    );
}
