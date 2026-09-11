import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { Project } from "@/app/lib/api/projects";
import { NewProjectModal } from "./NewProjectModal";

const mocks = vi.hoisted(() => ({
    addDocumentToProject: vi.fn(),
    createProject: vi.fn(),
    uploadDocument: vi.fn(),
    uploadDirectory: vi.fn(),
}));

vi.mock("@/app/lib/api/documents", async (original) => ({
  ...await original<typeof import("@/app/lib/api/documents")>(),
  addDocumentToProject: mocks.addDocumentToProject,
  directoryResource: () => ({
        uploadDocument: mocks.uploadDocument,
        uploadDirectory: mocks.uploadDirectory,
    })
}));
vi.mock("@/app/lib/api/projects", async (original) => ({
  ...await original<typeof import("@/app/lib/api/projects")>(),
  createProject: mocks.createProject
}));
vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({
        user: { id: "user-1", email: "owner@example.test" },
    }),
}));
vi.mock("../shared/FileDirectory", () => ({
    FileDirectory: () => <div>Document picker</div>,
}));

const project: Project = {
    id: "project-1",
    user_id: "user-1",
    name: "Appeal",
    cm_number: "CM-42",
    practice: "Litigation",
    shared_with: [],
    created_at: "2026-07-29T00:00:00.000Z",
    updated_at: "2026-07-29T00:00:00.000Z",
};

beforeEach(() => {
    vi.clearAllMocks();
    mocks.createProject.mockResolvedValue(project);
    mocks.uploadDirectory.mockResolvedValue([]);
});

it("submits trimmed project details and reports the created project", async () => {
    const onClose = vi.fn();
    const onCreated = vi.fn();
    render(<NewProjectModal open onClose={onClose} onCreated={onCreated} />);

    fireEvent.change(screen.getByLabelText("Project name"), {
        target: { value: "  Appeal  " },
    });
    fireEvent.change(screen.getByLabelText("CM number"), {
        target: { value: "  CM-42  " },
    });
    expect(mocks.createProject).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Practice" }));
    fireEvent.click(screen.getByRole("button", { name: "Litigation" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Document picker")).toBeVisible();
    fireEvent.click(
        screen.getByRole("button", { name: "Create project" }),
    );

    await waitFor(() =>
        expect(mocks.createProject).toHaveBeenCalledWith(
            "Appeal",
            "CM-42",
            "Litigation",
            [],
        ),
    );
    expect(onCreated).toHaveBeenCalledWith(project);
    expect(onClose).toHaveBeenCalledOnce();
});

it("keeps a created project open for a failed upload and retries without duplicating it", async () => {
    const onClose = vi.fn();
    const onCreated = vi.fn();
    mocks.uploadDocument
        .mockRejectedValueOnce(new Error("upload failed"))
        .mockResolvedValueOnce({});
    const { container } = render(
        <NewProjectModal open onClose={onClose} onCreated={onCreated} />,
    );
    fireEvent.change(screen.getByLabelText("Project name"), {
        target: { value: "Appeal" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    fireEvent.change(input!, {
        target: { files: [new File(["%PDF-1.7"], "brief.pdf", { type: "application/pdf" })] },
    });
    expect(screen.getByRole("list", { name: "Files ready to upload" }))
        .toHaveTextContent("brief.pdf");
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be added/i);
    expect(mocks.createProject).toHaveBeenCalledTimes(1);
    expect(onCreated).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(project));
    expect(mocks.createProject).toHaveBeenCalledTimes(1);
    expect(mocks.uploadDocument).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledOnce();
});

it("offers files and folders through one upload menu and preserves the folder tree", async () => {
    const { container } = render(
        <NewProjectModal open onClose={vi.fn()} onCreated={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText("Project name"), {
        target: { value: "Appeal" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    const [fileInput, folderInput] = Array.from(
        container.querySelectorAll<HTMLInputElement>('input[type="file"]'),
    );
    expect(folderInput).toHaveAttribute("webkitdirectory");
    const fileClick = vi.spyOn(fileInput, "click");
    const folderClick = vi.spyOn(folderInput, "click");
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Files" }));
    expect(fileClick).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Folder" }));
    expect(folderClick).toHaveBeenCalledOnce();

    const loose = new File(["brief"], "brief.pdf", { type: "application/pdf" });
    const unsupported = new File(["binary"], "brief.exe");
    const nested = new File(["exhibit"], "exhibit.pdf", { type: "application/pdf" });
    Object.defineProperty(nested, "webkitRelativePath", {
        value: "evidence/tabs/exhibit.pdf",
    });
    fireEvent.change(fileInput, { target: { files: [loose, unsupported] } });
    expect(screen.getByRole("alert")).toHaveTextContent("Unsupported file type");
    fireEvent.change(folderInput, { target: { files: [nested] } });
    expect(screen.getByRole("list", { name: "Files ready to upload" }))
        .toHaveTextContent("evidence/tabs/exhibit.pdf");

    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(mocks.uploadDirectory).toHaveBeenCalledWith([nested]));
    expect(mocks.uploadDocument).toHaveBeenCalledWith(loose);
});
