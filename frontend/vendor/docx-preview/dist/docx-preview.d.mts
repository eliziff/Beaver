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

export type WordDocument = any;

export declare const defaultOptions: Options;
export declare function parseAsync(
    data: Blob | ArrayBuffer | ArrayBufferView,
    userOptions?: Partial<Options>,
): Promise<WordDocument>;
export declare function renderDocument(
    document: WordDocument,
    bodyContainer: HTMLElement,
    styleContainer?: HTMLElement,
    userOptions?: Partial<Options>,
): Promise<void>;
export declare function renderAsync(
    data: Blob | ArrayBuffer | ArrayBufferView,
    bodyContainer: HTMLElement,
    styleContainer?: HTMLElement,
    userOptions?: Partial<Options>,
): Promise<WordDocument>;
