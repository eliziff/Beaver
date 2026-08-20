import JSZip from "jszip";

export const zipDocumentBytes = (content = "fixture") => {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<Types>${content}</Types>`);
  return zip.generateAsync({ type: "nodebuffer" });
};
