import { expect, it } from "vitest";
import {
  EXPERIMENTAL_LIBRARY_ANALYSES,
  runExperimentalLibraryAnalysis,
} from "./index";

it("keeps the quarantined analyses executable over supplied documents", () => {
  expect(EXPERIMENTAL_LIBRARY_ANALYSES).toHaveLength(7);
  expect(runExperimentalLibraryAnalysis("drafting_lint", {
    document_id: "draft",
  }, [{
    id: "draft",
    name: "Draft agreement.docx",
    text: "The Buyer shall must pay the amount.",
  }])).toMatchObject({ filename: "Draft agreement.docx" });
});
