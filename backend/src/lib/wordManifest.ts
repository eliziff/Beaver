const escapeXml = (value: string) => value
  .replaceAll("&", "&amp;")
  .replaceAll('"', "&quot;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;");

/** A Word add-in made of a page Beaver serves or builds: its id (a GUID), names, the page's path on the origin,
 *  and the WordApi version it requires. Beaver for Word's own are the defaults. */
export type WordManifestOptions = { id?: string; name?: string; description?: string; provider?: string;
  page?: string; wordApi?: string };

export function wordManifest(value: string, options: WordManifestOptions = {}) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value.replace(/\/$/u, "")) {
    throw new Error("The Word add-in requires an exact HTTPS origin");
  }
  const { id = "21c76a90-5e14-4ba2-91bd-f28ca06b1657", name = "Beaver for Word",
    description = "Legal drafting and review in Microsoft Word.", provider = "Beaver",
    page = "/word.html", wordApi = "1.4" } = options;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(id)) throw new Error("The add-in id must be a GUID");
  if (!page.startsWith("/")) throw new Error("The add-in page is a path on its origin");
  if (!/^1\.\d+$/u.test(wordApi)) throw new Error("WordApi versions are 1.x");
  const origin = escapeXml(url.origin);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<OfficeApp xmlns="http://schemas.microsoft.com/office/appforoffice/1.1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="TaskPaneApp">
  <Id>${id}</Id>
  <Version>1.0.0.0</Version>
  <ProviderName>${escapeXml(provider)}</ProviderName>
  <DefaultLocale>en-CA</DefaultLocale>
  <DisplayName DefaultValue="${escapeXml(name)}" />
  <Description DefaultValue="${escapeXml(description)}" />
  <SupportUrl DefaultValue="${origin}" />
  <Hosts><Host Name="Document" /></Hosts>
  <Requirements>
    <Sets DefaultMinVersion="${wordApi}"><Set Name="WordApi" /></Sets>
  </Requirements>
  <DefaultSettings><SourceLocation DefaultValue="${origin}${escapeXml(page)}" /></DefaultSettings>
  <Permissions>ReadWriteDocument</Permissions>
</OfficeApp>
`;
}
