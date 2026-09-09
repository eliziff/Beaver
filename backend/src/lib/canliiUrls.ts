import { structureNative } from "./structureNative";

/**
 * Deterministic CanLII case URLs. `A2AJ_CANLII_COURT_ROUTES` is a
 * data port of ALR Quote Verifier's `verifier_core/canlii_urls.py`; URL
 * construction ports `_a2aj_case_link` (reviewed through commit 10f2d1c).
 *
 * CanLII does not redirect near-miss database slugs. Unknown courts therefore
 * abstain instead of deriving a plausible route.
 */
export const A2AJ_CANLII_COURT_ROUTES: Record<string, string> = {
  // Expand only this reviewed inventory; a court prefix is not a route fallback.
  ...Object.fromEntries(Object.entries({
    ab: `ABAER ABCA ABCGYARB ABCI ABCJ ABCPA ABCPSDC ABCPT ABCTIAB ABEAB ABECARB ABELARB
      ABESAB ABESDAB ABGAA ABHRAAT ABKB ABLCB ABLCSAB ABLERB ABLPRT ABLS ABMGB ABOHSAB
      ABOIPC ABPC ABPLAB ABQB ABRECA ABRTDRS ABSEC ABSRA ABSRB ABTSB ABWCAC AHRC ALRB
      CGYSDAB`,
    bc: `BCCA BCCCALAB BCCDS BCCNM BCCPS BCCRT BCCTC BCEAB BCEGBC BCERAT BCEST BCFAC BCFST
      BCHAB BCHPRB BCHRT BCIPC BCLA BCLCRB BCLRB BCORL BCPAAB BCPC BCRB BCREC BCRMB BCSC
      BCSEC BCSFI BCSP BCSRE BCSTAB LSBC`,
    ca: `CACI CACP CACT CALA CAMFDA CART CB CBSC CER CHRT CICC CIRB CIRO CITT CM CMAC CPATA
      EPTC EXCH FCA FOREP FPCA IIROC IRB OHSTC OIC PCC PEC PSDPT PSLREB PSSRB PSST SCC
      SCC-L SCT SOPF SST TATC TCC TMOB VRAB`,
    mb: `MBCA MBCPSDC MBHAB MBHRC MBKB MBLA MBLB MBLS MBPC MBQB MBSEC`,
    nb: `NBAPAB NBBIHRA NBCA NBCPH NBEUB NBFCSC NBFCST NBKB NBLA NBLEB NBLSB NBOMBUD NBPC
      NBQB NBREA NBWCAT`,
    nl: `NLCA NLCP NLCPS NLHRC NLIPC NLLA NLLRB NLLS NLPC NLSC`,
    ns: `NSAWAB NSBS NSCA NSCPS NSERBT NSFC NSHRC NSLA NSLB NSLST NSOHSAP NSOIPC NSPC NSPR
      NSPRB NSSC NSSEC NSSF NSSIRT NSSM NSWCAT`,
    nt: `NTAAT NTCA NTESA NTHRAP NTIPC NTLA NTLLB NTLS NTRO NTSC NTSEC NTTC NTWCAT NTYJC`,
    nu: `NUCA NUCJ NUHRT NUIPC NULA NULS NUSEC NUWCAT YJCN`,
    on: `ONACRB ONAFRAAT ONAGC ONAPE ONARB ONASLPDT ONBCC ONCA ONCAT ONCCB ONCDHO ONCECE
      ONCFSRB ONCICB ONCJ ONCMT ONCNO ONCO ONCONRB ONCPA ONCPC ONCPD ONCPDC ONCPDT ONCPO
      ONCRB ONCSWSSW ONCTCMPAO ONCVO ONDR ONERT ONFSC ONFSCDRS ONFST ONGSB ONHPARB ONHRAP
      ONHRT ONHSARB ONIPC ONLA ONLAT ONLPAT ONLRB ONLST ONLT ONLTB ONMIC ONMLT ONMTDT
      ONNFPPB ONOCT ONOMBUD ONOTDT ONPEHT ONPPRB ONPSDT ONPSGB ONRB ONRC ONRCDSO ONRPDT
      ONSBT ONSC ONSCDC ONSCSM ONSEC ONSET ONST ONTLAB ONWSIAT ONWSIB`,
    pe: `PEIHRC PEIPC PEIRAC PELA PELRB PEPC PESCAD PESCTD`,
    qc: `QCADMAQ QCAGQ QCAMF QCAMP QCCA QCCAI QCCALP QCCDBQ QCCDCCOQ QCCDCHAD QCCDCM QCCDCRIM
      QCCDCSF QCCDDTP QCCDHJ QCCDNQ QCCDOII QCCDOIIA QCCDOIQ QCCDOMV QCCDOOOQ QCCDOPQ
      QCCDOSFQ QCCDOTTDQ QCCDPPQ QCCDRHRI QCCES QCCFP QCCJA QCCLP QCCM QCCMEQ QCCMNQ
      QCCMPMQ QCCMQ QCCNESST QCCPA QCCPTAQ QCCQ QCCRAAAP QCCRT QCCS QCCSE QCCSJ QCCSST
      QCCT QCCTQ QCCVM QCLA QCOACIQ QCOAGBRN QCOAGQ QCOAPQ QCOAQ QCOARQ QCOCHQ QCOCQ
      QCODLQ QCODQ QCOEAQ QCOEQ QCOHDQ QCOIFQ QCOLF QCOOAQ QCOOQ QCOPGQ QCOPIQ QCOPODQ
      QCOPPQ QCOPQ QCOPSQ QCOTIMRO QCOTMQ QCOTPQ QCOTSTCFQ QCOTTIAQ QCOUQ QCRACJ QCRBQ
      QCRDE QCRMAAQ QCTA QCTAA QCTADP QCTAL QCTAQ QCTAT QCTDP QCTMF QCTP QCTT`,
    sk: `SKAC SKATMPA SKCA SKCPPDC SKDC SKFCA SKHRC SKHRT SKIPC SKKB SKLA SKLGB SKLRB SKLSS
      SKMB SKMBR SKMT SKORT SKPC SKPMB SKQB SKREC SKSEC SKSU SKUFC SKWCBAT`,
    yt: `YKCA YKHRC YKSC YKSM YKTC YTLA YTPSLRB YTRTO YTTLRB`,
  }).flatMap(([jurisdiction, courts]) => courts.trim().split(/\s+/u)
    .map((court) => [court, `${jurisdiction}/${court.toLowerCase()}`] as const))),

  // Irregular database slugs are exact values, including their original casing.
  BCWCAT: "bc/bwcwcat",
  FC: "ca/fct",
  // CanLII calls the database ONHRT; the tribunal cites decisions as HRTO.
  HRTO: "on/onhrt",
  NBBR: "nb/NBQB",
  NBSM: "nb/nbs",
  NSLRB: "ns/nsrb",
  NTYDAB: "nt/ntyadab",
  QCCQLC: "qc/qcqlc",
  SKAIA: "sk/skia",
  UKJCPC: "ukjcpc",
};

function resolvedCanliiCaseUrl(
  citations: Array<string | null | undefined>,
  language: "en" | "fr",
  expectedCourt?: string,
) {
  for (const match of structureNative().providerCitationsInText(
    citations.filter(Boolean).join("\n;\n"))) {
    if (match.family !== "neutral" || !match.year || !match.court || !match.number) continue;
    const court = match.court.toUpperCase();
    if (expectedCourt && court !== expectedCourt) continue;
    const route = A2AJ_CANLII_COURT_ROUTES[court];
    if (!route) continue;
    const slugCourt = court === "CANLII" ? "canlii" : match.court.toLowerCase();
    const slug = `${match.year}${slugCourt}${match.number}`;
    return `https://www.canlii.org/${language}/${route}/doc/${match.year}/${slug}/${slug}.html`;
  }
  return null;
}

export function buildCanliiCaseUrl({
  dataset,
  citations,
  language,
}: {
  dataset: string;
  citations: Array<string | null | undefined>;
  language: "en" | "fr";
}) {
  const expectedCourt = dataset.trim().toUpperCase();
  return A2AJ_CANLII_COURT_ROUTES[expectedCourt]
    ? resolvedCanliiCaseUrl(citations, language, expectedCourt)
    : null;
}

export function buildCanliiCaseUrlFromCitation(
  citations: Array<string | null | undefined>,
  language: "en" | "fr" = "en",
) {
  return resolvedCanliiCaseUrl(citations, language);
}

/** Returns only the exact PDF sibling of a canonical CanLII decision page. */
export function buildCanliiPdfUrl(pageUrl: string) {
  try {
    const url = new URL(pageUrl);
    if (url.protocol !== "https:" || url.hostname !== "www.canlii.org" || url.port ||
        url.username || url.password || url.search || url.hash) return null;
    const match = /^\/(?:en|fr)\/(?:[A-Za-z0-9-]+\/){1,2}doc\/(\d{4})\/([a-z0-9-]+)\/\2\.html$/u
      .exec(url.pathname);
    if (!match || !match[2].startsWith(match[1])) return null;
    url.pathname = url.pathname.replace(/\.html$/u, ".pdf");
    return url.href;
  } catch { return null; }
}
