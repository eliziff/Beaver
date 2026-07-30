/**
 * PROVISIONAL, BENCHMARK-TESTED ONLY.
 *
 * Runs fixed whole-answer support probes against real legal-text excerpts.
 * Receipts are written to the OS temp directory; formal runs are archived
 * separately under OpenLegalData AppData. The fixtures are deliberately small
 * and test meaning errors, not benchmark target similarity.
 */
import "../src/lib/loadEnv";

import {
  appendFileSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createBenchmarkEvidence,
  createLegalEvidenceTurnState,
  finalizeLegalEvidenceExperiment,
  legalEvidenceReceiptEvent,
  registerLegalEvidence,
  submitLegalEvidenceAnswer,
  type LegalSourceClass,
} from "../src/lib/chat/legalEvidenceExperiment";

type ExpectedVerdict =
  | "supported"
  | "partially_supported"
  | "unsupported";

type ProbeEvidence = {
  key: string;
  jurisdiction: "CA" | "US";
  sourceClass: LegalSourceClass;
  citation: string;
  spanText: string;
};

type Probe = {
  id: string;
  question: string;
  claim: string;
  evidence: ProbeEvidence[];
  expected: ExpectedVerdict;
  /** Run under this experiment mode; default holistic_check. */
  mode?: "holistic_check" | "tiered_check";
  /**
   * The claim must clear the deterministic verbatim-quote tier: pass with
   * zero model checker calls.
   */
  expectDeterministic?: boolean;
  /** The deterministic tier must NOT clear it: at least one model call. */
  expectEscalation?: boolean;
};

const ALABAMA_NOTICE: ProbeEvidence = {
  key: "ala-notice",
  jurisdiction: "US",
  sourceClass: "legislation",
  citation: "ALA. CODE § 35-9A-421(b)",
  spanText:
    "If rent is unpaid when due, the landlord may deliver a written notice to terminate the lease to the tenant specifying the amount of rent and any late fees owed to remedy the breach and that the rental agreement will terminate upon a date not less than seven business days after receipt of the notice. If the breach is not remedied within the seven business days, the rental agreement shall terminate.",
};

const ALABAMA_PREMISES: ProbeEvidence = {
  key: "ala-premises",
  jurisdiction: "US",
  sourceClass: "legislation",
  citation: "ALA. CODE § 35-9A-141(11)",
  spanText:
    "“premises” means a dwelling unit and the structure of which it is a part and facilities and appurtenances therein and grounds, areas, and facilities held out for the use of tenants generally or whose use is promised by the rental agreement to the tenant;",
};

const COMPETITION_CONFIDENTIALITY: ProbeEvidence = {
  key: "competition-29",
  jurisdiction: "CA",
  sourceClass: "legislation",
  citation: "Competition Act, RSC 1985, c C-34, s. 29",
  spanText:
    "No person who performs or has performed duties or functions in the administration or enforcement of this Act shall communicate or allow to be communicated to any other person except to a Canadian law enforcement agency or for the purposes of the administration or enforcement of this Act specified information obtained under the Act.",
};

const FRANCHISES_BURDEN: ProbeEvidence = {
  key: "franchises-14",
  jurisdiction: "CA",
  sourceClass: "legislation",
  citation: "Franchises Act, SBC 2015, c 35, s. 14",
  spanText:
    "In a proceeding under this Act, the burden of proving an exemption or exclusion from a requirement or provision is on the person claiming the exemption or exclusion.",
};

const TAK_REASONS: ProbeEvidence = {
  key: "tak-4",
  jurisdiction: "CA",
  sourceClass: "case",
  citation: "R. v. T.A.K., 2005 BCCA 293, para. 4",
  spanText:
    "Although it would have been useful if the trial judge had elaborated with reference to the evidence, counsel had just argued the details of the evidence and the applicable law of possession, particularly knowledge and control. It is not a requirement of the law that in reasons for conviction a trial judge demonstrate knowledge of the law applicable to the case or demonstrate that he or she has considered all of the evidence. This was a simple case in which the appellant did not testify in his defence. In the circumstances of this case, the reasons of the judge were sufficient.",
};

const probes: Probe[] = [
  {
    id: "supported-control",
    question:
      "What notice period applies before termination for unpaid Alabama rent?",
    claim:
      "If rent is unpaid when due, the agreement terminates only if the breach is not remedied within seven business days after receipt of the written notice. (ALA. CODE § 35-9A-421(b))",
    evidence: [ALABAMA_NOTICE],
    expected: "supported",
  },
  {
    id: "lost-attribution-and-scope",
    question: "When are reasons for conviction sufficient?",
    claim:
      "R. v. T.A.K. holds that reasons for conviction are always sufficient even when counsel did not address the evidence or applicable law. (2005 BCCA 293, para. 4)",
    evidence: [TAK_REASONS],
    expected: "unsupported",
  },
  {
    id: "omitted-condition",
    question: "When may protected Competition Act information be disclosed?",
    claim:
      "Officials administering the Competition Act may communicate protected information whenever disclosure is convenient. (Competition Act, s. 29)",
    evidence: [COMPETITION_CONFIDENTIALITY],
    expected: "unsupported",
  },
  {
    id: "changed-modality-and-time",
    question: "What does Alabama require after rent becomes due?",
    claim:
      "Alabama law requires a landlord to file an eviction action exactly seven calendar days after rent becomes due. (ALA. CODE § 35-9A-421(b))",
    evidence: [ALABAMA_NOTICE],
    expected: "unsupported",
  },
  {
    id: "unresolved-ambiguity",
    question: "What follows from the notice provision?",
    claim: "It must happen then. (ALA. CODE § 35-9A-421(b))",
    evidence: [ALABAMA_NOTICE],
    expected: "unsupported",
  },
  {
    id: "partial-support",
    question: "What happens after written notice for unpaid rent?",
    claim:
      "Alabama gives a tenant seven business days after receipt of notice to remedy unpaid rent and automatically awards the landlord treble damages. (ALA. CODE § 35-9A-421(b))",
    evidence: [ALABAMA_NOTICE],
    expected: "partially_supported",
  },
  {
    id: "weak-reference",
    question: "Does Alabama regulate residential evictions?",
    claim:
      "Alabama has a statutory framework governing residential evictions. (ALA. CODE § 35-9A-141(11))",
    evidence: [ALABAMA_PREMISES],
    expected: "unsupported",
  },
  {
    id: "wrong-source",
    question: "Does section 14 create a 14-day franchise rescission period?",
    claim:
      "Section 14 creates a 14-day cooling-off period for franchisees. (Franchises Act, s. 14)",
    evidence: [FRANCHISES_BURDEN],
    expected: "unsupported",
  },
  {
    id: "citation-joint",
    question:
      "What notice period applies before termination for unpaid Alabama rent?",
    claim:
      "If rent is unpaid when due, the tenant has seven business days after receiving notice to remedy the breach. (ALA. CODE § 35-9A-421(b))",
    evidence: [ALABAMA_NOTICE, COMPETITION_CONFIDENTIALITY],
    expected: "supported",
  },
  {
    id: "citation-correct-only",
    question:
      "What notice period applies before termination for unpaid Alabama rent?",
    claim:
      "If rent is unpaid when due, the tenant has seven business days after receiving notice to remedy the breach. (ALA. CODE § 35-9A-421(b))",
    evidence: [ALABAMA_NOTICE],
    expected: "supported",
  },
  {
    id: "citation-irrelevant-only",
    question:
      "What notice period applies before termination for unpaid Alabama rent?",
    claim:
      "If rent is unpaid when due, the tenant has seven business days after receiving notice to remedy the breach. (ALA. CODE § 35-9A-421(b))",
    evidence: [COMPETITION_CONFIDENTIALITY],
    expected: "unsupported",
  },
  {
    id: "deterministic-pure-quote",
    question:
      "What notice period applies before termination for unpaid Alabama rent?",
    claim:
      "“If rent is unpaid when due, the landlord may deliver a written notice to terminate the lease to the tenant specifying the amount of rent and any late fees owed to remedy the breach and that the rental agreement will terminate upon a date not less than seven business days after receipt of the notice.” (ALA. CODE § 35-9A-421(b))",
    evidence: [ALABAMA_NOTICE],
    expected: "supported",
    mode: "tiered_check",
    expectDeterministic: true,
  },
  {
    id: "deterministic-mutated-quote",
    question:
      "What notice period applies before termination for unpaid Alabama rent?",
    claim:
      "“If rent is unpaid when due, the landlord may deliver a written notice to terminate the lease to the tenant specifying the amount of rent and any late fees owed to remedy the breach and that the rental agreement will terminate upon a date not less than seven calendar days after receipt of the notice.” (ALA. CODE § 35-9A-421(b))",
    evidence: [ALABAMA_NOTICE],
    expected: "unsupported",
    mode: "tiered_check",
    expectEscalation: true,
  },
  {
    id: "deterministic-spliced-prose",
    question: "When may protected Competition Act information be disclosed?",
    claim:
      "Because officials “shall communicate or allow to be communicated to any other person” whatever they consider useful, disclosure is discretionary. (Competition Act, s. 29)",
    evidence: [COMPETITION_CONFIDENTIALITY],
    expected: "unsupported",
    mode: "tiered_check",
    expectEscalation: true,
  },
];

function flag(name: string, fallback: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function runProbe(
  probe: Probe,
  model: string,
  effort: string,
  timeoutMs: number,
) {
  const started = Date.now();
  const state = createLegalEvidenceTurnState(probe.mode ?? "holistic_check");
  const receipts = probe.evidence.map((source) =>
    createBenchmarkEvidence({
      stableSourceId: `probe:${source.key}`,
      sourceText: source.spanText,
      spanText: source.spanText,
      citation: source.citation,
      dataset: "Beaver/legal-grounding-probes",
      locatorKind:
        source.sourceClass === "case" ? "paragraph" : "section",
      locatorLabel: source.citation,
      jurisdiction: source.jurisdiction,
      sourceClass: source.sourceClass,
    }),
  );
  receipts.forEach((receipt) => registerLegalEvidence(state, receipt));
  const submitted = submitLegalEvidenceAnswer(
    {
      claims: [
        {
          text: probe.claim,
          evidence_ids: receipts.map((receipt) => receipt.evidence_id),
        },
      ],
    },
    state,
  );
  if (!submitted.ok)
    throw new Error(submitted.errors?.join("; ") || "submission failed");
  const result = await finalizeLegalEvidenceExperiment({
    state,
    model,
    draft: "",
    requestContext: probe.question,
    reasoningEffort: effort,
    abortSignal: AbortSignal.timeout(timeoutMs),
  });
  const passed = Boolean(result.passed);
  const matches = probe.expectDeterministic
    ? passed && result.modelCalls === 0
    : probe.expectEscalation
      ? result.modelCalls >= 1 &&
        (probe.expected === "supported") === passed
      : state.holisticVerdict === probe.expected;
  return {
    schema_version: 1,
    probe_id: probe.id,
    mode: probe.mode ?? "holistic_check",
    model,
    effort,
    expected: probe.expected,
    verdict: state.holisticVerdict,
    passed,
    matches,
    latency_ms: Date.now() - started,
    model_calls: result.modelCalls,
    usage: result.usage,
    diagnostic: result.diagnostic,
    receipt: legalEvidenceReceiptEvent(state),
  };
}

async function main() {
  const models = flag(
    "models",
    "codex:gpt-5.6-sol,claude-p:claude-sonnet-4-6",
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const effort = flag("effort", "low");
  const timeoutMs = Number(flag("timeout-ms", "90000"));
  const output = flag(
    "output",
    path.join(
      os.tmpdir(),
      "beaver-legal-grounding",
      "stage3-verifier-probes.jsonl",
    ),
  );
  const concurrency = Number(flag("concurrency", "4"));
  const perModel = Number(flag("per-model-concurrency", "2"));
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, "", "utf8");
  const rows: Awaited<ReturnType<typeof runProbe>>[] = [];
  const cells = models.flatMap((model) =>
    probes.map((probe) => ({ model, probe })),
  );
  // Bounded pool, per-model lane cap: cells are independent; concurrency
  // changes wall-clock only, and the overload-prone provider stays at a
  // low cap so parallelism does not manufacture transport errors.
  const pending = [...cells];
  const active = new Map<string, number>();
  let running = 0;
  await new Promise<void>((resolve) => {
    const pump = () => {
      if (!pending.length && running === 0) return resolve();
      for (let index = 0; index < pending.length && running < concurrency; ) {
        const cell = pending[index];
        if ((active.get(cell.model) ?? 0) >= perModel) {
          index += 1;
          continue;
        }
        pending.splice(index, 1);
        active.set(cell.model, (active.get(cell.model) ?? 0) + 1);
        running += 1;
        void (async () => {
          const { model, probe } = cell;
          const started = Date.now();
          try {
            const row = await runProbe(probe, model, effort, timeoutMs);
            rows.push(row);
            appendFileSync(output, `${JSON.stringify(row)}\n`, "utf8");
            console.log(
              `${model} | ${probe.id} | ${row.verdict} | ${row.matches ? "match" : "FAIL"} | ${(row.latency_ms / 1_000).toFixed(1)}s`,
            );
          } catch (error) {
            const row = {
              schema_version: 1,
              probe_id: probe.id,
              mode: probe.mode ?? "holistic_check",
              model,
              effort,
              expected: probe.expected,
              verdict: null,
              passed: false,
              matches: false,
              latency_ms: Date.now() - started,
              model_calls: 0,
              usage: null,
              diagnostic: null,
              receipt: null,
              error: error instanceof Error ? error.message : String(error),
            };
            appendFileSync(output, `${JSON.stringify(row)}\n`, "utf8");
            console.log(`${model} | ${probe.id} | ERROR | ${row.error}`);
          } finally {
            active.set(cell.model, active.get(cell.model)! - 1);
            running -= 1;
            pump();
          }
        })();
      }
    };
    pump();
  });

  for (const model of models) {
    const byId = new Map(
      rows
        .filter((row) => row.model === model)
        .map((row) => [row.probe_id, row.verdict]),
    );
    const unnecessaryCitationDetected =
      byId.get("citation-joint") === "supported" &&
      byId.get("citation-correct-only") === "supported" &&
      byId.get("citation-irrelevant-only") !== "supported";
    console.log(
      `${model} | ALCE leave-one-out necessity | ${unnecessaryCitationDetected ? "match" : "FAIL"}`,
    );
  }
  console.log(`private receipts: ${output}`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
