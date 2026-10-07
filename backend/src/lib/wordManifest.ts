const escapeXml = (value: string) => value
  .replaceAll("&", "&amp;")
  .replaceAll('"', "&quot;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;");

/** A Word add-in made of a page Beaver serves or builds: its id (a GUID), names, the page's path on the origin,
 *  and the WordApi version it requires. Beaver for Word's own are the defaults. With `icons` (paths on the origin of
 *  its 16, 32, 64 and 80 px PNGs), Word shows its icon, and a button on the Home tab opens the pane. */
export type WordManifestOptions = { id?: string; name?: string; description?: string; provider?: string;
  page?: string; wordApi?: string; icons?: Record<16 | 32 | 64 | 80, string>; button?: { group: string; label: string; tip: string } };

export function wordManifest(value: string, options: WordManifestOptions = {}) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value.replace(/\/$/u, "")) {
    throw new Error("The Word add-in requires an exact HTTPS origin");
  }
  const { id = "21c76a90-5e14-4ba2-91bd-f28ca06b1657", name = "Beaver for Word",
    description = "Legal drafting and review in Microsoft Word.", provider = "Beaver",
    page = "/word.html", wordApi = "1.4", icons, button } = options;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(id)) throw new Error("The add-in id must be a GUID");
  if (!page.startsWith("/")) throw new Error("The add-in page is a path on its origin");
  if (!/^1\.\d+$/u.test(wordApi)) throw new Error("WordApi versions are 1.x");
  if (icons && Object.values(icons).some((icon) => !icon.startsWith("/"))) throw new Error("The add-in icons are paths on its origin");
  const origin = escapeXml(url.origin);
  const at = (path: string) => `${origin}${escapeXml(path)}`;
  const images = (indent: string) => ([16, 32, 80] as const).map((size) =>
    `${indent}<bt:Image size="${size}" resid="Icon.${size}" />`).join("\n");
  // The Home tab's button, in Microsoft's add-in command schema: it shows the pane.
  const commands = icons ? `
  <VersionOverrides xmlns="http://schemas.microsoft.com/office/taskpaneappversionoverrides" xsi:type="VersionOverridesV1_0">
    <Hosts>
      <Host xsi:type="Document">
        <DesktopFormFactor>
          <FunctionFile resid="Pane.Url" />
          <ExtensionPoint xsi:type="PrimaryCommandSurface">
            <OfficeTab id="TabHome">
              <Group id="Pane.Group">
                <Label resid="Pane.Group" />
                <Icon>
${images("                  ")}
                </Icon>
                <Control xsi:type="Button" id="Pane.Open">
                  <Label resid="Pane.Open" />
                  <Supertip>
                    <Title resid="Pane.Open" />
                    <Description resid="Pane.Tip" />
                  </Supertip>
                  <Icon>
${images("                    ")}
                  </Icon>
                  <Action xsi:type="ShowTaskpane">
                    <TaskpaneId>Pane</TaskpaneId>
                    <SourceLocation resid="Pane.Url" />
                  </Action>
                </Control>
              </Group>
            </OfficeTab>
          </ExtensionPoint>
        </DesktopFormFactor>
      </Host>
    </Hosts>
    <Resources>
      <bt:Images>
${([16, 32, 80] as const).map((size) => `        <bt:Image id="Icon.${size}" DefaultValue="${at(icons[size])}" />`).join("\n")}
      </bt:Images>
      <bt:Urls>
        <bt:Url id="Pane.Url" DefaultValue="${at(page)}" />
      </bt:Urls>
      <bt:ShortStrings>
        <bt:String id="Pane.Group" DefaultValue="${escapeXml(button?.group ?? name)}" />
        <bt:String id="Pane.Open" DefaultValue="${escapeXml(button?.label ?? name)}" />
      </bt:ShortStrings>
      <bt:LongStrings>
        <bt:String id="Pane.Tip" DefaultValue="${escapeXml(button?.tip ?? description)}" />
      </bt:LongStrings>
    </Resources>
  </VersionOverrides>` : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<OfficeApp xmlns="http://schemas.microsoft.com/office/appforoffice/1.1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"${icons ? `
  xmlns:bt="http://schemas.microsoft.com/office/officeappbasictypes/1.0"` : ""} xsi:type="TaskPaneApp">
  <Id>${id}</Id>
  <Version>1.0.0.0</Version>
  <ProviderName>${escapeXml(provider)}</ProviderName>
  <DefaultLocale>en-CA</DefaultLocale>
  <DisplayName DefaultValue="${escapeXml(name)}" />
  <Description DefaultValue="${escapeXml(description)}" />${icons ? `
  <IconUrl DefaultValue="${at(icons[32])}" />
  <HighResolutionIconUrl DefaultValue="${at(icons[64])}" />` : ""}
  <SupportUrl DefaultValue="${origin}" />
  <Hosts><Host Name="Document" /></Hosts>
  <Requirements>
    <Sets DefaultMinVersion="${wordApi}"><Set Name="WordApi" /></Sets>
  </Requirements>
  <DefaultSettings><SourceLocation DefaultValue="${origin}${escapeXml(page)}" /></DefaultSettings>
  <Permissions>ReadWriteDocument</Permissions>${commands}
</OfficeApp>
`;
}
