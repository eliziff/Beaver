import { FileStack } from "lucide-react";
import type { CourtProfile, CoverValues } from "./types";
import { contactGroups, coverPartyGroups, filingParty, groupNames, partyNames } from "./types";

export function CourtCoverPreview({ profile, cover }: {
  profile: CourtProfile;
  cover: CoverValues;
}) {
  if (!profile.cover.generated) {
    return (
      <div aria-hidden="true" className="flex aspect-[8.5/11] h-full max-w-full flex-col justify-between border border-black/15 bg-white px-6 py-7 text-left shadow-[0_8px_24px_rgba(0,0,0,.12)]">
        <div>
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-red-50 text-red-700"><FileStack className="h-4 w-4" /></span>
          <p className="mt-5 text-[8px] font-semibold uppercase tracking-[0.08em] text-gray-500">{cover.courtName || profile.court}</p>
          <p className="mt-1 font-serif text-base font-bold leading-tight text-gray-950">{profile.shortLabel}</p>
        </div>
        <div className="border-t border-gray-300 pt-3 text-[8px] leading-4 text-gray-700">
          <p>{cover.courtFileNumber || "Court file number"}</p>
          <p className="font-semibold">{filingParty(profile, cover)?.party.name || "Filing party"}</p>
        </div>
      </div>
    );
  }
  const className = "relative aspect-[8.5/11] h-full max-w-full overflow-hidden border border-black/15 px-5 py-6 text-center shadow-[0_8px_24px_rgba(0,0,0,.12)]";
  const style = { backgroundColor: profile.cover.colourHex, color: profile.cover.textColourHex ?? "#111827" };
  if (profile.cover.template === "abca-ap5") return <AbcaCover className={className} style={style} profile={profile} cover={cover} />;
  if (profile.cover.template === "federal-record") return <FederalCover className={className} style={style} profile={profile} cover={cover} />;
  return <GenericCover className={className} style={style} profile={profile} cover={cover} />;
}

type PreviewProps = {
  className: string;
  style: { backgroundColor: string; color: string };
  profile: CourtProfile;
  cover: CoverValues;
};

function AbcaCover({ className, style, profile, cover }: PreviewProps) {
  const groups = coverPartyGroups(profile, cover);
  const rows: Array<[string, string | undefined]> = [
    ["COURT OF APPEAL FILE NUMBER:", cover.courtFileNumber],
    ["TRIAL COURT FILE NUMBER:", cover.lowerCourtFileNumber],
    ["REGISTRY OFFICE:", cover.registry],
    ...groups.flatMap((group): Array<[string, string | undefined]> => [
      [`${group.roleBelow || group.role}:`, partyNames(group)],
      ["STATUS ON APPEAL:", group.role],
    ]),
    ["DOCUMENT:", cover.recordTitle || profile.cover.title],
  ];
  const [filing, others] = contactGroups(profile, cover);
  return (
    <div aria-hidden="true" className={`${className} font-sans`} style={style}>
      <p className="absolute right-5 top-3 text-[10px]">1</p>
      <p className="mt-2 text-[8px] font-bold uppercase">Court of Appeal of Alberta</p>
      <div className="absolute right-5 top-14 text-left text-[6px] font-bold leading-3">
        <p>{profile.cover.form ?? "Form AP-5"}</p><p>[{profile.cover.ruleReference ?? "Rule 14.87"}]</p>
        <div className="mt-1 h-14 w-16 border border-black/50 bg-white pt-1 text-center font-normal">Registrar&apos;s Stamp</div>
      </div>
      <div className="mt-8 grid grid-cols-[7.8rem_1fr] gap-y-1.5 text-left text-[6px] leading-3">
        {rows.map(([label, value], index) => <div key={`${label}-${index}`} className="contents"><span>{label.toUpperCase()}</span><span className={label === "DOCUMENT:" ? "font-bold" : "whitespace-pre-line"}>{value || "________"}</span></div>)}
      </div>
      <div className="mt-2 border-y border-current/70 py-2 text-[7px] leading-3">
        <p>Appeal from the Decision of</p><p>{cover.decisionMaker || "________________"}</p>
        <p>{cover.decisionDate ? `Dated ${cover.decisionDate}` : "Dated __________________"}</p>
        <p>{cover.decisionFileDate ? `Filed ${cover.decisionFileDate}` : "Filed __________________"}</p>
      </div>
      <p className="border-b border-current/70 py-2 text-[8px] font-bold">{profile.cover.title}</p>
      <div className="grid grid-cols-2 gap-4 pt-2 text-left text-[6px] leading-3">
        <p className="whitespace-pre-line">Lawyer for {groupNames(filing) || "filing party"}<br />{cover.counselName || "Name"}<br />{cover.counselAddress || "Address"}<br />{cover.counselPhone || "Phone"}<br />{cover.counselFax || "Fax"}<br />{cover.counselEmail || "Email"}</p>
        <p className="whitespace-pre-line">Lawyer for {groupNames(...others) || "other parties"}<br />{cover.otherCounselName || "Name"}<br />{cover.otherCounselAddress || "Address"}<br />{cover.otherCounselPhone || "Phone"}<br />{cover.otherCounselFax || "Fax"}<br />{cover.otherCounselEmail || "Email"}</p>
      </div>
    </div>
  );
}

function FederalCover({ className, style, profile, cover }: PreviewProps) {
  const groups = coverPartyGroups(profile, cover);
  const [filing, others] = contactGroups(profile, cover);
  return (
    <div aria-hidden="true" className={`${className} font-serif`} style={style}>
      <p className="text-right text-[7px]">Court File No. {cover.courtFileNumber || "________"}</p>
      <p className="mt-3 text-[8px] font-bold uppercase">{profile.court}</p>
      <div className="mt-4 text-left text-[7px] leading-4">
        <p>BETWEEN:</p>
        {groups.map((group, index) => (
          <div key={group.id}>
            {index > 0 && <p className="text-center">and</p>}
            <p className="whitespace-pre-line text-center">{partyNames(group) || group.role}</p>
            <p className="text-right">{group.role}</p>
          </div>
        ))}
      </div>
      <div className="mt-3 border-y border-current/70 py-3">
        <p className="text-[9px] font-bold leading-tight">{profile.cover.title}</p>
        {cover.recordSubtitle && <p className="mt-1 text-[7px] font-bold">{cover.recordSubtitle}</p>}
        {cover.hearingDate && <p className="mt-1 text-[7px] font-bold">Hearing date: {cover.hearingDate}</p>}
      </div>
      <div className="grid grid-cols-2 gap-4 pt-3 text-left text-[6px] leading-3">
        <p className="whitespace-pre-line font-bold">{groupNames(filing) || "Filing party"}<br /><span className="font-normal">{filing?.role}<br />{cover.counselName || "Lawyer"}<br />{cover.counselAddress || "Address for service"}</span></p>
        <p className="whitespace-pre-line font-bold">{groupNames(...others) || "Other parties"}<br /><span className="font-normal">{others.map((group) => group.role).join(" / ")}<br />{cover.otherCounselName || "Lawyer"}<br />{cover.otherCounselAddress || "Address for service"}</span></p>
      </div>
    </div>
  );
}

function GenericCover({ className, style, profile, cover }: PreviewProps) {
  const groups = coverPartyGroups(profile, cover);
  return (
    <div aria-hidden="true" className={className} style={style}>
      <p className="border-b border-current/70 pb-3 text-[8px] font-bold uppercase">{cover.courtName || profile.court}</p>
      <div className="mt-8 text-[7px] leading-4">
        {groups.map((group, index) => (
          <div key={group.id}>
            {index > 0 && <p>and</p>}
            <p className="whitespace-pre-line font-semibold">{partyNames(group) || group.role}</p>
            <p>{group.role}</p>
          </div>
        ))}
      </div>
      <p className="mt-8 font-serif text-base font-bold uppercase">{cover.recordTitle || profile.cover.title}</p>
      <div className="absolute inset-x-5 bottom-5 text-left text-[7px] leading-4">
        <p>{cover.courtFileNumber || "Court file number"}</p>
        <p className="font-semibold">{filingParty(profile, cover)?.party.name || "Filing party"}</p>
      </div>
    </div>
  );
}
