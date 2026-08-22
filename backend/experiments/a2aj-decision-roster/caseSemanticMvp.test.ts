import assert from "node:assert/strict";
import { it } from "vitest";
import {
  resolveIssueCards,
  resolveUniqueGroundedQuote,
  type ModelIssueCard,
} from "./caseSemanticMvp";

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

it("grounds punctuation-normalized quotes but rejects changed words", () => {
  const text = "The governing rule — requires reasonable notice.";
  const grounded = resolveUniqueGroundedQuote(text, 20, "The governing rule requires reasonable notice.");
  assert.equal(typeof grounded, "object");
  assert.deepEqual(grounded, { quote: text.slice(0, -1), start: 20, end: 20 + text.length - 1 });
  assert.equal(
    resolveUniqueGroundedQuote(text, 20, "The governing rule requires immediate notice."),
    "quote is missing",
  );
});

it("uses the start/end pair to resolve an individually repeated discussion anchor", () => {
  const text = "Issue starts here. The court answers no. Issue ends here. Issue starts here. Unrelated appendix.";
  const card: ModelIssueCard = {
    id: "i1",
    opinion_id: "o1",
    question: "Did the court answer the issue?",
    answer: "No.",
    relation_to_disposition: "dispositive",
    discussion_spans: [{ start_quote: "Issue starts here.", end_quote: "Issue ends here." }],
    answer_evidence_ids: ["e1"],
    basis_and_limits: [],
    evidence: [{ id: "e1", quote: "The court answers no.", voice: "current_court" }],
  };
  const result = resolveIssueCards([{ id: "o1", start: 10, end: 10 + text.length, text }], [card]);
  assert.deepEqual(result.rejections, []);
  assert.equal(result.cards[0].discussion_spans[0].start, 10);
  assert.equal(result.cards[0].discussion_spans[0].end, 10 + text.indexOf("Issue ends here.") + "Issue ends here.".length);
});
