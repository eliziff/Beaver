import path from "node:path";
import { test, expect, files, ownedBrowserRecords, screenshot, type Page, type TestInfo } from "./browser-fixtures";

async function choose(page: Page, family: string, jurisdiction: string, profile: string) {
  await page.goto(process.env.COURT_RECORDS_URL ?? "/court-records");
  await page.getByRole("button", { name: "New court record", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("group", { name: "Jurisdiction" }).getByRole("button", { name: jurisdiction, exact: true }).click();
  await dialog.locator(`[data-choice="${family}"]`).click();
  await expect(page.locator("[data-court-record-chooser]")).toHaveAttribute("data-selected-profile", profile);
}
async function fill(page: Page, id: string, value: string) {
  const field = page.locator(`#cover-${id}`);
  await field.evaluate(element => { for (let node: Element | null = element; node; node = node.parentElement)
    if (node instanceof HTMLDetailsElement) node.open = true; });
  await field.fill(value);
}
async function uploadFile(page: Page, kind: string, file: string) {
  const control = page.locator(`#court-record-${kind}-file`);
  const chooser = page.waitForEvent("filechooser");
  await control.click(); await (await chooser).setFiles(file);
  const row = page.locator(`[data-kind-id="${kind}"] [data-entry-id]`).filter({ has: page.locator(`span[title="${path.basename(file)}"]`) });
  await expect(row).toBeVisible(); await expect(row).not.toHaveAttribute("aria-busy", "true");
}
async function build(page: Page, info: TestInfo, slug: string) {
  await page.locator("[data-court-record-build]").click();
  const panel = page.getByRole("complementary", { name: "Build output" });
  await expect(panel).toContainText("Build complete", { timeout: 120000 });
  await expect(page.locator('[aria-label="Built court record preview"] canvas').first()).toBeVisible();
  await screenshot(page, info, `${slug}-preview.png`);
  const outputs: Record<string, string> = {};
  for (const button of await panel.getByRole("button").filter({ has: page.locator("span").filter({ hasText: /\.(pdf|docx)$/i }) }).all()) {
    const pending = page.waitForEvent("download"); await button.click();
    const download = await pending, target = info.outputPath(slug, download.suggestedFilename());
    await download.saveAs(target); outputs[download.suggestedFilename()] = target;
  }
  expect(Object.keys(outputs).length).toBeGreaterThan(0); return outputs;
}
async function motionCover(page: Page) {
  for (const [key, value] of Object.entries({ counselName: "Rowan Counsel", counselAddress: "410 Observatory Lane\nCalgary, Alberta",
    counselPhone: "403-555-0191", counselEmail: "observatory-counsel@example.test", recordSubtitle: "Motion for procedural directions",
    applicationUnder: "Federal Courts Act, section 18.1" })) await fill(page, key, value);
}

let input: any;
test.beforeAll(async ({}, info) => { input = files("court-fixtures", path.join(info.project.outputDir, "court-record-inputs")); });

test("Alberta affidavit trusted exhibit drop and independent PDF output", async ({ page, request }, info) => {
  const remove = ownedBrowserRecords(page, request);
  try {
    await choose(page, "ab-kb|affidavit-with-exhibits", "Alberta", "ab-kb-affidavit-exhibits");
    await uploadFile(page, "affidavit", input.affidavit);
    await expect(page.locator("#cover-deponent")).toHaveValue("Morgan Vale");
    await uploadFile(page, "exhibit", input.exhibit_b);
    await uploadFile(page, "exhibit", input.ambiguous);
    await page.evaluate(() => { (window as any).courtDrops = []; document.addEventListener("drop", event => {
    (window as any).courtDrops.push({ trusted: event.isTrusted }); }, { capture: true }); });
    const source = page.locator("article").filter({ has: page.locator(`span[title="${path.basename(input.ambiguous)}"]`) });
    await source.locator(".lucide-grip-vertical").dragTo(page.getByLabel("Exhibit A slot", { exact: true }));
    await expect(page.getByLabel("Exhibit A slot", { exact: true })).toContainText(path.basename(input.ambiguous));
    expect(await page.evaluate(() => (window as any).courtDrops.some((event: any) => event.trusted))).toBe(true);
    let outputs = await build(page, info, "affidavit");
    files("affidavit", info.outputPath("inspection"), Object.values(outputs).find(file => file.endsWith(".pdf"))!);

  } finally { await remove(); }
});

async function checkMotion(page: Page, info: TestInfo, court: string, profile: string) {
    await choose(page, `${court}|motion-record`, "Federal courts", profile);
    await uploadFile(page, "notice-motion", input.notice);
    await expect(page.locator("#cover-courtFileNumber")).toHaveValue("T-501-26");
    await motionCover(page); await uploadFile(page, "written-representations", input.representations);
    const standalone = page.url().includes("court-records.html");
    if (court === "fca" && !standalone) await uploadFile(page, "oral-hearing-request", input.oral_request);
    const outputs = await build(page, info, court);
    files(court === "fca" && standalone ? "fca-standalone" : court, info.outputPath("inspection"), Object.values(outputs).find(file => file.endsWith(".pdf"))!);
}

test("Federal Court motion record independently inspected output", async ({ page, request }, info) => {
  const remove = ownedBrowserRecords(page, request);
  try {
    await checkMotion(page, info, "fc", "fc-motion-record-moving");
  } finally { await remove(); }
});

test("Federal Court of Appeal motion record and Word rendition output", async ({ page, request }, info) => {
  const remove = ownedBrowserRecords(page, request);
  try {
    await checkMotion(page, info, "fca", "fca-motion-record-moving");
  } finally { await remove(); }
});

test("Alberta appeal preserves transcript bytes and builds description-only alternative", async ({ page, request }, info) => {
  const remove = ownedBrowserRecords(page, request);
  try {
    await choose(page, "ab-ca|appeal-record", "Alberta", "ab-ca-appeal-record");
    await page.locator("#court-record-party-style").selectOption("action-plaintiff");
    await page.locator('[data-party-group="Appellant"] textarea').fill("Orbital Observatory Society");
    await page.locator('[data-party-group="Respondent"] textarea').fill("Summit Rooftop Cooperative");
    for (const [key, value] of Object.entries({ courtFileNumber: "2603-70707", registry: "Calgary", counselName: "Rowan Counsel",
    counselAddress: "410 Observatory Lane\nCalgary, Alberta", counselPhone: "403-555-0191", counselEmail: "observatory-counsel@example.test", counselFax: "403-555-0192" })) await fill(page, key, value);
    for (const [label, value] of Object.entries({ "Lawyer or filing person": "Avery Advocate", "Address for service": "620 Telescope Avenue\nEdmonton, Alberta", Telephone: "780-555-0193" }))
    await page.getByLabel(`${label} for Summit Rooftop Cooperative`, { exact: true }).fill(value);
    for (const [kind, key] of [["part-1-pleading", "appeal_pleading"], ["part-2-reasons", "appeal_reasons"],
    ["part-2-order", "appeal_order"], ["part-2-notice", "appeal_notice"], ["part-3-transcript", "appeal_transcript"]]) await uploadFile(page, kind, input[key]);
    await page.locator("article").filter({ hasText: path.basename(input.appeal_pleading) }).locator('input[id$="-date"]').fill("January 15, 2026");
    await expect(page.locator("#cover-lowerCourtFileNumber")).toHaveValue("2501-60606");
    let outputs = await build(page, info, "appeal");
    const transcript = outputs[path.basename(input.appeal_transcript)], record = Object.values(outputs).find(file => file !== transcript)!;
    expect(transcript).toBeTruthy(); files("appeal", info.outputPath("inspection"), record, transcript, input.appeal_transcript);
    await page.getByRole("button", { name: `Remove ${path.basename(input.appeal_transcript)}`, exact: true }).click();
    const description = "There is no oral record that can be transcribed for Part 3, Transcripts";
    await page.locator('[data-kind-id="part-3-no-oral-record"] input').fill(description);
    outputs = await build(page, info, "no-oral"); expect(Object.keys(outputs)).toHaveLength(1);
    files("no-oral", info.outputPath("inspection"), Object.values(outputs)[0], description);
  } finally { await remove(); }
});

