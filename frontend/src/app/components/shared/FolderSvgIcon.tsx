import { Folder, FolderOpen, type LucideProps } from "lucide-react";
type FolderSvgIconProps = LucideProps & {
    open?: boolean;
};
export function FolderSvgIcon({
    open = false,
    ...props
}: FolderSvgIconProps) {
    const Icon = open ? FolderOpen : Folder;
    return <Icon {...props} aria-hidden="true" />;
}
