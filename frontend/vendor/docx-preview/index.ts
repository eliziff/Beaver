import {
    defaultOptions,
    parseAsync as parse,
    renderAsync as render,
    renderDocument as renderParsed,
} from "./dist/docx-preview.mjs";

export interface Options {
    inWrapper: boolean;
    hideWrapperOnPrint: boolean;
    ignoreWidth: boolean;
    ignoreHeight: boolean;
    ignoreFonts: boolean;
    breakPages: boolean;
    debug: boolean;
    experimental: boolean;
    className: string;
    trimXmlDeclaration: boolean;
    renderHeaders: boolean;
    renderFooters: boolean;
    renderFootnotes: boolean;
    renderEndnotes: boolean;
    ignoreLastRenderedPageBreak: boolean;
    useBase64URL: boolean;
    renderChanges: boolean;
    renderComments: boolean;
    renderAltChunks: boolean;
}

export { defaultOptions };
export const parseAsync = parse as (
    data: Blob | ArrayBuffer | ArrayBufferView,
    options?: Partial<Options>,
) => Promise<unknown>;
export const renderDocument = renderParsed as (
    document: unknown,
    body: HTMLElement,
    style?: HTMLElement,
    options?: Partial<Options>,
) => Promise<void>;
export const renderAsync = render as (
    data: Blob | ArrayBuffer | ArrayBufferView,
    body: HTMLElement,
    style?: HTMLElement,
    options?: Partial<Options>,
) => Promise<unknown>;
