import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const source = new URL("./gold.jsonl", import.meta.url);
const target = new URL("./gold-ablation-10-v5.jsonl", import.meta.url);

const aliases = new Map(Object.entries({
  142972: { d10: "d1", d4: "d3" },
  814: Object.fromEntries(["d2", "d3", "d4", "d5", "d6", "d7", "d8", "d9", "d10", "d11", "d12", "d13", "d14", "d18", "d19"].map((id) => [id, "d1"])),
  92143: {},
  122920: { d10: "d8", d15: "d1", d16: "d2", d17: "d2" },
  190600: { d12: "d1", d13: "d2", d14: "d4", d15: "d3", d16: "d3", d17: "d3", d18: "d3" },
  135183: { d10: "d7" },
  118406: { d21: "d17", d22: "d16", d23: "d16", d29: "d1", d30: "d12", d32: "d25", d33: "d24", d35: "d28", d43: "d3", d50: "d48", d51: "d48", d52: "d48" },
  126799: { d16: "d8", d30: "d14", d31: "d15", d32: "d13", d33: "d12", d40: "d12", d41: "d9" },
  13847: { d17: "d8", d18: "d9", d29: "d1" },
  192926: { d39: "d23" },
}));

const drops = new Map(Object.entries({
  142972: new Set(["d7", "d13", "d14"]),
  126799: new Set(["d39"]),
  13847: new Set(["d7"]),
}));

const selected = new Set(aliases.keys());
const records = [];
const lines = createInterface({ input: createReadStream(source, "utf8"), crlfDelay: Infinity });

const spanKey = (span) => JSON.stringify(span);
const uniqueSpans = (spans) => [...new Map(spans.map((span) => [spanKey(span), span])).values()];
const treatmentKey = (treatment) => JSON.stringify([
  treatment.opinion_id,
  [...treatment.signals].sort(),
  treatment.other_signal,
  treatment.proposition,
  treatment.treatment,
]);
const citedDecision = (record, id) => record.annotation.analysis.cited_decisions.find((decision) => decision.decision_id === id);
const treatmentMatching = (record, decisionId, opinionId, propositionPrefix) => {
  const treatment = citedDecision(record, decisionId)?.treatments.find((item) =>
    item.opinion_id === opinionId && item.proposition.startsWith(propositionPrefix));
  if (!treatment) throw new Error(`Missing treatment ${record.document_id}/${decisionId}/${opinionId}/${propositionPrefix}`);
  return treatment;
};

for await (const line of lines) {
  if (!line.trim()) continue;
  const record = JSON.parse(line);
  const map = aliases.get(String(record.document_id));
  if (!selected.has(String(record.document_id))) continue;
  record.contract_version = "a2aj-proposition-treatment-v5";

  for (const participant of record.annotation.structure.participants) {
    for (const link of participant.opinion_links) delete link.scope;
  }

  const byId = new Map(record.annotation.analysis.cited_decisions.map((decision) => [decision.decision_id, decision]));
  for (const decision of record.annotation.analysis.cited_decisions) {
    const canonicalId = map[decision.decision_id];
    if (!canonicalId) continue;
    const canonical = byId.get(canonicalId);
    canonical.treatments.push(...decision.treatments);
    if (!canonical.procedural_relationship && decision.procedural_relationship) {
      canonical.procedural_relationship = decision.procedural_relationship;
    }
  }

  const removed = new Set(Object.keys(map));
  record.annotation.analysis.cited_decisions = record.annotation.analysis.cited_decisions
    .filter(({ decision_id }) => !removed.has(decision_id) && !drops.get(String(record.document_id))?.has(decision_id))
    .map((decision) => {
      const treatments = new Map();
      for (const treatment of decision.treatments) {
        delete treatment.partial_adopters;
        const key = treatmentKey(treatment);
        const prior = treatments.get(key);
        if (prior) {
          prior.evidence_spans = uniqueSpans([...prior.evidence_spans, ...treatment.evidence_spans]);
          prior.quoted_passages = uniqueSpans([...prior.quoted_passages, ...treatment.quoted_passages]);
        } else {
          treatments.set(key, structuredClone(treatment));
        }
      }
      return { ...decision, treatments: [...treatments.values()] };
    });

  if (record.document_id === 142972) {
    record.annotation.structure.disposition_spans[0].start_quote = "For the reasons set out above";
    const oldAppeal = citedDecision(record, "d3");
    oldAppeal.procedural_relationship.description = "Murphy J. dismissed the 1993 summary-conviction appeal. The present court dismissed the motion to extend time to seek leave to appeal that order.";
    oldAppeal.procedural_relationship.actions = [];
    const failureToLeaveAppeal = citedDecision(record, "d8");
    failureToLeaveAppeal.procedural_relationship.description = "Rosenberg J. dismissed the appeal from the failure-to-leave conviction. The present court dismissed the motion to extend time to seek leave to appeal that order.";
    failureToLeaveAppeal.procedural_relationship.actions = [];
    const prohibitedEntryAppeal = citedDecision(record, "d9");
    prohibitedEntryAppeal.procedural_relationship.description = "Rosenberg J. dismissed the appeal from the prohibited-entry conviction. The present court dismissed the motion to extend time to seek leave to appeal that order.";
    prohibitedEntryAppeal.procedural_relationship.actions = [];
    const antorisa = citedDecision(record, "d11");
    antorisa.treatments[0].quoted_passages = [{
      start_line: 53,
      end_line: 53,
      start_quote: "The law on s. 131 is well-settled",
      end_quote: "The threshold for granting leave is very high.",
    }];
    citedDecision(record, "d12").treatments.push({
      treatment_id: "pending",
      opinion_id: "o1",
      signals: ["followed", "applied"],
      other_signal: null,
      proposition: "Section 131 permits leave only for a legal question presenting special grounds whose resolution is necessary to serve the public interest or the administration of justice; this is a very high threshold.",
      treatment: "Brown J.A. adopted Castonguay as part of the settled leave test and applied that test to reject proposed appeals directed at factual findings.",
      evidence_spans: [{
        start_line: 52,
        end_line: 55,
        start_quote: "proposed appeals do not meet the high threshold",
        end_quote: "main complaint lies with the findings of fact made by the trial judges",
      }],
      quoted_passages: [{
        start_line: 53,
        end_line: 53,
        start_quote: "The law on s. 131 is well-settled",
        end_quote: "The threshold for granting leave is very high.",
      }],
    });
  }

  if (record.document_id === 814) {
    citedDecision(record, "d1").procedural_relationship.description = "The British Columbia Supreme Court declared title to the four-acre parcel and directed a corrective survey. The Court of Appeal upheld the factual and misdescription conclusions, corrected the limitations reasoning, and dismissed the Crown's appeal.";
    citedDecision(record, "d17").treatments.push({
      treatment_id: "pending",
      opinion_id: "o1",
      signals: ["applied"],
      other_signal: null,
      proposition: "An instrument misdescribes land when it intends to describe one parcel but describes another or includes part of another; it does not misdescribe land merely because it accurately describes land the applicant does not own.",
      treatment: "Harris J.A. applied this formulation of misdescription, reproduced through Hawkes Estate, to the grant intended to convey the hotel parcel but legally locating acreage within LS 8.",
      evidence_spans: [{
        start_line: 95,
        end_line: 98,
        start_quote: "the definition of misdescription referred to in Hawkes Estate",
        end_quote: "though the land is not mine.",
      }],
      quoted_passages: [{
        start_line: 97,
        end_line: 98,
        start_quote: "As I understand it the law is to this effect.",
        end_quote: "though the land is not mine.",
      }],
    });
  }

  if (record.document_id === 122920) {
    citedDecision(record, "d1").procedural_relationship.description = "Warner J. convicted Rouse in 2017. Rouse filed a timely appeal from the conviction and later sentence, then voluntarily abandoned it; the present decision dismissed his motion to extend time to file a new appeal.";
    citedDecision(record, "d2").procedural_relationship.description = "Warner J. dismissed Rouse's mistrial application and sentenced him in 2018. Rouse filed and then voluntarily abandoned a timely appeal; the present decision dismissed his motion to extend time to file a new appeal.";
    citedDecision(record, "d18").procedural_relationship.description = "Muise J. convicted Rouse in 2019. Rouse did not appeal within the prescribed time, and the present decision dismissed his motion to extend that time.";
    citedDecision(record, "d19").procedural_relationship.description = "Muise J. sentenced Rouse in 2020. Rouse did not appeal within the prescribed time, and the present decision dismissed his motion to extend that time.";
  }

  if (record.document_id === 190600) {
    const revise = (decisionId, opinionId, propositionPrefix, signals, proposition, treatment, evidenceSpans) => {
      const item = treatmentMatching(record, decisionId, opinionId, propositionPrefix);
      item.signals = signals;
      item.proposition = proposition;
      item.treatment = treatment;
      item.evidence_spans = evidenceSpans;
      item.quoted_passages = [];
      return item;
    };

    revise(
      "d1", "o1", "Quebec's ordinary civil-liability rules",
      ["explained", "followed", "applied"],
      "Under article 1376 C.C.Q., ordinary civil-liability rules apply to public bodies unless the public body establishes a prevailing public-law rule, which is then incorporated into civil liability.",
      "Deschamps J. followed Prud’homme to identify the method for incorporating municipal public-law immunity into Quebec civil liability.",
      [{
        start_line: 83,
        end_line: 87,
        start_quote: "Under the Civil Code of Lower Canada",
        end_quote: "incorporate them into the civil law.",
      }],
    );
    revise(
      "d4", "o1", "Quebec's ordinary civil-liability rules",
      ["explained", "followed", "applied"],
      "The former Quebec civil-law regime gave municipalities relative immunity for legislative and regulatory action, and the rationale for that protection remains applicable under the Civil Code of Québec.",
      "Deschamps J. relied on Laurentide Motels to carry the rationale for municipal public-law immunity into the current civil-law framework.",
      [{
        start_line: 83,
        end_line: 83,
        start_quote: "Under the Civil Code of Lower Canada",
        end_quote: "Laurentide Motels Ltd. v. Beauport (City), [1989] 1 S.C.R. 705.",
      }, {
        start_line: 101,
        end_line: 102,
        start_quote: "To answer that question",
        end_quote: "incorporated into the civil law.",
      }],
    );
    revise(
      "d5", "o1", "Regulatory discretion must be exercised",
      ["explained", "followed", "applied"],
      "Statutory discretion is not absolute: it must be exercised in good faith, within the statute's purposes, and not for capricious or irrelevant reasons.",
      "Deschamps J. followed Roncarelli to define the good-faith and statutory-purpose limits on municipal regulatory discretion.",
      [{
        start_line: 95,
        end_line: 97,
        start_quote: "The adoption, amendment or repeal",
        end_quote: "is just as objectionable as fraud or corruption.",
      }],
    );
    revise(
      "d6", "o1", "Regulatory discretion must be exercised",
      ["explained", "followed", "applied"],
      "A bona fide policy decision is protected from private-law review unless it is so irrational that it cannot constitute a proper exercise of discretion.",
      "Deschamps J. followed Brown to define the relative immunity protecting bona fide municipal policy choices.",
      [{
        start_line: 98,
        end_line: 100,
        start_quote: "That standard was reiterated",
        end_quote: "protected by what may be called relative immunity.",
      }],
    );

    const adoptedByLebel = [
      ["d1", "Under article 1376 C.C.Q., ordinary civil-liability rules apply to public bodies unless the public body establishes a prevailing public-law rule, which is then incorporated into civil liability.", "LeBel J., for himself and Fish J., adopted Deschamps J.'s use of Prud’homme as part of the governing municipal-liability analysis, while declining to apply that analysis to the municipality's conduct."],
      ["d2", "A municipality acting legislatively or quasi-judicially is not privately liable merely because its enactment is invalid or foreseeably causes economic loss; elected bodies require latitude absent bad faith.", "LeBel J., for himself and Fish J., adopted Deschamps J.'s use of Welbridge as part of the governing municipal-liability analysis, while declining to apply that analysis to the municipality's conduct."],
      ["d4", "The former Quebec civil-law regime gave municipalities relative immunity for legislative and regulatory action, and the rationale for that protection remains applicable under the Civil Code of Québec.", "LeBel J., for himself and Fish J., adopted Deschamps J.'s use of Laurentide Motels as part of the governing municipal-liability analysis, while declining to apply that analysis to the municipality's conduct."],
      ["d5", "Statutory discretion is not absolute: it must be exercised in good faith, within the statute's purposes, and not for capricious or irrelevant reasons.", "LeBel J., for himself and Fish J., adopted Deschamps J.'s use of Roncarelli as part of the governing municipal-liability analysis, while declining to apply that analysis to the municipality's conduct."],
      ["d6", "A bona fide policy decision is protected from private-law review unless it is so irrational that it cannot constitute a proper exercise of discretion.", "LeBel J., for himself and Fish J., adopted Deschamps J.'s use of Brown as part of the governing municipal-liability analysis, while declining to apply that analysis to the municipality's conduct."],
      ["d7", "Bad faith extends beyond deliberate harm to reckless or inexplicable exercises of authority from which an absence of good faith can be inferred.", "LeBel J., for himself and Fish J., adopted Deschamps J.'s use of Finney as part of the governing municipal-liability analysis, while declining to apply that analysis to the municipality's conduct."],
    ];
    for (const [decisionId, proposition, treatment] of adoptedByLebel) {
      revise(
        decisionId, "o2", "Municipal civil liability for regulatory action",
        ["approved"],
        proposition,
        treatment,
        [{
          start_line: 132,
          end_line: 132,
          start_quote: "I agree with her analysis of the principles governing the civil liability",
          end_quote: "with the disposition she proposes.",
        }],
      );
    }

    const partialAgreementEvidence = {
      start_line: 132,
      end_line: 132,
      start_quote: "LeBel J. — I have read",
      end_quote: "with the disposition she proposes.",
    };
    for (const name of ["LeBel J.", "Fish J."]) {
      const participant = record.annotation.structure.participants.find((item) => item.name === name);
      participant.opinion_links.push({
        opinion_id: "o1",
        relation: "joined_in_part",
        evidence: name === "LeBel J." ? partialAgreementEvidence : {
          start_line: 131,
          end_line: 132,
          start_quote: "reasons of LeBel and Fish JJ.",
          end_quote: "with the disposition she proposes.",
        },
      });
    }

    citedDecision(record, "d8").treatments.push({
      treatment_id: "pending",
      opinion_id: "o1",
      signals: ["approved", "applied"],
      other_signal: null,
      proposition: "A municipality has no intention separate from the councillors through whom it acts, so councillors' good faith is inconsistent with a finding that the municipality itself acted in bad faith.",
      treatment: "Deschamps J. approved the Court of Appeal's reasoning, rejected the trial judge's contradictory finding of municipal bad faith, and held the damages award unsupported.",
      evidence_spans: [{
        start_line: 120,
        end_line: 123,
        start_quote: "The Court of Appeal also pointed out",
        end_quote: "the award against the municipal council is without basis in the case at bar.",
      }],
      quoted_passages: [{
        start_line: 122,
        end_line: 123,
        start_quote: "In short, while it may have been apparent",
        end_quote: "the award against the municipal council is without basis in the case at bar.",
      }],
    });
    citedDecision(record, "d9").treatments.push({
      treatment_id: "pending",
      opinion_id: "o1",
      signals: ["criticized", "not_followed"],
      other_signal: null,
      proposition: "The trial court treated the zoning notice as equivalent to Boyd Builders and placed the burden on the municipality to prove good faith.",
      treatment: "Deschamps J. held that the trial court misread Boyd Builders because no permit application was pending and that the resulting burden shift infected its analysis.",
      evidence_spans: [{
        start_line: 108,
        end_line: 114,
        start_quote: "analysis properly begins with comments",
        end_quote: "founded on the error of law he had made",
      }],
      quoted_passages: [{
        start_line: 109,
        end_line: 109,
        start_quote: "The notice of motion of April 4, 1994",
        end_quote: "same effect in terms of the burden of proof.",
      }],
    });
  }

  if (record.document_id === 135183) {
    const protectionFinding = citedDecision(record, "d1");
    protectionFinding.procedural_relationship.description = "A July 15, 2024 decision found the children in need of protective services. It formed part of the same child-protection proceeding in which the present decision determined permanent care.";
    protectionFinding.procedural_relationship.evidence_spans = [{
      start_line: 46,
      end_line: 46,
      start_quote: "On July 15, 2024, the children were found to be in need of protective services",
      end_quote: "In September 2024, the Minister decided to seek permanent care and custody of the children.",
    }];
    protectionFinding.procedural_relationship.actions = [];
    record.annotation.analysis.cited_decisions.push({
      decision_id: "d15",
      identifying_span: {
        start_line: 44,
        end_line: 44,
        start_quote: "the temporary care order",
        end_quote: "the temporary care order",
      },
      procedural_relationship: {
        description: "A temporary-care order placed the children in the Minister's care. The present decision declined to continue temporary care and ordered permanent care and custody instead.",
        evidence_spans: [{
          start_line: 43,
          end_line: 44,
          start_quote: "The children were taken into the temporary care of the Minister",
          end_quote: "an order for permanent care must therefore be granted.",
        }, {
          start_line: 192,
          end_line: 198,
          start_quote: "It is in the best interest of the children to be placed in the permanent care and custody of the Minister.",
          end_quote: "The Minister will please prepare the Order.",
        }],
        actions: [{
          action: "other",
          affected_part: "the temporary-care disposition",
          evidence_spans: [{
            start_line: 192,
            end_line: 198,
            start_quote: "s. 46(6) of the Act precludes me from making a further temporary care order.",
            end_quote: "The Minister will please prepare the Order.",
          }],
        }],
      },
      treatments: [],
    });
    const credibilityProposition = "Credibility should be assessed under the principles in Baker-Warren, as approved in Gill.";
    const credibilityTreatment = "Marche J. applied those principles and found MM credible because she acknowledged past dishonesty, made admissions against interest, spoke frankly, and did not minimize her situation.";
    const bakerWarren = citedDecision(record, "d11").treatments[0];
    bakerWarren.signals = ["applied"];
    bakerWarren.proposition = credibilityProposition;
    bakerWarren.treatment = credibilityTreatment;
    const gill = citedDecision(record, "d12").treatments[0];
    gill.signals = ["followed", "applied"];
    gill.proposition = credibilityProposition;
    gill.treatment = credibilityTreatment;

    const parentingRisk = citedDecision(record, "d4").treatments[0];
    parentingRisk.proposition = "Past parenting history may be relevant because it can signal an expected future protection risk.";
    parentingRisk.treatment = "Marche J. applied D. (S.A.) by treating the parent's long pattern of addiction, failed services, interrupted access, and repeated child-protection involvement as predictive of continuing risk.";
    const parentingProbabilities = citedDecision(record, "d5").treatments[0];
    parentingProbabilities.proposition = "Past parenting history is admissible, germane, and relevant when it assists in determining future probabilities.";
    parentingProbabilities.treatment = "Marche J. applied L.M. by using the parent's history to assess whether meaningful improvement was probable within the remaining statutory time.";
  }

  if (record.document_id === 126799) {
    const revise = (decisionId, opinionId, propositionPrefix, signals, proposition, treatment, evidenceSpans) => {
      const item = treatmentMatching(record, decisionId, opinionId, propositionPrefix);
      item.signals = signals;
      item.proposition = proposition;
      item.treatment = treatment;
      item.evidence_spans = evidenceSpans;
      return item;
    };
    citedDecision(record, "d9").identifying_span = {
      start_line: 88,
      end_line: 88,
      start_quote: "Épiciers Unis Métro-Richelieu Inc., division “Éconogros” v. Collin, 2004 SCC 59, [2004] 3 S.C.R. 257",
      end_quote: "Épiciers Unis Métro-Richelieu Inc., division “Éconogros” v. Collin, 2004 SCC 59, [2004] 3 S.C.R. 257",
    };
    const lowerDecision = citedDecision(record, "d1");
    lowerDecision.treatments.push({
      treatment_id: "pending",
      opinion_id: "o2",
      signals: ["explained", "criticized", "not_followed"],
      other_signal: null,
      proposition: "The motions judge treated section 19A as prospective, following Thibault and distinguishing Page Estate because Nova Scotia lacked an express transition clause.",
      treatment: "Beveridge J.A. agreed that Page Estate was distinguishable and that section 19A's bare wording did not resolve timing, but rejected the lower court's reliance on the presumption and held that the law at death revoked the gift.",
      evidence_spans: [{
        start_line: 234,
        end_line: 257,
        start_quote: "My colleague faults the trial judge",
        end_quote: "I will endeavour to explain why.",
      }, {
        start_line: 268,
        end_line: 281,
        start_quote: "In my opinion, the provisions",
        end_quote: "exactly what the testator did not want to happen.",
      }],
      quoted_passages: [],
    }, {
      treatment_id: "pending",
      opinion_id: "o2",
      signals: ["explained", "approved"],
      other_signal: null,
      proposition: "The motions judge held that the separation agreement did not embody a testamentary intention capable of altering or revoking the will under section 8A.",
      treatment: "Beveridge J.A. read the judge as considering the agreement as a whole rather than imposing a categorical will-reference requirement, and found no reversible error in that conclusion.",
      evidence_spans: [{
        start_line: 306,
        end_line: 321,
        start_quote: "The appellant also has argued",
        end_quote: "I would find no basis to interfere.",
      }],
      quoted_passages: [{
        start_line: 316,
        end_line: 316,
        start_quote: "The separation agreement is",
        end_quote: "I therefore find that s. 8A could not operate to revoke Mr. Hayward's Will.",
      }],
    }, {
      treatment_id: "pending",
      opinion_id: "o3",
      signals: ["criticized", "not_followed"],
      other_signal: null,
      proposition: "The motions judge held that section 19A did not apply where the will and divorce predated the amendment.",
      treatment: "Fichaud J.A. rejected that interpretation because section 19A governs construction when a will takes effect at death, which occurred after the provision came into force.",
      evidence_spans: [{
        start_line: 331,
        end_line: 354,
        start_quote: "I agree with Justice Oland",
        end_quote: "s. 19A already was law.",
      }],
      quoted_passages: [],
    });

    revise(
      "d12", "o1", "These decisions treated comparable",
      ["explained", "criticized", "not_followed"],
      "Matejka held that British Columbia's divorce-revocation provision operated prospectively because its present-tense wording did not clearly reach earlier divorces and its transition provision mentioned earlier wills but not earlier divorces.",
      "Oland J.A. explained Matejka but rejected its reasoning through Page Estate: present-tense wording could describe a past divorce, and legislation governing wills did not require a separate direction about earlier divorce decrees.",
      [{
        start_line: 131,
        end_line: 137,
        start_quote: "Blair, J.A. was aware",
        end_quote: "does not purport to affect the status of divorce decrees.",
      }],
    );
    revise(
      "d14", "o1", "These decisions treated comparable",
      ["explained", "criticized", "not_followed"],
      "Thibault held section 19A prospective, relying on the presumption against retrospectivity, legislative silence, and Ontario's transition clause to distinguish Page Estate.",
      "Oland J.A. rejected Thibault's analysis because Page Estate's retrospective conclusion did not depend on Ontario's transition clause and section 19A's text disclosed a retrospective intention.",
      [{
        start_line: 141,
        end_line: 145,
        start_quote: "The judge then proceeded to consider Thibault Estate.",
        end_quote: "it cannot be read retroactively or retrospectively.",
      }, {
        start_line: 149,
        end_line: 152,
        start_quote: "With respect, the judge in the decision under appeal",
        end_quote: "there is no equivalent provision in our Wills Act.",
      }],
    );
    revise(
      "d15", "o1", "These decisions treated comparable",
      ["explained", "not_followed"],
      "MacDonald followed Thibault and held that the amended will-formality provisions did not apply to an unsigned document made before their proclamation because no clear retrospective intention appeared.",
      "Oland J.A. noted MacDonald's application of Thibault but did not follow that prospective approach, holding that the Wills Act amendments disclosed a retrospective intention.",
      [{
        start_line: 146,
        end_line: 152,
        start_quote: "Thibault Estate was also followed",
        end_quote: "there is no equivalent provision in our Wills Act.",
      }],
    );

    const thibaultBeveridge = revise(
      "d14", "o2", "The lower-court line treated",
      ["explained", "criticized", "not_followed"],
      "Thibault applied the presumption against retrospective prejudicial consequences and held that section 19A affected only divorces occurring after proclamation.",
      "Beveridge J.A. rejected Thibault's use of that presumption because a will beneficiary had no vested right before death and the amendment imposed no prejudicial disability on the testator.",
      [{
        start_line: 211,
        end_line: 213,
        start_quote: "The decision by Justice Boudreau",
        end_quote: "Similar reasoning was applied by Kennedy C.J.S.C.",
      }, {
        start_line: 296,
        end_line: 299,
        start_quote: "Applying these principles here",
        end_quote: "presumption against legislation interfering with vested rights also has no application.",
      }],
    );
    thibaultBeveridge.quoted_passages = [];
    citedDecision(record, "d14").treatments.push({
      treatment_id: "pending",
      opinion_id: "o2",
      signals: ["explained", "approved"],
      other_signal: null,
      proposition: "Thibault distinguished Page Estate because Ontario's statute expressly applied to earlier wills while Nova Scotia's statute had no comparable transition direction.",
      treatment: "Beveridge J.A. agreed that Thibault and the motions judge properly treated Ontario's transition provision as a material distinction from Page Estate.",
      evidence_spans: [{
        start_line: 234,
        end_line: 234,
        start_quote: "My colleague faults the trial judge",
        end_quote: "I also agree with the analysis of the trial judge where he distinguished Page Estate.",
      }, {
        start_line: 256,
        end_line: 256,
        start_quote: "I therefore see no error",
        end_quote: "it would have said so.",
      }],
      quoted_passages: [],
    });
    revise(
      "d15", "o2", "The lower-court line treated",
      ["explained", "not_followed"],
      "MacDonald applied Thibault's prospective reasoning to amended will-formality provisions and declined to validate an unsigned document made before proclamation.",
      "Beveridge J.A. noted MacDonald but rejected the premise that the presumption controlled the amendments' temporal application, because the law at death governed and no vested beneficiary right was impaired.",
      [{
        start_line: 211,
        end_line: 213,
        start_quote: "The decision by Justice Boudreau",
        end_quote: "Similar reasoning was applied by Kennedy C.J.S.C.",
      }, {
        start_line: 296,
        end_line: 299,
        start_quote: "Applying these principles here",
        end_quote: "presumption against legislation interfering with vested rights also has no application.",
      }],
    ).quoted_passages = [];

    revise(
      "d12", "o3", "Matejka Estate and Page Estate construed",
      ["explained", "distinguished"],
      "Matejka construed British Columbia's divorce-revocation legislation together with a transition direction addressing earlier wills.",
      "Fichaud J.A. treated Matejka as tangential because Nova Scotia's Wills Act lacks the transition direction embedded in the statute Matejka construed.",
      [{
        start_line: 342,
        end_line: 342,
        start_quote: "The rulings in Re Matejka Estate",
        end_quote: "judicial interpretation of the whole.",
      }],
    );
    revise(
      "d13", "o3", "Matejka Estate and Page Estate construed",
      ["explained", "distinguished"],
      "Page Estate construed Ontario's divorce-revocation legislation together with a transition direction addressing earlier wills.",
      "Fichaud J.A. treated Page Estate as tangential because Nova Scotia's Wills Act lacks the transition direction embedded in the statute Page construed.",
      [{
        start_line: 342,
        end_line: 342,
        start_quote: "The rulings in Re Matejka Estate",
        end_quote: "judicial interpretation of the whole.",
      }],
    );

    revise(
      "d4", "o1", "Retroactive legislation changes past law",
      ["explained", "followed"],
      "A statute is not construed to operate retrospectively unless its language expressly or by necessary implication requires that result.",
      "Oland J.A. used Gustavson Drilling as the starting presumption for deciding whether section 19A reached a divorce that predated the amendment.",
      [{
        start_line: 73,
        end_line: 74,
        start_quote: "Statutory interpretation is also guided",
        end_quote: "the statute operates retrospectively.",
      }],
    );
    revise(
      "d7", "o1", "Retroactive legislation changes past law",
      ["explained", "followed"],
      "Retroactive legislation changes the law for an earlier period, while retrospective legislation changes future consequences of a completed event; only prejudicial retrospective consequences attract the presumption.",
      "Oland J.A. adopted Nova Scotia Pharmaceutical Society's account of the retroactive-retrospective distinction and the prejudice limit on the presumption.",
      [{
        start_line: 76,
        end_line: 87,
        start_quote: "In R. v. Nova Scotia Pharmaceutical Society",
        end_quote: "these do not attract the presumption.",
      }],
    );
    revise(
      "d9", "o1", "Retroactive legislation changes past law",
      ["explained", "followed"],
      "Retroactive legislation changes past law, whereas retrospective legislation changes future consequences of past events.",
      "Oland J.A. cited Épiciers Unis for the Supreme Court's approval of the Driedger distinction she used to classify section 19A.",
      [{
        start_line: 88,
        end_line: 88,
        start_quote: "The distinction between retroactivity and retrospectivity",
        end_quote: "at ¶ 46.",
      }],
    );
    revise(
      "d10", "o1", "Retroactive legislation changes past law",
      ["explained", "followed"],
      "The presumption against retrospectivity applies to prejudicial statutes, not beneficial ones, and may be rebutted by a protective statutory purpose.",
      "Oland J.A. used Brosseau to frame the prejudice inquiry that determines whether the presumption against retrospectivity applies.",
      [{
        start_line: 89,
        end_line: 89,
        start_quote: "Two additional cases",
        end_quote: "the presumption against the retrospective effect of statutes was rebutted.",
      }],
    );
    revise(
      "d5", "o1", "The presumption against interference with vested rights",
      ["explained", "followed", "applied"],
      "Absent a clear indication, legislation is presumed not to interfere prejudicially with liberty, accrued rights, or property.",
      "Oland J.A. applied the accrued-rights presumption but held that Nancy Hayward had no vested entitlement before the testator died.",
      [{
        start_line: 75,
        end_line: 75,
        start_quote: "There is also a presumption",
        end_quote: "citing Spooner at ¶ 33.",
      }, {
        start_line: 162,
        end_line: 162,
        start_quote: "Nancy Hayward’s entitlement under the will was no more than an expectancy",
        end_quote: "bring that presumption into play.",
      }],
    );
    revise(
      "d6", "o1", "The presumption against interference with vested rights",
      ["explained", "followed", "applied"],
      "A vested right requires a tangible, concrete legal situation that was sufficiently constituted when the new statute commenced.",
      "Oland J.A. applied Dikranian's two-part test and held that Nancy Hayward's expectancy under a revocable will had not vested before death.",
      [{
        start_line: 90,
        end_line: 93,
        start_quote: "The 2005 decision",
        end_quote: "namely the repayment terms.",
      }, {
        start_line: 162,
        end_line: 162,
        start_quote: "Nancy Hayward’s entitlement under the will was no more than an expectancy",
        end_quote: "bring that presumption into play.",
      }],
    );

    revise(
      "d24", "o1", "Section 8A validates an imperfect writing",
      ["explained"],
      "Section 8A validated a revised will that the testator signed without proper witnesses because the evidence proved it was her deliberate, fixed, and final testamentary intention.",
      "Oland J.A. used Robitaille as a fact-specific example of section 8A curing defective execution when final testamentary intention is established.",
      [{
        start_line: 188,
        end_line: 189,
        start_quote: "Since this appeal was heard",
        end_quote: "the document was valid and fully effective.",
      }],
    );
    revise(
      "d25", "o1", "Section 8A validates an imperfect writing",
      ["explained"],
      "Section 8A did not validate a signed printed form completed partly in pencil because the applicant failed to prove that it embodied the deceased's fixed and final testamentary intention.",
      "Oland J.A. used Komonen as a contrasting, fact-specific example in which the proof of final testamentary intention was insufficient.",
      [{
        start_line: 188,
        end_line: 190,
        start_quote: "Since this appeal was heard",
        end_quote: "his fixed and final intention as to the disposal of his property upon death.",
      }],
    );
    revise(
      "d26", "o1", "Before the 2008 amendments",
      ["explained", "distinguished"],
      "Morrell Estate considered whether a person could contractually renounce a testamentary gift before the testator's death, on facts wholly predating the 2008 Wills Act amendments.",
      "Oland J.A. found Morrell Estate unhelpful because it did not analyze the amendments governing the Hayward appeal.",
      [{
        start_line: 192,
        end_line: 193,
        start_quote: "The respondent counters",
        end_quote: "before George Hayward’s passing.",
      }],
    );
    revise(
      "d27", "o1", "Before the 2008 amendments",
      ["explained", "distinguished"],
      "Robinson affirmed Morrell Estate's decision about contractual renunciation of a testamentary gift on facts wholly predating the 2008 Wills Act amendments.",
      "Oland J.A. found the appellate Morrell decision unhelpful because it did not analyze the amendments governing the Hayward appeal.",
      [{
        start_line: 192,
        end_line: 193,
        start_quote: "The respondent counters",
        end_quote: "before George Hayward’s passing.",
      }],
    );
    revise(
      "d28", "o1", "Promissory estoppel requires",
      ["explained", "followed", "applied"],
      "Promissory estoppel requires negotiations that lead one party to suppose strict rights will not be enforced and an intention to alter the parties' legal relations.",
      "Oland J.A. accepted the motions judge's use of Burrows and found the estoppel claim failed because the evidence did not show reliance on the separation agreement.",
      [{
        start_line: 198,
        end_line: 199,
        start_quote: "The issue before the trial judge",
        end_quote: "(See the Burrows case at p. 615).",
      }, {
        start_line: 203,
        end_line: 203,
        start_quote: "To dispose of this issue",
        end_quote: "I would dismiss this ground of appeal.",
      }],
    );
    revise(
      "d29", "o1", "Promissory estoppel requires",
      ["explained", "followed", "applied"],
      "Promissory estoppel requires a promise or assurance intended to affect legal relations and action or a change of position in reliance on it.",
      "Oland J.A. applied Maracle's reliance requirement and rejected estoppel because there was no evidence that George Hayward left his will unchanged in reliance on the separation agreement.",
      [{
        start_line: 199,
        end_line: 200,
        start_quote: "As Sopinka, J. put it in Maracle",
        end_quote: "he acted on it or in some way changed his position.",
      }, {
        start_line: 203,
        end_line: 203,
        start_quote: "To dispose of this issue",
        end_quote: "I would dismiss this ground of appeal.",
      }],
    );

    lowerDecision.procedural_relationship.actions[0].affected_part = "the order recognizing Nancy Hayward as executor and beneficiary under the will";
  }

  if (record.document_id === 13847) {
    citedDecision(record, "d1").procedural_relationship.actions[0].affected_part = "the deduction of social assistance and the calculation of prejudgment interest on the past-loss award";
    citedDecision(record, "d2").procedural_relationship.actions[0].affected_part = "the damages ruling concerning social-assistance deductions and prejudgment interest";
    citedDecision(record, "d1").treatments.push({
      treatment_id: "pending",
      opinion_id: "o2",
      signals: ["criticized", "not_followed"],
      other_signal: null,
      proposition: "The trial judge deducted all income assistance from the assessed past earning-capacity loss as compensation for the same loss.",
      treatment: "Mackenzie J.A. rejected that deduction because the assistance responded to need in different periods and did not compensate the same loss caused by the two torts.",
      evidence_spans: [{
        start_line: 227,
        end_line: 235,
        start_quote: "Social welfare benefits are",
        end_quote: "the benefits paid to the plaintiff are not deductible.",
      }],
      quoted_passages: [],
    }, {
      treatment_id: "pending",
      opinion_id: "o4",
      signals: ["approved", "followed"],
      other_signal: null,
      proposition: "The trial judge treated the past earning-capacity award as replacing income and deducted the assistance that had partly replaced that income.",
      treatment: "Hall J.A. approved the deduction, finding that the statutory payments replaced income and fell outside the insurance, pension, and charitable exceptions.",
      evidence_spans: [{
        start_line: 263,
        end_line: 270,
        start_quote: "At trial, the parties were agreed",
        end_quote: "the method of interest calculation on the past loss award.",
      }, {
        start_line: 287,
        end_line: 298,
        start_quote: "In this case, the respondent argues",
        end_quote: "that case was correctly decided.",
      }],
      quoted_passages: [{
        start_line: 266,
        end_line: 266,
        start_quote: "There is no question that the sexual assault",
        end_quote: "up to the date of trial.",
      }],
    });
    citedDecision(record, "d5").treatments.push({
      treatment_id: "pending",
      opinion_id: "o1",
      signals: ["explained", "distinguished", "applied"],
      other_signal: null,
      proposition: "Ratych confines pecuniary damages to actual loss and rejects broad non-deductibility where a collateral benefit compensates that same loss.",
      treatment: "Prowse J.A. applied Ratych's same-loss inquiry but distinguished its wage-benefit setting, holding that Ratych did not decide welfare deductibility and that need-based assistance did not duplicate the earning-capacity award.",
      evidence_spans: [{
        start_line: 121,
        end_line: 122,
        start_quote: "I can find nothing in either Ratych or Cunningham",
        end_quote: "non-deductibility of other benefits",
      }, {
        start_line: 143,
        end_line: 169,
        start_quote: "Unless the social assistance benefits duplicate damages",
        end_quote: "independent of any right she may have had to recover damages",
      }],
      quoted_passages: [],
    });
    citedDecision(record, "d6").treatments.push({
      treatment_id: "pending",
      opinion_id: "o1",
      signals: ["explained", "extended", "applied"],
      other_signal: null,
      proposition: "Private insurance and charitable gifts are established exceptions to deduction because fairness protects purchased security and public policy prevents a wrongdoer from benefiting from benevolence.",
      treatment: "Prowse J.A. used Cunningham's explanation of those exceptions and extended the charitable rationale to statutory assistance directed to relieving need.",
      evidence_spans: [{
        start_line: 82,
        end_line: 106,
        start_quote: "The courts, however, have consistently recognized",
        end_quote: "Parliament did not intend them to be for the benefit of the wrongdoer.",
      }, {
        start_line: 176,
        end_line: 193,
        start_quote: "In the event I am in error in finding",
        end_quote: "the principles underlying the exception justify this expansion.",
      }, {
        start_line: 194,
        end_line: 202,
        start_quote: "In coming to this conclusion",
        end_quote: "overrule the prior decisions of this Court",
      }],
      quoted_passages: [{
        start_line: 89,
        end_line: 92,
        start_quote: "I think the exemption for the private policy of insurance should be maintained.",
        end_quote: "they have provided for themselves.",
      }, {
        start_line: 97,
        end_line: 106,
        start_quote: "The first exception to the rule against double recovery",
        end_quote: "Parliament did not intend them to be for the benefit of the wrongdoer.",
      }],
    });
    for (const id of ["d8", "d9", "d10", "d25", "d27"]) {
      const treatment = citedDecision(record, id).treatments.find(({ opinion_id }) => opinion_id === "o4");
      treatment.signals = [...new Set(treatment.signals.map((signal) => signal === "limited" ? "distinguished" : signal))];
    }
    for (const [id, opinionId] of [["d16", "o1"], ["d20", "o2"]]) {
      const treatment = citedDecision(record, id).treatments.find(({ opinion_id }) => opinion_id === opinionId);
      treatment.signals = [...new Set(treatment.signals.map((signal) => signal === "limited" ? "distinguished" : signal))];
    }

    const revise = (decisionId, opinionId, propositionPrefix, signals, proposition, treatment) => {
      const item = treatmentMatching(record, decisionId, opinionId, propositionPrefix);
      item.signals = signals;
      item.proposition = proposition;
      item.treatment = treatment;
      return item;
    };
    revise(
      "d8", "o1", "Private insurance and charitable gifts remain",
      ["explained", "followed", "applied"],
      "Benefits bought through a private insurance contract are not deducted because the insured paid premiums to obtain independent protection.",
      "Prowse J.A. traced the private-insurance exception to Bradburn and used its purchased-security rationale when testing whether statutory assistance fit an established exception.",
    );
    revise(
      "d9", "o1", "Private insurance and charitable gifts remain",
      ["explained", "followed", "applied"],
      "Private insurance remains non-deductible because fairness lets the insured, rather than the tortfeasor, benefit from the insured's prudence and sacrifice.",
      "Prowse J.A. followed Parry's fairness rationale when explaining the private-insurance exception before assessing statutory assistance.",
    );
    revise(
      "d5", "o2", "Bradburn and Parry supplied",
      ["approved", "followed", "applied"],
      "The threshold question is whether the collateral payment compensates the same loss as the tort award.",
      "Mackenzie J.A. followed Ratych's same-loss inquiry and held that need-based assistance in different periods did not compensate the earning-capacity loss caused by the torts.",
    );
    revise(
      "d8", "o2", "Bradburn and Parry supplied",
      ["explained", "limited"],
      "Bradburn was a source of the historic broad non-deduction line for collateral benefits, but later authority made compensation for the same loss the threshold inquiry.",
      "Mackenzie J.A. treated Bradburn as historical background and confined its non-deduction principle in light of Ratych's same-loss requirement.",
    );
    revise(
      "d9", "o2", "Bradburn and Parry supplied",
      ["explained", "limited"],
      "Parry affirmed the historic broad non-deduction line for collateral benefits, but later authority made compensation for the same loss the threshold inquiry.",
      "Mackenzie J.A. treated Parry as historical background and confined its non-deduction principle in light of Ratych's same-loss requirement.",
    );
    revise(
      "d3", "o5", "Actual financial loss governs",
      ["approved", "followed", "applied"],
      "Income assistance retained alongside damages for the same past income loss is deductible unless an established collateral-benefit exception applies.",
      "Smith J.A. expressly agreed that M.(M.) was correctly decided and applied it to deduct the assistance that had replaced part of M.B.'s lost income.",
    );
    revise(
      "d5", "o4", "M.(M.) read Ratych's actual-loss rule",
      ["followed", "applied"],
      "Pecuniary damages are confined to the plaintiff's actual financial loss and do not compensate an amount already replaced from another source.",
      "Hall J.A. followed Ratych's actual-loss reasoning and treated the assistance as replacing part of the claimed income loss.",
    );
    revise(
      "d5", "o5", "Actual financial loss governs",
      ["approved", "followed", "applied"],
      "Pecuniary damages are confined to actual financial loss; a plaintiff cannot recover an income loss already replaced from another source.",
      "Smith J.A. adopted Ratych's actual-loss rule and held that the assistance had offset part of M.B.'s lost income.",
    );
    revise(
      "d6", "o5", "Actual financial loss governs",
      ["explained", "followed", "applied"],
      "Private insurance and comparable purchased benefits remain exceptions to deduction because the plaintiff earned or paid for them.",
      "Smith J.A. followed Cunningham's purchased-benefit rationale but held that taxpayer-funded income assistance did not fit the exception.",
    );
    revise(
      "d8", "o4", "Insurance, pension, and charitable payments are exceptional",
      ["explained", "distinguished"],
      "Private insurance is non-deductible because the plaintiff paid to acquire the benefit.",
      "Hall J.A. accepted Bradburn's insurance exception but distinguished unpurchased statutory assistance from an insurance benefit.",
    );
    revise(
      "d9", "o4", "Insurance, pension, and charitable payments are exceptional",
      ["explained", "distinguished"],
      "Insurance-like benefits purchased by the plaintiff are not deducted from tort damages.",
      "Hall J.A. accepted the insurance rationale discussed in Parry but distinguished statutory assistance for which the recipient contributed nothing.",
    );
    revise(
      "d10", "o4", "Insurance, pension, and charitable payments are exceptional",
      ["explained", "distinguished"],
      "A charitable payment independent of the compensatory loss is not deducted for the tortfeasor's benefit.",
      "Hall J.A. accepted Redpath's charitable exception but distinguished entitlement-based statutory income assistance from public donations to accident victims.",
    );
    revise(
      "d25", "o4", "Insurance, pension, and charitable payments are exceptional",
      ["explained", "distinguished"],
      "An allowance from a friendly society is insurance-like and non-deductible when it represents a return for money paid.",
      "Hall J.A. accepted Forgie's purchased-benefit rationale but distinguished statutory assistance funded without recipient contributions.",
    );
    revise(
      "d27", "o4", "Insurance, pension, and charitable payments are exceptional",
      ["explained", "distinguished"],
      "A pension is non-deductible when the injured person paid for it in whole or in part.",
      "Hall J.A. accepted the pension exception recognized in C.P.R. v. Gill but distinguished statutory assistance funded without recipient contributions.",
    );
    for (const id of ["d11", "d12"]) {
      const item = treatmentMatching(record, id, "o4", "English courts deducted statutory social benefits");
      item.signals = ["explained", "followed"];
    }
    revise(
      "d16", "o5", "Government-funded care offsets",
      ["explained", "followed", "applied"],
      "Government-funded group-home care prevents a corresponding tort loss while it remains available, subject to a contingency for possible policy change.",
      "Smith J.A. followed Krangle's treatment of free state care and applied the same-loss analogy to income assistance replacing past income.",
    );
    revise(
      "d31", "o5", "Government-funded care offsets",
      ["approved", "followed", "applied"],
      "Government-funded hospitalization and rehabilitation offset the corresponding cost-of-care loss.",
      "Smith J.A. followed Wipfli as confirmation that state-provided services can extinguish the matching tort loss and applied that reasoning by analogy to income assistance.",
    );

    revise(
      "d3", "o1", "M.(M.) and Jones treated",
      ["explained", "criticized", "overruled"],
      "The M.(M.) majority held retained social assistance deductible from past wage loss because Ratych had displaced Boarelli and welfare did not fit the charitable-gifts exception.",
      "Prowse J.A. overruled M.(M.) on welfare deductibility because it assumed the payments duplicated the same loss and construed the charitable rationale too narrowly.",
    );
    revise(
      "d4", "o1", "M.(M.) and Jones treated",
      ["explained", "criticized", "overruled"],
      "Jones treated retained welfare as deductible under M.(M.), while holding that repayment to the government prevented double recovery on its facts.",
      "Prowse J.A. overruled Jones to the extent it assumed that retaining social assistance necessarily duplicated past wage loss without examining the benefits' purpose and timing.",
    );
    revise(
      "d4", "o2", "A collateral benefit is not deducted",
      ["explained", "followed", "distinguished"],
      "Jones held that social assistance was not deductible where the plaintiff had to repay it from the tort award and therefore could not retain both payments.",
      "Mackenzie J.A. accepted Jones's repayment rule but distinguished it because the Province had not pursued a repayment agreement with M.B.",
    );
    revise(
      "d6", "o2", "A collateral benefit is not deducted",
      ["explained", "followed"],
      "Cunningham treated it as axiomatic that a collateral benefit is not deducted when subrogation or repayment prevents the plaintiff from retaining it.",
      "Mackenzie J.A. followed Cunningham's subrogation principle but found no repayment obligation in this case.",
    );
    revise(
      "d14", "o2", "A collateral benefit is not deducted",
      ["explained", "followed"],
      "Boarelli's narrow ratio was that welfare is not deducted when the recipient must repay it from the tort award.",
      "Mackenzie J.A. followed Boarelli's narrow repayment rule but found it inapplicable because the Province had not pursued a repayment agreement.",
    );
    revise(
      "d5", "o5", "Income received while unable to work",
      ["explained", "extended", "applied"],
      "Ratych accepted that wages paid during an absence do not differ in kind from working wages and reiterated that a plaintiff must prove an actual loss.",
      "Smith J.A. extended Ratych's reasoning to statutory income assistance and held that it replaced the portion of employment income used for basic needs.",
    );
    revise(
      "d9", "o5", "Income received while unable to work",
      ["explained", "extended", "applied"],
      "Parry stated that wages paid while a person is unable to work do not differ in kind from wages paid while working.",
      "Smith J.A. extended Parry's observation to statutory income assistance and held that it partly replaced the claimed employment income.",
    );
    revise(
      "d6", "o4", "Tort damages restore the injured party",
      ["followed", "applied"],
      "Tort damages should compensate the injured party as fully as possible, but the plaintiff may not recover twice for the same loss.",
      "Hall J.A. followed Cunningham's compensatory rule and classified income assistance tied to inability to work as partial replacement for the claimed income loss.",
    );
    revise(
      "d26", "o4", "Tort damages restore the injured party",
      ["explained", "followed", "applied"],
      "Damages should place the injured person as nearly as possible in the position they would have occupied without the wrong.",
      "Hall J.A. used Livingstone's restorative principle when deciding whether the assistance and the tort award compensated the same loss.",
    );
    revise(
      "d9", "o1", "Public policy prevents a wrongdoer",
      ["explained", "extended", "applied"],
      "Private benevolence should not reduce damages for the wrongdoer's benefit; Parry left open whether that public-policy rationale also applies to welfare-state benefits.",
      "Prowse J.A. answered Parry's open question by extending its benevolence rationale to statutory assistance directed to relieving need.",
    );
    revise(
      "d10", "o1", "Public policy prevents a wrongdoer",
      ["explained", "extended", "applied"],
      "A disaster fund voluntarily subscribed for accident victims is independent of the tort loss and should not reduce the wrongdoer's liability.",
      "Prowse J.A. extended Redpath's public-policy rationale from voluntary disaster relief to statutory assistance serving the same need-relief purpose.",
    );
    revise(
      "d11", "o1", "Lincoln and Hodgson deducted",
      ["explained", "distinguished"],
      "Lincoln deducted a supplementary benefit paid as of right because the plaintiff's accident-caused need made it overlap his past wage loss.",
      "Prowse J.A. distinguished Lincoln because the English benefit and legislation differed from British Columbia's need-based scheme.",
    );
    revise(
      "d12", "o1", "Lincoln and Hodgson deducted",
      ["explained", "distinguished"],
      "Hodgson deducted statutory attendance and mobility allowances because they overlapped a corresponding head of tort damages.",
      "Prowse J.A. distinguished Hodgson because its benefits and legislative setting differed from the British Columbia assistance at issue.",
    );
    revise(
      "d11", "o4", "English courts deducted statutory social benefits",
      ["explained", "followed"],
      "Lincoln deducted supplementary benefits that overlapped the plaintiff's wage-loss damages to prevent overcompensation.",
      "Hall J.A. treated Lincoln as supporting deduction where statutory assistance and damages compensate the same income loss.",
    );
    revise(
      "d12", "o4", "English courts deducted statutory social benefits",
      ["explained", "followed"],
      "Hodgson deducted attendance and mobility allowances that overlapped a corresponding head of tort damages.",
      "Hall J.A. treated Hodgson as supporting deduction where statutory assistance and damages compensate the same loss.",
    );
    revise(
      "d22", "o2", "Shaw and Kitnikone tolerated",
      ["explained", "distinguished"],
      "Shaw accepted full-amount interest at the lowest applicable rate as a practical calculation for a two-year wage-loss period.",
      "Mackenzie J.A. distinguished Shaw because the twenty-year loss here made embedded inflation material and full-period interest would compensate it twice.",
    );
    revise(
      "d23", "o2", "Shaw and Kitnikone tolerated",
      ["explained", "distinguished"],
      "Kitnikone involved a relatively short period of past housekeeping loss in which the inflation component was insignificant.",
      "Mackenzie J.A. distinguished Kitnikone because inflation was substantial over the twenty-year loss period before him.",
    );
  }

  if (record.document_id === 118406) {
    const revise = (decisionId, opinionId, propositionPrefix, signals, proposition, treatment) => {
      const item = treatmentMatching(record, decisionId, opinionId, propositionPrefix);
      item.signals = signals;
      item.proposition = proposition;
      item.treatment = treatment;
      return item;
    };
    const lowerDecision = citedDecision(record, "d1");
    lowerDecision.treatments[0].signals = lowerDecision.treatments[0].signals.filter((signal) => signal !== "limited");
    lowerDecision.treatments.push({
      treatment_id: "pending",
      opinion_id: "o1",
      signals: ["approved", "applied"],
      other_signal: null,
      proposition: "The order deciding Felipa's separate motion was appealable despite the statutory restrictions on interlocutory and uncertified immigration judicial-review judgments.",
      treatment: "Sharlow and Dawson JJ.A. agreed substantially with the Federal Court's appealability analysis and held that Felipa could appeal without a certified question.",
      evidence_spans: [{
        start_line: 60,
        end_line: 62,
        start_quote: "The parties and the Chief Justice agreed",
        end_quote: "does not require a certified question.",
      }],
      quoted_passages: [{
        start_line: 61,
        end_line: 61,
        start_quote: "separate, divisible judicial act",
        end_quote: "separate, divisible judicial act",
      }],
    });
    const parliamentaryStatement = lowerDecision.treatments.find(({ proposition }) => proposition.startsWith("The Federal Court used a parliamentary statement"));
    parliamentaryStatement.signals = ["explained", "approved"];

    revise(
      "d10", "o1", "Statutory words must be read",
      ["followed"],
      "Statutory words are read in their full context and ordinary grammatical sense, harmoniously with the statutory scheme, object, and legislative intention.",
      "The majority followed the modern contextual approach stated in Rizzo when construing the Federal Courts Act.",
    );
    revise(
      "d11", "o1", "Statutory words must be read",
      ["followed"],
      "Ulybel applied the modern contextual approach to statutory interpretation stated in Rizzo.",
      "The majority cited Ulybel as additional Supreme Court authority for the contextual method it applied.",
    );
    revise(
      "d12", "o1", "Statutory interpretation uses a textual",
      ["followed"],
      "Statutory interpretation combines text, context, and purpose; their relative weight varies, but the resulting meaning must harmonize with the Act as a whole.",
      "The majority treated Canada Trustco's formulation as the governing interpretive method.",
    );
    revise(
      "d14", "o1", "Statutory interpretation uses a textual",
      ["explained", "followed"],
      "Celgene restated Canada Trustco's textual, contextual, and purposive method of statutory interpretation.",
      "The majority cited Celgene as recent confirmation of the method it applied.",
    );
    revise(
      "d15", "o1", "Statutory interpretation uses a textual",
      ["explained", "followed"],
      "Information Commissioner restated Canada Trustco's textual, contextual, and purposive method of statutory interpretation.",
      "The majority cited Information Commissioner as recent confirmation of the method it applied.",
    );
    revise(
      "d12", "o2", "Statutory text must be read",
      ["followed", "applied"],
      "The relative weight of text, context, and purpose may vary between cases.",
      "The dissent applied Canada Trustco's flexible weighting principle but assigned the interpretive factors different weight from the majority.",
    );
    revise(
      "d15", "o2", "Statutory text must be read",
      ["followed", "applied"],
      "Statutory words are read in context and in their ordinary grammatical sense, harmoniously with the statutory scheme and object.",
      "The dissent used Information Commissioner's formulation while reaching a different interpretation from the majority.",
    );
    revise(
      "d19", "o1", "Legislative intention is an objective",
      ["explained", "followed"],
      "Legislative intention is the objective meaning a court reasonably attributes to Parliament's enacted language, not the subjective intent of ministers, drafters, or legislators.",
      "The majority adopted Spath Holme's account of objective legislative intention.",
    );
    revise(
      "d20", "o1", "Legislative intention is an objective",
      ["explained", "followed"],
      "Seeking Parliament's intention means seeking the meaning of the words Parliament enacted.",
      "The majority used Black-Clawson's formulation to reinforce that legislative intent is objective and text-based.",
    );
  }

  if (record.document_id === 192926) {
    record.annotation.structure.disposition_spans.push({
      start_line: 820,
      end_line: 820,
      start_quote: "I would allow the appeal.",
      end_quote: "I would allow the appeal.",
    });
    record.annotation.structure.opinions.push({
      opinion_id: "o5",
      boundary: {
        start_line: 820,
        end_line: 820,
        start_quote: "MCLACHLIN J. (dissenting) -- I am in substantial agreement",
        end_quote: "I would allow the appeal.",
      },
      collective_author: null,
      result_position: "opposes_disposition",
      result_evidence: {
        start_line: 820,
        end_line: 820,
        start_quote: "I would allow the appeal.",
        end_quote: "I would allow the appeal.",
      },
    });
    const mclachlin = record.annotation.structure.participants.find(({ name }) => name === "McLachlin J.");
    mclachlin.opinion_links = [{
      opinion_id: "o5",
      relation: "wrote",
      evidence: {
        start_line: 820,
        end_line: 820,
        start_quote: "MCLACHLIN J. (dissenting)",
        end_quote: "I would allow the appeal.",
      },
    }, {
      opinion_id: "o4",
      relation: "joined_in_part",
      evidence: {
        start_line: 820,
        end_line: 820,
        start_quote: "MCLACHLIN J. (dissenting) -- I am in substantial agreement with the reasons of Justices Cory and Iacobucci.",
        end_quote: "I am in substantial agreement with the reasons of Justices Cory and Iacobucci.",
      },
    }];
    citedDecision(record, "d2").treatments.push({
      treatment_id: "pending",
      opinion_id: "o5",
      signals: ["followed", "applied"],
      other_signal: null,
      proposition: "The section 15 principles McLachlin J. set out in Miron govern the equality claim.",
      treatment: "McLachlin J. applied those principles, substantially agreed with Cory and Iacobucci JJ., and would have allowed the appeal.",
      evidence_spans: [{
        start_line: 820,
        end_line: 820,
        start_quote: "Applying the principles which I discuss in Miron v. Trudel",
        end_quote: "I would allow the appeal.",
      }],
      quoted_passages: [],
    });

    const revise = (decisionId, opinionId, propositionPrefix, signals, proposition, treatment) => {
      const item = treatmentMatching(record, decisionId, opinionId, propositionPrefix);
      item.signals = signals;
      item.proposition = proposition;
      item.treatment = treatment;
      return item;
    };

    revise(
      "d2", "o1", "Equality analysis asks",
      ["explained", "followed", "applied"],
      "Section 15 asks whether a legislative distinction creates disadvantage based on an irrelevant enumerated or analogous characteristic, with relevance assessed against the law's functional values through comparison.",
      "La Forest J. adopted Gonthier J.'s three-step Miron framework and used its relevance inquiry to ask whether excluding same-sex couples served the Act's functional values.",
    );
    revise(
      "d2", "o1", "Marriage is a fundamental",
      ["followed", "applied"],
      "Marriage is a fundamental social institution associated with procreation and child-rearing that Parliament may specially support, including through common-law relationships, without limiting support to couples who actually have children.",
      "La Forest J. followed Gonthier J.'s Miron reasoning and applied it to hold that Parliament could support opposite-sex married and common-law couples without discriminating against same-sex couples.",
    );

    const andrews = revise(
      "d3", "o1", "Equality analysis asks",
      ["explained", "followed", "applied"],
      "Section 15 targets disadvantage based on irrelevant personal differences; equality is comparative and contextual rather than a mechanical similarly-situated test, and not every legislative distinction is discriminatory.",
      "La Forest J. treated Andrews as the governing framework and applied its relevance, comparison, context, and institutional-balance principles to conclude that the exclusion was not discriminatory.",
    );
    andrews.evidence_spans = uniqueSpans([
      ...andrews.evidence_spans,
      ...treatmentMatching(record, "d3", "o1", "Marriage is a fundamental").evidence_spans,
    ]);
    citedDecision(record, "d3").treatments = citedDecision(record, "d3").treatments.filter((item) =>
      !(item.opinion_id === "o1" && item.proposition.startsWith("Marriage is a fundamental")));

    revise(
      "d4", "o1", "Equality analysis asks",
      ["explained", "followed", "applied"],
      "Determining whether particular facts produce inequality requires comparative analysis.",
      "La Forest J. cited Symes for the comparative inquiry and used it when assessing the relevance of sexual orientation to the Act's asserted purposes.",
    );
    revise(
      "d4", "o2", "A protected ground does not automatically",
      ["explained", "applied"],
      "Adverse-effects analysis cannot turn on an arbitrary percentage threshold for linking a facial classification to an enumerated ground.",
      "L'Heureux-Dubé J. invoked the difficulty identified in Symes and preferred asking directly how the distinction affects the group before the court.",
    );
    revise(
      "d4", "o4", "Equality requires a contextual comparison",
      ["explained", "followed", "applied"],
      "Equality and discrimination require comparative analysis rather than evaluation in a vacuum.",
      "Cory J. cited Symes for the comparative requirement and compared same-sex couples with opposite-sex common-law couples receiving the allowance.",
    );

    revise(
      "d5", "o1", "Equality analysis asks",
      ["explained", "followed", "applied"],
      "The comparative equality inquiry must consider the larger social, political, and legal context.",
      "La Forest J. followed Turpin's contextual approach when examining whether the statutory distinction was relevant to the Act's functional values.",
    );
    revise(
      "d5", "o2", "Section 15 protects equal human worth",
      ["explained", "followed", "applied"],
      "An important purpose of section 15 is preventing or reducing distinctions that worsen the position of historically disadvantaged or marginalized groups.",
      "L'Heureux-Dubé J. used Turpin to make the affected group's social vulnerability part of her discrimination framework.",
    );
    revise(
      "d5", "o4", "Equality requires a contextual comparison",
      ["explained", "followed", "applied"],
      "Section 15 asks whether a distinction creates disadvantage on an enumerated or analogous characteristic in its social, political, and legal context, while justification remains a separate section 1 inquiry.",
      "Cory J. followed Turpin's two-step and contextual method and applied it to the exclusion of same-sex couples.",
    );

    revise(
      "d6", "o1", "Equality analysis asks",
      ["explained", "followed", "applied"],
      "Charter interpretation places a right in its linguistic, philosophical, and historical context rather than applying mechanical categories.",
      "La Forest J. invoked Big M's contextual method when defining the relevant statutory purpose and comparison.",
    );
    revise(
      "d6", "o2", "Section 15 protects equal human worth",
      ["explained", "followed", "applied"],
      "Purposive rights interpretation begins by identifying the right's purpose, and inherent human dignity is central to individual rights in a free and democratic society.",
      "L'Heureux-Dubé J. used Big M to ground her purpose-first definition of section 15 discrimination in equal human dignity.",
    );

    revise(
      "d7", "o1", "Equality analysis asks",
      ["explained", "followed", "applied"],
      "Charter analysis must account for legal and social context rather than rely on mechanical categorization.",
      "La Forest J. invoked Cotroni as support for the contextual inquiry he used to assess the statutory distinction.",
    );
    revise(
      "d7", "o1", "Marriage is a fundamental",
      ["followed", "applied"],
      "Courts should leave legislatures reasonable room to manoeuvre when drawing administrable lines.",
      "La Forest J. applied Cotroni's latitude principle and declined to require an intrusive scheme restricted to opposite-sex couples who actually had children.",
    );

    revise(
      "d8", "o1", "Equality analysis asks",
      ["explained", "followed", "applied"],
      "The similarly-situated test is rejected because a narrow comparison of who receives a benefit ignores the law's purpose and impact.",
      "La Forest J. relied on McKinney when rejecting a benefit-only comparison and instead examined the Act's functional values.",
    );
    revise(
      "d8", "o2", "Section 15 protects equal human worth",
      ["approved", "followed"],
      "Section 15 protects people against stereotyping and prejudice that undermine equality.",
      "L'Heureux-Dubé J. expressly treated Wilson J.'s statement in McKinney as authoritative on this point and used it to define discrimination through dignity and impact.",
    );

    revise(
      "d9", "o1", "Equality analysis asks",
      ["explained", "followed", "applied"],
      "A mechanical similarly-situated test leaves no principled room to consider why a law draws a distinction.",
      "La Forest J. relied on the Mahe passage, as approved in Andrews, to reject mechanical categorization and examine the reason for the distinction.",
    );

    revise(
      "d10", "o1", "The Old Age Security Act separately",
      ["approved", "followed", "applied"],
      "The Old Age Security Act provides universal pensions, need-based supplements, and allowances for qualifying spouses, while excluding many other forms of cohabitation.",
      "La Forest J. adopted Mahoney J.A.'s description of the scheme and excluded relationships as the factual setting for his functional comparison.",
    );
    revise(
      "d10", "o2", "The allowance maintains retirement income",
      ["approved", "followed", "applied"],
      "The spousal allowance aims to preserve a couple's income when one partner retires before the other becomes pension-eligible.",
      "L'Heureux-Dubé J. adopted Linden J.A.'s account of the program's purpose and used it in her section 1 analysis.",
    );

    revise(
      "d13", "o2", "A protected ground does not automatically",
      ["explained", "followed", "applied"],
      "The same facial distinction may discriminate against a socially vulnerable group without discriminating against a differently situated group.",
      "L'Heureux-Dubé J. used Weatherall as an example of why discriminatory effect depends on the affected group's circumstances.",
    );
    revise(
      "d14", "o2", "A protected ground does not automatically",
      ["explained", "followed", "applied"],
      "The same facial distinction may discriminate against a socially vulnerable group without discriminating against a differently situated group.",
      "L'Heureux-Dubé J. used Hess as an example of why discriminatory effect depends on the affected group's circumstances.",
    );
    revise(
      "d15", "o2", "A protected ground does not automatically",
      ["explained", "criticized"],
      "A legal-status characteristic may be treated as analogous in some contexts but not others.",
      "L'Heureux-Dubé J. used Généreux as an example of how a grounds-first framework can make analogousness depend on the desired result.",
    );
    revise(
      "d16", "o2", "A protected ground does not automatically",
      ["explained", "followed", "applied"],
      "Members of socially advantaged groups are generally less vulnerable to discrimination than marginalized groups.",
      "L'Heureux-Dubé J. invoked Schachtschneider by analogy when making social vulnerability relevant to discriminatory impact.",
    );

    revise(
      "d17", "o4", "Section 1 requires a pressing objective",
      ["explained", "followed", "applied"],
      "Section 1 requires a pressing and substantial objective, rational connection, minimal impairment, and proportionality between the measure's effects and its objective.",
      "Iacobucci J. applied the Oakes framework and held that excluding same-sex couples failed proportionality.",
    );
    revise(
      "d18", "o2", "A discriminatory distinction is justified",
      ["explained", "followed", "applied"],
      "Section 1 proportionality includes weighing the discriminatory effects of a measure against its salutary effects.",
      "L'Heureux-Dubé J. applied the Dagenais modification of Oakes when concluding that the exclusion's discriminatory effects outweighed its fiscal benefits.",
    );
    revise(
      "d19", "o2", "A discriminatory distinction is justified",
      ["followed", "applied"],
      "A severe Charter infringement places a heavier justificatory burden on government under section 1.",
      "L'Heureux-Dubé J. applied that principle when weighing the complete exclusion and stigmatizing effect against the claimed savings.",
    );

    revise(
      "d20", "o2", "A protected ground does not automatically",
      ["explained", "followed", "applied"],
      "Categories of discrimination can overlap and should not be reduced to watertight compartments.",
      "L'Heureux-Dubé J. used Mossop to support a direct, context-sensitive inquiry into the affected group's experience.",
    );
    revise(
      "d20", "o2", "The allowance maintains retirement income",
      ["approved", "followed", "applied"],
      "Same-sex relationships cannot be presumed less interdependent than opposite-sex relationships.",
      "L'Heureux-Dubé J. applied her reasoning in Mossop and rejected the stereotype that same-sex couples are less interdependent.",
    );

    revise(
      "d23", "o2", "Budgetary effects ordinarily",
      ["followed", "applied"],
      "Budgetary considerations should not determine whether a Charter infringement is justified and more properly inform the remedy.",
      "L'Heureux-Dubé J. followed Schachter and rejected projected savings as sufficient section 1 justification.",
    ).evidence_spans = [treatmentMatching(record, "d23", "o2", "Budgetary considerations").evidence_spans[0]];
    revise(
      "d23", "o4", "Section 1 requires a pressing objective",
      ["followed", "applied"],
      "Budgetary considerations generally cannot justify a Charter violation under section 1.",
      "Iacobucci J. relied on Schachter to reject speculative program costs as justification for excluding same-sex couples.",
    );

    for (const id of ["d26", "d27"]) {
      revise(
        id, "o3", "Legislatures may address complex inequalities incrementally",
        ["followed", "applied"],
        "A legislature may address a problem incrementally by concentrating first on the sectors it considers most urgent.",
        `Through the McKinney passage he adopted, Sopinka J. relied on ${id === "d26" ? "Edwards Books" : "Williamson"} to support Parliament's staged expansion of the allowance.`,
      );
    }

    revise(
      "d28", "o3", "The 1985 amendment targeted",
      ["explained", "applied"],
      "The 1985 amendment targeted people thought to face the greatest need while concededly leaving other needs unresolved.",
      "Sopinka J. used the trial judge's finding as evidence that Parliament had pursued an evolving, staged response.",
    );
    citedDecision(record, "d28").procedural_relationship.actions = [];

    revise(
      "d32", "o4", "Equality requires a contextual comparison",
      ["explained", "followed", "applied"],
      "Whether a ground is analogous must be assessed in the group's broader social, political, and legal context.",
      "Cory J. cited Swain when assessing sexual orientation against the history and social position of gay and lesbian people.",
    );

    revise(
      "d2", "o2", "Miron and Thibaudeau displayed",
      ["explained"],
      "Miron was one of the recent section 15 decisions whose divergent analytical approach exposed the absence of a shared account of equality's purpose.",
      "L'Heureux-Dubé J. used Miron as one example motivating a renewed, purpose-first equality framework.",
    );
    revise(
      "d11", "o2", "Miron and Thibaudeau displayed",
      ["explained"],
      "Thibaudeau was one of the recent section 15 decisions whose divergent analytical approach exposed the absence of a shared account of equality's purpose.",
      "L'Heureux-Dubé J. used Thibaudeau as one example motivating a renewed, purpose-first equality framework.",
    );
    revise(
      "d3", "o2", "Discrimination turns on the effect",
      ["approved", "followed"],
      "Andrews treated a rule's impact on the affected person, rather than discriminatory intent, as decisive to discrimination.",
      "L'Heureux-Dubé J. adopted Andrews's effects-based principle as the foundation of her section 15 method.",
    );
    revise(
      "d12", "o2", "Discrimination turns on the effect",
      ["explained", "followed", "extended"],
      "Simpsons-Sears held that discrimination under human-rights law depends on impact and requires no discriminatory intent.",
      "L'Heureux-Dubé J. carried the Simpsons-Sears effects principle into her proposed section 15 method.",
    );
    revise(
      "d3", "o4", "Direct discrimination appears",
      ["explained", "followed", "applied"],
      "Andrews adopted the distinction between direct and adverse-effect discrimination for section 15 claims.",
      "Cory J. followed Andrews's adoption of that distinction and classified the opposite-sex definition as direct discrimination.",
    );
    revise(
      "d12", "o4", "Direct discrimination appears",
      ["explained", "followed", "applied"],
      "Direct discrimination appears on a rule's face, while adverse-effect discrimination arises from a facially neutral rule's disproportionate impact on a protected group.",
      "Cory J. followed the distinction stated in Simpsons-Sears and classified the opposite-sex definition as direct discrimination.",
    );
    revise(
      "d3", "o4", "Equal benefit includes state recognition",
      ["followed", "applied"],
      "The impact of a law on the affected individual or group is central to equality analysis.",
      "Cory J. applied Andrews's impact principle and treated denial of recognized couple status as a stigmatic harm independent of economic loss.",
    );
    revise(
      "d30", "o4", "Equal benefit includes state recognition",
      ["explained", "followed", "applied"],
      "State-imposed exclusion can inflict a serious dignitary and stigmatic harm even without measurable economic loss.",
      "Cory J. used Brown by analogy to explain why denial of state recognition to same-sex couples is itself an unequal benefit.",
    );

    revise(
      "d8", "o3", "Courts defer more on socio-economic choices",
      ["followed", "applied"],
      "Courts should not lightly second-guess how quickly a legislature advances equality and may uphold a course that reasonably balances competing social demands.",
      "Sopinka J. followed McKinney when treating Parliament's staged expansion of the allowance as a permissible balance.",
    );
    revise(
      "d29", "o3", "Courts defer more on socio-economic choices",
      ["followed", "applied"],
      "Courts give greater latitude when government mediates among competing groups in socio-economic policy.",
      "Sopinka J. applied Irwin Toy at minimal impairment and declined to second-guess Parliament's limited extension of the allowance.",
    );

    revise(
      "d10", "o4", "The courts below characterized",
      ["explained", "criticized", "not_followed"],
      "The Federal Court of Appeal majority treated eligibility as turning on spousal status and found no sexual-orientation discrimination because same-sex couples were not worse off than other non-spousal households.",
      "Cory J. rejected the appellate majority's framing because the statute expressly defined common-law spouses by opposite sex.",
    );
    revise(
      "d28", "o4", "The courts below characterized",
      ["explained", "criticized", "not_followed"],
      "The trial judge acknowledged a distinction between heterosexual and homosexual couples but characterized it as spouse versus non-spouse rather than sexual orientation.",
      "Cory J. rejected the trial judge's characterization because the statute's opposite-sex definition drew the distinction through sexual orientation.",
    );

    revise(
      "d13", "o2", "The same facial distinction may discriminate",
      ["explained", "followed", "applied"],
      "A sex-based restriction on cross-sex prison searches may discriminate against women without the converse restriction discriminating against men, because the groups' social circumstances differ.",
      "L'Heureux-Dubé J. used Weatherall to show that discriminatory impact depends on the affected group's vulnerability and circumstances.",
    );
    revise(
      "d14", "o2", "The same facial distinction may discriminate",
      ["explained", "followed", "applied"],
      "An offence defined only for women may discriminate against women even though limiting the offence of sexual assault of a minor to men need not discriminate against men.",
      "L'Heureux-Dubé J. used Hess to show that formally parallel distinctions can have different discriminatory effects on differently situated groups.",
    );
    revise(
      "d13", "o4", "A distinction on an enumerated",
      ["explained", "followed", "applied"],
      "Weatherall shows that drawing a distinction on an enumerated ground does not by itself establish discrimination; prejudicial effect remains necessary.",
      "Cory J. followed that qualification but found the stereotype-based exclusion of same-sex couples prejudicial under section 15.",
    );
    revise(
      "d14", "o4", "A distinction on an enumerated",
      ["explained", "followed", "applied"],
      "Hess shows that drawing a distinction on an enumerated ground does not by itself establish discrimination; prejudicial effect remains necessary.",
      "Cory J. followed that qualification but found the stereotype-based exclusion of same-sex couples prejudicial under section 15.",
    );

    revise(
      "d20", "o4", "Same-sex partners can form stable",
      ["approved", "followed", "applied"],
      "The capacity to form loving, caring, stable family bonds is not dependent on heterosexual orientation.",
      "Iacobucci J. adopted the reasoning in Mossop and rejected the premise that same-sex couples are inherently less interdependent.",
    );
    revise(
      "d40", "o4", "Same-sex partners can form stable",
      ["approved", "followed", "applied"],
      "Expert evidence showed a high degree of similarity between same-sex and opposite-sex life partners in their attitudes, expectations, and values.",
      "Iacobucci J. adopted the evidence reported in Knodel when rejecting the factual premise for excluding same-sex couples.",
    );
    revise(
      "d22", "o4", "Discrimination may rest on a protected characteristic",
      ["explained", "followed", "applied"],
      "A distinction based on pregnancy constitutes discrimination based on sex even though the legislation does not name sex as its criterion.",
      "Cory J. applied Brooks by analogy to connect the opposite-sex definition to sexual orientation.",
    );
    revise(
      "d31", "o4", "Discrimination may rest on a protected characteristic",
      ["explained", "followed", "applied"],
      "Sexual harassment constitutes discrimination based on sex even when the rule or conduct does not use sex as an express classification.",
      "Cory J. applied Janzen by analogy to connect the opposite-sex definition to sexual orientation.",
    );

    revise(
      "d23", "o4", "Reading in is an available remedy",
      ["approved", "followed", "applied"],
      "For an underinclusive benefit, a court may strike down the provision, suspend invalidity, or read words in or out to cure only the constitutional inconsistency.",
      "Iacobucci J. followed Schachter's remedial framework, read same-sex couples into the allowance, and suspended the remedy for one year.",
    );
    revise(
      "d34", "o4", "Reading in is an available remedy",
      ["explained", "followed"],
      "Haig read sexual orientation into federal human-rights legislation rather than invalidate the entire scheme.",
      "Iacobucci J. treated Haig as supporting a tailored reading-in remedy for an underinclusive statute.",
    );
    revise(
      "d35", "o4", "Reading in is an available remedy",
      ["explained", "followed"],
      "Vriend read sexual orientation into provincial human-rights legislation rather than invalidate the entire scheme.",
      "Iacobucci J. treated Vriend as supporting a tailored reading-in remedy for an underinclusive statute.",
    );
    revise(
      "d40", "o4", "Reading in is an available remedy",
      ["approved", "followed", "applied"],
      "Knodel read same-sex couples into a statutory definition conferring benefits on spouses because extending the benefit was less intrusive than striking it down.",
      "Iacobucci J. expressly followed Knodel's approach and read same-sex couples into the federal allowance definition.",
    );

    revise(
      "d26", "o3", "A legislature may address a problem incrementally",
      ["followed", "applied"],
      "A legislature regulating a broad field may concentrate reform on sectors with especially urgent concerns or needy constituencies.",
      "Through McKinney, Sopinka J. relied on Edwards Books to support Parliament's staged expansion of the allowance.",
    );
    revise(
      "d27", "o3", "A legislature may address a problem incrementally",
      ["followed", "applied"],
      "A legislature may address the phase of a problem it considers most acute and proceed one step at a time.",
      "Through McKinney, Sopinka J. relied on Williamson to support Parliament's staged expansion of the allowance.",
    );

    revise(
      "d33", "o4", "Sexual orientation is an analogous",
      ["explained", "applied"],
      "Douglas documented exclusion and discrimination experienced by gay and lesbian people in federal public life.",
      "Cory J. used Douglas as evidence of historical disadvantage when holding sexual orientation analogous and the statutory exclusion discriminatory.",
    );
  }

  for (const decision of record.annotation.analysis.cited_decisions) {
    for (const item of decision.treatments) delete item.treatment_id;
  }
  records.push(record);
}

records.sort((left, right) => left.document_id - right.document_id);
await writeFile(target, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
