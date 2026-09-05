import { runtime } from "../../backend/src/runtime";

async function main() {
  const documents = await runtime.documents(), projects = await runtime.projects(),
    scope = { userId: "00000000-0000-0000-0000-000000000001" };
  const project = await projects.create(scope, { name: "Change review pilot",
    cmNumber: null, practice: null, sharedWith: [] });
  const source = await documents.create(scope, { filename: "Witness statement.txt",
    fileType: "txt", projectId: project.id,
    bytes: Buffer.from("The meeting took place on Monday.\n\nThe signed agreement was delivered the following morning.") });
  await documents.create(scope, { filename: "Chronology.md", fileType: "md", projectId: project.id,
    bytes: Buffer.from("# Chronology\n\nThe meeting occurred on Monday. The agreement was delivered on Tuesday.\n\nThese dates are taken from the witness statement."),
    provenance: { schemaVersion: 1, actor: "assistant", action: "created", dependencies: [{
      documentId: source.id, versionId: source.current_version_id,
      sourceSha256: source.source_sha256, locator: "chars:0-37" }] } });
  await documents.create(scope, { filename: "Instructions.txt", fileType: "txt", projectId: project.id,
    bytes: Buffer.from("Prepare a chronology and check the delivery date.") });
  await documents.addVersion(scope, source.id, { filename: source.filename, fileType: "txt",
    bytes: Buffer.from("The meeting took place on Wednesday.\n\nThe signed agreement was delivered the following morning.") });
  console.log(JSON.stringify({ projectId: project.id, sourceId: source.id }));
  await runtime.shutdown();
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
