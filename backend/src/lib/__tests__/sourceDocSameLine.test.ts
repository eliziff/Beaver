import { describe, expect, it } from "vitest";
import {
  sourceDocPhraseSpans,
  sourceDocQuoteWords,
} from "../sourceDoc";

const textSource = (text: string) => ({ text });

describe("sameLine first-query vs indexed-query parity", () => {
  it("counts a phrase ending at end-of-line identically on both paths", () => {
    const text = "the accused was convicted\nanother line of text here";
    const words = sourceDocQuoteWords("was convicted");

    const firstQueryDoc = textSource(text);
    const firstQuery = sourceDocPhraseSpans(firstQueryDoc, words, {
      sameLine: true,
      limit: 2,
    });

    const indexedDoc = textSource(text);
    sourceDocPhraseSpans(indexedDoc, sourceDocQuoteWords("zzz"), {});
    const indexed = sourceDocPhraseSpans(indexedDoc, words, {
      sameLine: true,
      limit: 2,
    });

    expect(indexed.length).toBe(1);
    expect(firstQuery.length).toBe(indexed.length);
  });
});
