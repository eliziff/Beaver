import { parseXmlString, XmlParser } from "../parser/xml-parser";
import { splitPath } from "../utils";
import { NativeZip, ZipOutputType } from "./native-zip";
import { parseRelationships, Relationship } from "./relationship";

export interface OpenXmlPackageOptions {
    trimXmlDeclaration: boolean,
    keepOrigin: boolean,
}

export class OpenXmlPackage {
    xmlParser: XmlParser = new XmlParser();

    constructor(private _zip: NativeZip, public options: OpenXmlPackageOptions) {
    }

    get(path: string): any {
        const p = normalizePath(path);
        return this._zip.files[p] ?? this._zip.files[p.replace(/\//g, '\\')];
    }

    static async load(input: Blob | any, options: OpenXmlPackageOptions): Promise<OpenXmlPackage> {
        const zip = await NativeZip.load(input);
		return new OpenXmlPackage(zip, options);
    }

    load(path: string, type: ZipOutputType = "string"): Promise<any> {
        return this.get(path)?.async(type) ?? Promise.resolve(null);
    }

    async loadRelationships(path: string = null): Promise<Relationship[]> {
        let relsPath = `_rels/.rels`;

        if (path != null) {
            const [f, fn] = splitPath(path);
            relsPath = `${f}_rels/${fn}.rels`;
        }

        const txt = await this.load(relsPath);
		return txt ? parseRelationships(this.parseXmlDocument(txt).firstElementChild, this.xmlParser) : null;
    }

    /** @internal */
    parseXmlDocument(txt: string): Document {
        return parseXmlString(txt, this.options.trimXmlDeclaration);
    }
}

function normalizePath(path: string) {
    return path.startsWith('/') ? path.substr(1) : path;
}
