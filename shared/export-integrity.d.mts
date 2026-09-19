export type SigningIdentity = { algorithm: "ed25519"; key_id: string; public_key: string };
export type ExportIntegrity = { algorithm: "sha256"; payload_sha256: string;
  signature: (SigningIdentity & { value: string }) | null };
export function exportSigningIdentity(seed?: string): SigningIdentity | null;
export function sealExport<T extends Record<string, unknown>>(body: T, seed?: string): T & { integrity: ExportIntegrity };
export function verifyExport(envelope: unknown, trustedPublicKey?: string): { signed: boolean; trusted: boolean };
