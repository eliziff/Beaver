import assert from "node:assert/strict";
import { it } from "node:test";
import { resolveIssueCards, type ModelIssueCard } from "./caseSemanticMvp";

const opinionText = "The governing rule requires notice. On these facts, notice was not given. The appeal is allowed.";
const opinion = { id: "o1", start: 100, end: 100 + opinionText.length, text: opinionText };

it("resolves issue evidence and discussion spans to absolute source offsets", () => {
  const card: ModelIssueCard = {
    id: "i1",
    opinion_id: "o1",
    question: "Was legally sufficient notice given?",
    answer: "No.",
    relation_to_disposition: "dispositive",
    discussion_spans: [{
      start_quote: "The governing rule requires notice.",
      end_quote: "The appeal is allowed.",
    }],
    answer_evidence_ids: ["e1"],
    basis_and_limits: [{
      id: "b1",
      kind: "application",
      text: "The required notice was not given.",
      evidence_ids: ["e1"],
    }],
    evidence: [{
      id: "e1",
      quote: "On these facts, notice was not given.",
      voice: "current_court",
    }],
  };

  const result = resolveIssueCards([opinion], [card]);
  assert.deepEqual(result.rejections, []);
  const evidenceQuote = "On these facts, notice was not given.";
  assert.equal(result.cards[0].evidence[0].quote.start, opinion.start + opinionText.indexOf(evidenceQuote));
  assert.equal(result.cards[0].evidence[0].quote.end, opinion.start + opinionText.indexOf(evidenceQuote) + evidenceQuote.length);
  assert.equal(result.cards[0].discussion_spans[0].start, opinion.start);
  assert.equal(result.cards[0].discussion_spans[0].end, opinion.end);
});

it("rejects ungrounded evidence, bad references, and answers lacking current-court support", () => {
  const bad: ModelIssueCard = {
    id: "i1",
    opinion_id: "o1",
    question: "Was legally sufficient notice given?",
    answer: "No.",
    relation_to_disposition: "dispositive",
    discussion_spans: [{
      start_quote: "The governing rule requires notice.",
      end_quote: "The appeal is allowed.",
    }],
    answer_evidence_ids: ["missing"],
    basis_and_limits: [],
    evidence: [{ id: "e1", quote: "not in source", voice: "quoted_authority" }],
  };

  const result = resolveIssueCards([opinion], [bad]);
  assert.deepEqual(result.cards, []);
  assert(result.rejections[0].errors.some((error) => /missing from the opinion/iu.test(error)));
  assert(result.rejections[0].errors.some((error) => /unknown evidence id/iu.test(error)));
  assert(result.rejections[0].errors.some((error) => /lacks current-court evidence/iu.test(error)));
});
