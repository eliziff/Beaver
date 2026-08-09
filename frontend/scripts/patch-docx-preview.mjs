import { readFile, writeFile } from "node:fs/promises";

const files = [
    ["docx-preview.mjs", ""],
    ["docx-preview.js", "    "],
];
const edits = [
    [
        `    if (trimXmlDeclaration)\n        xmlString = xmlString.replace(/<[?].*[?]>/, "");`,
        `    if (trimXmlDeclaration && xmlString.startsWith("<?xml")) {\n        const end = xmlString.indexOf("?>");\n        if (end >= 0) xmlString = xmlString.slice(end + 2);\n    }`,
    ],
    [
        `    const errorText = hasXmlParserError(result);\n    if (errorText)\n        throw new Error(errorText);\n    return result;\n}\nfunction hasXmlParserError(doc) {\n    return doc.getElementsByTagName("parsererror")[0]?.textContent;\n}`,
        `    if (result.documentElement?.localName === "parsererror")\n        throw new Error(result.documentElement.textContent ?? "Invalid XML");\n    return result;\n}`,
    ],
    [
        `            type: DomType.Inserted,\n            children: parentParser(node)?.children ?? []`,
        `            type: DomType.Inserted,\n            id: globalXmlParser.attr(node, "id"),\n            children: parentParser(node)?.children ?? []`,
    ],
    [
        `            type: DomType.Deleted,\n            children: parentParser(node)?.children ?? []`,
        `            type: DomType.Deleted,\n            id: globalXmlParser.attr(node, "id"),\n            children: parentParser(node)?.children ?? []`,
    ],
    [
        `                        type: DomType.FootnoteReference,\n                        id: globalXmlParser.attr(c, "id")`,
        `                        type: DomType.FootnoteReference,\n                        id: globalXmlParser.attr(c, "id"),\n                        customMarkFollows: globalXmlParser.boolAttr(c, "customMarkFollows", false)`,
    ],
    [
        `                        type: DomType.EndnoteReference,\n                        id: globalXmlParser.attr(c, "id")`,
        `                        type: DomType.EndnoteReference,\n                        id: globalXmlParser.attr(c, "id"),\n                        customMarkFollows: globalXmlParser.boolAttr(c, "customMarkFollows", false)`,
    ],
    [
        `const topLevelRels = [\n    { type: RelationshipTypes.OfficeDocument, target: "word/document.xml" },\n    { type: RelationshipTypes.ExtendedProperties, target: "docProps/app.xml" },\n    { type: RelationshipTypes.CoreProperties, target: "docProps/core.xml" },\n    { type: RelationshipTypes.CustomProperties, target: "docProps/custom.xml" },\n];`,
        `const topLevelRels = [\n    { type: RelationshipTypes.OfficeDocument, target: "word/document.xml" },\n];`,
    ],
    [
        `class SettingsPart extends Part {\n    constructor(pkg, path) {\n        super(pkg, path);\n    }\n    parseXml(root) {\n        this.settings = parseSettings(root, this._package.xmlParser);\n    }\n}`,
        `class SettingsPart extends Part {\n    constructor(pkg, path) {\n        super(pkg, path);\n    }\n    async load() {\n        const text = await this._package.load(this.path);\n        const value = /<(?:\\w+:)?defaultTabStop\\b[^>]*\\b(?:\\w+:)?val=["']([^"']+)["']/.exec(text)?.[1];\n        this.settings = { defaultTabStop: convertLength(value) };\n    }\n}`,
    ],
    [
        `            case RelationshipTypes.Comments:\n                this.commentsPart = part = new CommentsPart(this._package, path, this._parser);\n                break;\n            case RelationshipTypes.CommentsExtended:\n                this.commentsExtendedPart = part = new CommentsExtendedPart(this._package, path);\n                break;`,
        `            case RelationshipTypes.Comments:\n                if (!this._options.renderComments) return null;\n                this.commentsPart = part = new CommentsPart(this._package, path, this._parser);\n                break;\n            case RelationshipTypes.CommentsExtended:\n                if (!this._options.renderComments) return null;\n                this.commentsExtendedPart = part = new CommentsExtendedPart(this._package, path);\n                break;`,
    ],
    [
        `    renderInserted(elem) {\n        if (this.options.renderChanges)\n            return this.renderContainer(elem, "ins");\n        return this.renderElements(elem.children);\n    }\n    renderDeleted(elem) {\n        if (this.options.renderChanges)\n            return this.renderContainer(elem, "del");\n        return null;\n    }`,
        `    renderInserted(elem) {\n        if (!this.options.renderChanges) return this.renderElements(elem.children);\n        const result = this.renderContainer(elem, "ins");\n        if (elem.id != null) result.dataset.wId = elem.id;\n        return result;\n    }\n    renderDeleted(elem) {\n        if (!this.options.renderChanges) return null;\n        const result = this.renderContainer(elem, "del");\n        if (elem.id != null) result.dataset.wId = elem.id;\n        return result;\n    }`,
    ],
];

for (const [name, indent] of files) {
    const file = new URL(`../node_modules/docx-preview/dist/${name}`, import.meta.url);
    let source = await readFile(file, "utf8");
    for (const [rawBefore, rawAfter] of edits) {
        const before = rawBefore.replace(/^/gm, indent);
        const after = rawAfter.replace(/^/gm, indent);
        if (source.includes(after)) continue;
        if (!source.includes(before)) throw new Error(`Unsupported docx-preview build: ${file}`);
        source = source.replace(before, after);
    }
    await writeFile(file, source);
}
