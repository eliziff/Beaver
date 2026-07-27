import type { HTMLAttributes } from "react";

type FolderSvgIconProps = HTMLAttributes<HTMLSpanElement>;

type FolderStateIconProps = FolderSvgIconProps & {
    open?: boolean;
};

function FolderSvgIcon({
    open = false,
    className,
    ...props
}: FolderStateIconProps) {
    return (
        <span
            {...props}
            aria-hidden="true"
            className={`app-symbol-icon ${className ?? ""}`}
        >
            {open ? "⊟" : "⊞"}
        </span>
    );
}

export function ClosedSubfolderSvgIcon(props: FolderSvgIconProps) {
    return <FolderSvgIcon {...props} />;
}

export function OpenSubfolderSvgIcon(props: FolderSvgIconProps) {
    return <FolderSvgIcon open {...props} />;
}

export function SubfolderSvgIcon({
    open = false,
    ...props
}: FolderStateIconProps) {
    return <FolderSvgIcon open={open} {...props} />;
}

export function ClosedProjectSvgIcon(props: FolderSvgIconProps) {
    return <FolderSvgIcon {...props} />;
}

export function OpenProjectSvgIcon(props: FolderSvgIconProps) {
    return <FolderSvgIcon open {...props} />;
}

export function ProjectSvgIcon({ open = false, ...props }: FolderStateIconProps) {
    return <FolderSvgIcon open={open} {...props} />;
}

export const ClosedFolderSvgIcon = ClosedSubfolderSvgIcon;
export const OpenFolderSvgIcon = OpenSubfolderSvgIcon;
