export type CourtRecordWorkProductOutput = {
  kind: "court-record" | "authorities";
  profileId?: string;
  role: string;
};

export type CourtRecordWorkProductSlot = {
  acceptedWorkProductOutputs?: readonly CourtRecordWorkProductOutput[];
};

export function matchesWorkProductRole(role: string, family: string): boolean;
export function acceptsWorkProductOutput(slot: CourtRecordWorkProductSlot,
  source: CourtRecordWorkProductOutput): boolean;
