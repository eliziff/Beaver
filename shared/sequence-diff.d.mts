export type Opcode = ["equal" | "delete" | "insert" | "replace", number, number, number, number];
export function sequenceOpcodes(left: string[], right: string[]): Opcode[];
export type MinimalEdit = [start: number, length: number, replacement: string];
export function minimalEditPlan(t: string, s: string, base?: number, spanLength?: number): MinimalEdit[];
export function descendingPlan(plan: MinimalEdit[]): MinimalEdit[];
export type HighlightRun = [start: number, end: number, edited: boolean];
export function highlightRuns(t: string, plan: MinimalEdit[], base?: number): HighlightRun[];
export function characterPlan(t: string, s: string): MinimalEdit[];
