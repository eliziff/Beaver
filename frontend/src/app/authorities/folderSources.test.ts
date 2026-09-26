import { expect, it } from 'vitest';
import { createAuthoritiesDraft } from '../../../../backend/src/lib/authoritiesDomain';
import { folderMatches } from './folderSources';
it('matches resolved aliases and repeated downloads, and abstains on ambiguous filenames', () => {
  const draft = createAuthoritiesDraft({ kind: 'manual' });
  draft.authorities.one = { id: 'one', key: 'one', kind: 'case', citation: '[1991] 3 S.C.R. 326',
    name: 'Swain', displayName: null, evidenceIds: [], locators: [], sourceIdentity: null,
    excluded: false, source: { kind: 'pending-canlii', authorityKey: 'one',
      pageUrl: 'https://www.canlii.org/en/ca/scc/doc/1991/1991canlii104/1991canlii104.html',
      pdfUrl: 'https://www.canlii.org/en/ca/scc/doc/1991/1991canlii104/1991canlii104.pdf' } };
  const first = new File(['pdf'], '1991canlii104.pdf', { lastModified: 1 });
  const newest = new File(['pdf'], '1991canlii104 (1).pdf', { lastModified: 2 });
  expect(folderMatches(draft, [first, newest]).map(({ file }) => file)).toEqual([newest]);
  draft.authorities.one.citation = '1991 CanLII 104 (SCC)';
  draft.authorities.one.source = { kind: 'unresolved' };
  expect(folderMatches(draft, [first])).toHaveLength(1);
  draft.authorities.two = { ...draft.authorities.one, id: 'two', key: 'two' };
  expect(folderMatches(draft, [first])).toEqual([]);
  draft.authorities.two.excluded = true;
  expect(folderMatches(draft, [first])).toHaveLength(1);
});
