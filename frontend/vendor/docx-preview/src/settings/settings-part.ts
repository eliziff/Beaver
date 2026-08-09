import { OpenXmlPackage } from "../common/open-xml-package";
import { Part } from "../common/part";
import { convertLength } from "../document/common";
import { WmlSettings } from "./settings";

export class SettingsPart extends Part {
	settings: WmlSettings;

	constructor(pkg: OpenXmlPackage, path: string) {
		super(pkg, path);
	}

	async load() {
		const text = await this._package.load(this.path);
		const value = /<(?:\w+:)?defaultTabStop\b[^>]*\b(?:\w+:)?val=["']([^"']+)["']/.exec(text)?.[1];
		this.settings = { defaultTabStop: convertLength(value) } as WmlSettings;
	}
}
