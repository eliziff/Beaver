import { afterEach, expect, it } from 'vitest';
import type { AuthoritiesProduct, AuthorityOccurrence } from './types';
import { citationSelection, clearCitationMarks, locateCitationUnits, markCitations, unitText, wholeUnit } from './citationDocument';

afterEach(() => { document.body.replaceChildren(); window.getSelection()?.removeAllRanges(); });

it('maps repeated citations to their own body and note, preserving formatting and exact selection offsets', () => {
  const root = document.createElement('div'); root.className = 'docx-view-container';
  root.innerHTML = '<article><p>See <i>Alpha, 2024 SCC 1</i> at para 2.</p><p>See <b>Alpha, 2024 SCC 1</b> at para 2.</p></article>' +
    '<ol class="docx-notes"><li id="docx-note-f-7"><p><a class="docx-note-label">1</a>Alpha, 2024 SCC 1 at para 2; Beta, 2024 SCC 3.</p></li></ol>';
  document.body.append(root);
  const texts = ['See Alpha, 2024 SCC 1 at para 2.', 'See Alpha, 2024 SCC 1 at para 2.', 'Alpha, 2024 SCC 1 at para 2; Beta, 2024 SCC 3.'];
  const units: AuthoritiesProduct['state']['units'] = texts.map((text, i) => ({ id: i === 2 ? 'footnote:7' : `u${i}`, ordinal: i,
    kind: i === 2 ? 'footnote' : 'body', footnoteId: i === 2 ? 1 : null, footnoteRefs: [],
    pageNumbers: [1], text, occurrenceIds: [`o${i}`] }));
  const occurrences = Object.fromEntries(units.map((unit, i) => {
    const start = unit.text.indexOf('Alpha');
    return [`o${i}`, { id: `o${i}`, unitId: unit.id, start, end: unit.text.indexOf('para 2') + 6,
      pinpointSpan: { start: unit.text.indexOf('para 2'), end: unit.text.indexOf('para 2') + 6 },
    } as AuthorityOccurrence];
  }));
  const located = locateCitationUnits(root, units);
  expect(located).toHaveLength(3);
  const before = root.textContent;
  markCitations(located, occurrences);
  expect(root.textContent).toBe(before);
  expect(root.querySelector('b [data-citation-id="o1"]')?.textContent).toBe('Alpha, 2024 SCC 1');
  expect(root.querySelector('.docx-note-label [data-citation-id]')).toBeNull();
  expect(root.querySelector('[data-citation-id="o2"][data-pinpoint]')?.textContent).toBe('para 2');
  const note = root.querySelector('li')!;
  const range = document.createRange();
  range.setStart(note.querySelector('[data-citation-id="o2"]')!.firstChild!, 0);
  range.setEnd(note.lastElementChild!.lastChild!, 7);
  window.getSelection()!.addRange(range);
  const selection = citationSelection(located[2])!;
  expect(texts[2].slice(selection.start, selection.end)).toContain('para 2; Beta');
  clearCitationMarks(root);
  expect(root.textContent).toBe(before);
  expect(root.querySelector('i')?.textContent).toBe('Alpha, 2024 SCC 1');
});

it('moves citation edges by words that keep their brackets, leaving a closing separator optional', () => {
  const text = 'See [Daviault], 2 SCR 63; (ibid).', root = document.createElement('div');
  root.textContent = text; document.body.append(root);
  const unit = { id: 'u', ordinal: 0, kind: 'body', footnoteId: null, footnoteRefs: [], pageNumbers: [1], text, occurrenceIds: [] } as
    AuthoritiesProduct['state']['units'][number];
  const words = unitText(wholeUnit(unit, root)), at = (part: string, after = false) => words.index(text.indexOf(part) + (after ? part.length : 0));
  const ends = (k: number) => { const out = []; for (let j = words.next(k, 'end', 1, 0, words.count); j != null; j = words.next(j, 'end', 1, 0, words.count)) out.push(text.slice(0, words.to(j))); return out; };
  expect(ends(at('See', true)).slice(0, 2)).toEqual(['See [Daviault]', 'See [Daviault],']);
  expect(ends(at('63', true)).slice(0, 3)).toEqual(['See [Daviault], 2 SCR 63;', 'See [Daviault], 2 SCR 63; (ibid)', text]);
  expect(text.slice(words.from(words.next(at('Daviault]'), 'start', -1, 0, words.count)!))).toBe(text.slice(text.indexOf('[')));
  expect(text.slice(0, words.to(words.snap(at('Daviault', true), 'end', 0, words.count)!))).toBe('See [Daviault]');
});
