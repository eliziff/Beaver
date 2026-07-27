import type { NextConfig } from "next";

const apiBase =
    process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/+$/u, "") ||
    "http://localhost:3001";

const nextConfig: NextConfig = {
    /* config options here */
    reactCompiler: true,
    experimental: {
        turbopackFileSystemCacheForBuild: true,
    },
    allowedDevOrigins: ["localhost", "127.0.0.1"],
    turbopack: {
        root: __dirname,
    },
    async rewrites() {
        return [
            {
                source: "/sitemap.xml",
                destination: "/api/sitemap/sitemap.xml",
            },
            {
                source: "/sitemap_:slug.xml",
                destination: "/api/sitemap/sitemap_:slug.xml",
            },
            {
                source: "/single-documents/:documentId/display",
                destination: `${apiBase}/single-documents/:documentId/display`,
            },
            {
                source: "/single-documents/:documentId/evidence-view",
                destination: `${apiBase}/single-documents/:documentId/evidence-view`,
            },
        ];
    },
    skipTrailingSlashRedirect: true,
};

export default nextConfig;
