import type { AuthoritiesCover } from "./authorities-contract";

export function courtCover<Cover extends AuthoritiesCover>(cover: Cover, from: string, to: string): Cover;
