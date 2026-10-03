import type { AuthoritiesAction, AuthoritiesProduct, AuthorityOccurrence } from './types';

type State = AuthoritiesProduct['state'];
const overlap = (a: { start: number; end: number }, b: { start: number; end: number }) =>
  Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

/** An edit as the reviewer asked for it, shown while the save that makes it durable runs: the
 * citation's new range, removal or authority, an output choice, or a statute's excerpt or whole. The saved draft then replaces
 * this view with what the parser makes of the text, its pinpoint included. Other actions have no
 * preview. */
export function previewEdit(product: AuthoritiesProduct, action: AuthoritiesAction): AuthoritiesProduct | null {
  const state = product.state, occurrences = { ...state.occurrences };
  // An output choice shows as soon as it is made; a change of source handling also clears
  // gathered sources, so it waits for its save.
  if (action.type === 'set-settings' && action.settings.sourceMode === undefined)
    return { ...product, state: { ...state, settings: { ...state.settings, ...action.settings } } };
  if (action.type === 'set-document-output') return { ...product, state: { ...state, insertIntoDocument: action.enabled } };
  if (action.type === 'set-output-mode') return { ...product, state: { ...state, outputMode: action.outputMode } };
  if (action.type === 'set-authority-excerpt') {
    const authority = state.authorities[action.authorityId];
    return authority ? { ...product, state: { ...state, authorities: { ...state.authorities,
      [authority.id]: { ...authority, excerpt: action.excerpt } } } } : null;
  }
  const item = 'occurrenceId' in action ? occurrences[action.occurrenceId] : undefined;
  const unitId = action.type === 'add-occurrence' ? action.unitId : action.type === 'restore-occurrence'
    ? state.dismissedOccurrences?.[action.occurrenceId]?.occurrence.unitId : item?.unitId;
  const unit = state.units.find(({ id }) => id === unitId);
  if (!unit || action.type !== 'add-occurrence' && action.type !== 'restore-occurrence' && !item) return null;
  let ids = [...unit.occurrenceIds], dismissed = state.dismissedOccurrences;
  /** A citation over [start, end) trimmed of space, keeping the pinpoints `base` had wherever they
   * lie: the save parses the text again, and only pinpoints the new range writes replace them. */
  const cite = (start: number, end: number, base?: AuthorityOccurrence): AuthorityOccurrence => {
    while (start < end && /\s/u.test(unit.text[start])) start++;
    while (end > start && /\s/u.test(unit.text[end - 1])) end--;
    const span = { start, end, text: unit.text.slice(start, end) };
    return { kind: 'other', citation: span.text, authorityId: null, reference: null, evidenceIds: [], reviewed: true,
      sourceTextSha256: ids.map(id => occurrences[id]?.sourceTextSha256).find(Boolean) ?? '', pinpointSpan: null,
      pinpoints: [], ...base, id: base?.id ?? `${unit.id}:manual:${start}:${end}`, unitId: unit.id, ...span,
      localOrdinal: start, authoritySpan: span, coreSpan: span };
  };
  const put = (...items: AuthorityOccurrence[]) => items.forEach(next => { occurrences[next.id] = next; ids.push(next.id); });
  const drop = (...gone: string[]) => { gone.forEach(id => delete occurrences[id]); ids = ids.filter(id => !gone.includes(id)); };
  switch (action.type) {
    case 'add-occurrence': put(cite(action.start, action.end)); break;
    case 'set-citation-range': {
      const next = cite(action.start, action.end, item);
      // Citations inside the new range join it; one it overlaps keeps the text outside.
      for (const id of ids) {
        const other = occurrences[id];
        if (id === item!.id || !other || !overlap(other, next)) continue;
        drop(id);
        for (const [start, end] of [[other.start, next.start], [next.end, other.end]])
          if (start < end && unit.text.slice(start, end).trim()) put(cite(start, end, { ...other, id: `${other.id}:${start}` }));
      }
      occurrences[next.id] = next; break;
    }
    case 'remove-occurrence':
      drop(item!.id); dismissed = { ...dismissed, [item!.id]: { occurrence: item!, authority: null } }; break;
    case 'restore-occurrence': {
      const saved = dismissed?.[action.occurrenceId];
      if (!saved) return null;
      put(saved.occurrence); dismissed = { ...dismissed }; delete dismissed[action.occurrenceId]; break;
    }
    // Every pinpoint edit shows at once. One added shows its value as written, and its kind once the
    // save has read it from the words before it.
    case 'set-pinpoints': {
      const known = action.pinpoints.map(({ start, end, kind }) => {
        const pin = item!.pinpoints.find(other => other.start === start && other.end === end);
        return pin ? { ...pin, kind: kind ?? pin.kind } : { kind: kind ?? '', text: unit.text.slice(start, end), start, end };
      }).sort((left, right) => left.start! - right.start!);
      const span = known.length ? { start: known[0].start!, end: known.at(-1)!.end! } : null;
      occurrences[item!.id] = { ...item!, pinpoints: known, pinpointManual: true,
        pinpointSpan: span && { ...span, text: unit.text.slice(span.start, span.end) } };
      break;
    }
    case 'set-reference':
      occurrences[item!.id] = { ...item!, kind: 'reference', reference: action.reference,
        authorityId: action.reference?.targetAuthorityId ?? null };
      break;
    default: return null;
  }
  ids.sort((a, b) => occurrences[a].start - occurrences[b].start);
  const units = state.units.map(other => other === unit ? { ...unit, occurrenceIds: ids } : other);
  return { ...product, state: { ...state, units, occurrences, dismissedOccurrences: dismissed } as State };
}

type Pin = AuthorityOccurrence['pinpoints'][number] & { start: number; end: number };
/** A citation's pinpoints where its unit writes them, in or out of its range. One saved before
 * pinpoints kept their place takes the place of the pinpoint as written. */
export function placedPins(item: AuthorityOccurrence): Pin[] {
  return item.pinpoints.flatMap(pin => {
    if (pin.start !== undefined && pin.end !== undefined) return [pin as Pin];
    const span = item.pinpointSpan, at = span ? item.pinpoints.length === 1 ? 0 : span.text.indexOf(pin.text) : -1;
    return span && at >= 0 ? [{ ...pin, start: span.start + at, end: item.pinpoints.length === 1 ? span.end
      : span.start + at + pin.text.length }] : [];
  });
}
type PinpointEdit = Extract<AuthoritiesAction, { type: 'set-pinpoints' }>['pinpoints'];
/** Pinpoints as an edit sends them: a kind not yet read is left for the save to read. */
export const pinpointEdit = (pins: Pin[]): PinpointEdit =>
  pins.map(({ start, end, kind }) => ({ start, end, ...(kind && { kind: kind as PinpointEdit[number]['kind'] }) }));

/** A review edit as Ctrl+Z takes it back and Ctrl+Y makes it again: each a list of actions, the
 * citation it was about, and the one selected when it was made. */
export type ReviewStep = { undo: AuthoritiesAction[]; redo: AuthoritiesAction[]; target: string; from?: string };
/** The step that takes an edit back, from the review before and after it: the prior value of what
 * it changed. A range that took in or cut a neighbour gives the neighbour its range back. */
export function reviewStep(before: AuthoritiesProduct, after: AuthoritiesProduct, action: AuthoritiesAction): ReviewStep | null {
  const was = 'occurrenceId' in action ? before.state.occurrences[action.occurrenceId] : undefined;
  const occurrenceId = 'occurrenceId' in action ? action.occurrenceId : '';
  const step = (undo: AuthoritiesAction[], target = occurrenceId) => ({ undo, redo: [action], target });
  switch (action.type) {
    case 'remove-occurrence': return step([{ type: 'restore-occurrence', occurrenceId }]);
    case 'restore-occurrence': return step([{ type: 'remove-occurrence', occurrenceId }]);
    case 'add-occurrence': {
      const id = after.state.units.find(({ id }) => id === action.unitId)?.occurrenceIds.find(id => !before.state.occurrences[id]);
      return id ? { undo: [{ type: 'remove-occurrence', occurrenceId: id }], redo: [{ type: 'restore-occurrence', occurrenceId: id }], target: id } : null;
    }
    case 'set-pinpoints': return was ? step([{ type: 'set-pinpoints', occurrenceId, pinpoints: pinpointEdit(placedPins(was)) }]) : null;
    case 'set-reference': return was ? step([{ type: 'set-reference', occurrenceId, reference: was.reference }]) : null;
    case 'set-citation-range': {
      const unit = was && before.state.units.find(({ id }) => id === was.unitId);
      if (!was || !unit) return null;
      const pieces = after.state.units.find(({ id }) => id === unit.id)!.occurrenceIds.filter(id => !before.state.occurrences[id])
        .map(id => after.state.occurrences[id]);
      return step([{ type: 'set-citation-range', occurrenceId, start: was.start, end: was.end },
        ...unit.occurrenceIds.flatMap((id): AuthoritiesAction[] => {
          const other = before.state.occurrences[id];
          if (id === occurrenceId || !other || after.state.occurrences[id]) return [];
          const piece = pieces.find(item => overlap(item, other));
          return [piece ? { type: 'set-citation-range', occurrenceId: piece.id, start: other.start, end: other.end }
            : { type: 'add-occurrence', unitId: unit.id, start: other.start, end: other.end }];
        }),
        { type: 'set-pinpoints', occurrenceId, pinpoints: pinpointEdit(placedPins(was)) }]);
    }
    default: return null;
  }
}

/** What each citation of a preview became in the saved draft: the saved citation in the same unit
 * that covers most of it, for every preview citation the save named differently. */
export function savedIds(preview: AuthoritiesProduct, saved: AuthoritiesProduct) {
  const names = new Map<string, string>();
  for (const unit of preview.state.units) {
    const after = saved.state.units.find(({ id }) => id === unit.id);
    if (!after || after.occurrenceIds === unit.occurrenceIds) continue;
    const fresh = after.occurrenceIds.map(id => saved.state.occurrences[id]).filter(item => item && !preview.state.occurrences[item.id]);
    for (const id of unit.occurrenceIds) {
      const item = preview.state.occurrences[id];
      if (!item || saved.state.occurrences[id]) continue;
      const best = fresh.reduce<AuthorityOccurrence | undefined>((top, next) =>
        overlap(next, item) > (top ? overlap(top, item) : 0) ? next : top, undefined);
      if (best) names.set(id, best.id);
    }
  }
  return names;
}
