import { afterEach, expect, it } from 'vitest';
import type { AuthoritiesProduct, AuthorityOccurrence } from './types';
import { citationSelection, clearCitationMarks, locateCitationUnits, markCitations } from './citationDocument';

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
