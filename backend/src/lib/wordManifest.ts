const escapeXml = (value: string) => value
  .replaceAll("&", "&amp;")
  .replaceAll('"', "&quot;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;");

export function wordManifest(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value.replace(/\/$/u, "")) {
    throw new Error("The Word add-in requires an exact HTTPS origin");
  }
  const origin = escapeXml(url.origin);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<OfficeApp xmlns="http://schemas.microsoft.com/office/appforoffice/1.1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="TaskPaneApp">
  <Id>21c76a90-5e14-4ba2-91bd-f28ca06b1657</Id>
  <Version>1.0.0.0</Version>
  <ProviderName>Beaver</ProviderName>
  <DefaultLocale>en-CA</DefaultLocale>
  <DisplayName DefaultValue="Beaver for Word" />
  <Description DefaultValue="Legal drafting and review in Microsoft Word." />
  <SupportUrl DefaultValue="${origin}" />
  <Hosts><Host Name="Document" /></Hosts>
  <Requirements>
    <Sets DefaultMinVersion="1.4"><Set Name="WordApi" /></Sets>
  </Requirements>
  <DefaultSettings><SourceLocation DefaultValue="${origin}/word.html" /></DefaultSettings>
  <Permissions>ReadWriteDocument</Permissions>
</OfficeApp>
`;
}
