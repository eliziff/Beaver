import { OpenXmlPackage } from "./open-xml-package";
import { Relationship } from "./relationship";

export class Part {
    protected _xmlDocument: Document;

    rels: Relationship[];

    constructor(protected _package: OpenXmlPackage, public path: string) {
    }

    async load(): Promise<any> {
      const [rels, xmlText] = await Promise.all([
          this._package.loadRelationships(this.path),
          this._package.load(this.path),
      ]);
      this.rels = rels;
      const xmlDoc = this._package.parseXmlDocument(xmlText);

      if (this._package.options.keepOrigin) {
          this._xmlDocument = xmlDoc;
      }

      this.parseXml(xmlDoc.firstElementChild);
    }

    protected parseXml(root: Element) {
    }
}
