export type Opcode = ["equal" | "delete" | "insert" | "replace", number, number, number, number];
export function sequenceOpcodes(left: string[], right: string[]): Opcode[];
