import type { ReactNode } from "react";
import { ProjectWorkspaceProvider } from "@/app/components/projects/ProjectWorkspace";
export default async function ProjectLayout({
    params,
    children,
}: { params: Promise<{ id: string }>; children: ReactNode }) {
    const { id } = await params;
    return (
        <ProjectWorkspaceProvider key={id} projectId={id}>
            {children}
        </ProjectWorkspaceProvider>
    );
}
