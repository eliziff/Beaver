import { Outlet, useParams } from "react-router-dom";
import { ProjectWorkspaceProvider } from "@/app/components/projects/ProjectWorkspace";
export default function ProjectLayout() {
    const { id = "" } = useParams<{ id: string }>();
    return (
        <ProjectWorkspaceProvider key={id} projectId={id}>
            <Outlet />
        </ProjectWorkspaceProvider>
    );
}
