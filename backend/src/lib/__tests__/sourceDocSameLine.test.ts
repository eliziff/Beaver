import { describe, expect, it } from "vitest";
import {
  createTextSourceDoc,
  sourceDocPhraseSpans,
  sourceDocQuoteWords,
} from "../sourceDoc";

describe("sameLine first-query vs indexed-query parity", () => {
  it("counts a phrase ending at end-of-line identically on both paths", () => {
    const text = "the accused was convicted\nanother line of text here";
    const words = sourceDocQuoteWords("was convicted");

    const firstQueryDoc = createTextSourceDoc(text);
    const firstQuery = sourceDocPhraseSpans(firstQueryDoc, words, {
      sameLine: true,
      limit: 2,
    });

    const indexedDoc = createTextSourceDoc(text);
    sourceDocPhraseSpans(indexedDoc, sourceDocQuoteWords("zzz"), {});
    const indexed = sourceDocPhraseSpans(indexedDoc, words, {
      sameLine: true,
      limit: 2,
    });

    expect(indexed.length).toBe(1);
    expect(firstQuery.length).toBe(indexed.length);
  });
});
