export type Opcode = ["equal" | "delete" | "insert" | "replace", number, number, number, number];
export function sequenceOpcodes(left: string[], right: string[]): Opcode[];
export type MinimalEdit = [start: number, length: number, replacement: string];
export function minimalEditPlan(t: string, s: string, base?: number, spanLength?: number): MinimalEdit[];
