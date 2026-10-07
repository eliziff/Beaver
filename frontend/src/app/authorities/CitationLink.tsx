// A link an editor gives one citation, in the citation review's bar (an app's choice: AuthoritiesApp.citationLinks):
// typed here, then offered to the other citations of the same authority without a link of their own (the runtime's
// "link-propagation", each at its own pinpoint), confirmed, and saved with "set-occurrence-links".
import { useState } from 'react';
import { Modal } from '@/app/components/modals/Modal';
import { authoritiesOperation } from './runtimeClient';
import type { AuthoritiesAction, AuthoritiesProduct, AuthorityOccurrence } from './types';

type Target = { occurrenceId: string; footnote: number | null; form: string; url: string };
const webAddress = (value: string) => /^https?:\/\/[^\s/]+\S*$/iu.test(value);
const listed = (targets: Target[]) => {
  const names = targets.map(({ footnote, form }) => `${footnote ?? 'the text'}${form === 'full' ? '' : ` (${form})`}`);
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
};

export function CitationLink({ product, occurrence, busy, onAction }: { product: AuthoritiesProduct;
  occurrence?: AuthorityOccurrence; busy: boolean; onAction(action: AuthoritiesAction): void }) {
  const own = occurrence?.link ?? '';
  // What is typed, for the citation it was typed for; another citation shows its own link.
  const [typed, setTyped] = useState<{ id: string; url: string }>();
  const [asking, setAsking] = useState<{ origin: string; url: string; targets: Target[] }>();
  const [working, setWorking] = useState(false), [error, setError] = useState('');
  const url = (typed && typed.id === occurrence?.id ? typed.url : own).trim();
  const removing = !url && !!own;
  const save = (origin: string, value: string | null, targets: Target[] = []) => {
    onAction({ type: 'set-occurrence-links', links: [{ occurrenceId: origin, url: value },
      ...targets.map(({ occurrenceId, url: target }) => ({ occurrenceId, url: target }))] });
    setTyped(undefined);
  };
  async function add() {
    if (!occurrence) return;
    setError('');
    if (removing) { save(occurrence.id, null); return; }
    setWorking(true);
    try {
      const { data } = await authoritiesOperation('link-propagation', { draft: product.state, occurrenceId: occurrence.id, url });
      const targets = data as Target[];
      if (targets.length) setAsking({ origin: occurrence.id, url, targets });
      else save(occurrence.id, url);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'The link could not be added.'); }
    finally { setWorking(false); }
  }
  return <div className="citation-link">
    <input type="url" value={typed && typed.id === occurrence?.id ? typed.url : own} placeholder="https://" spellCheck={false}
      aria-label="Link for this citation" disabled={!occurrence || busy || working}
      title={error || undefined} aria-invalid={error ? true : undefined}
      onChange={(event) => occurrence && setTyped({ id: occurrence.id, url: event.target.value })}
      onKeyDown={(event) => { if (event.key === 'Enter' && (removing || webAddress(url) && url !== own)) { event.preventDefault(); void add(); } }} />
    <button type="button" disabled={!occurrence || busy || working || !(removing || webAddress(url) && url !== own)}
      onClick={() => void add()}>{removing ? 'Remove link' : 'Add link'}</button>
    {asking && <Modal open onClose={() => setAsking(undefined)} breadcrumbs={['Add link']} size="md"
      secondaryAction={{ label: 'Only this citation', onClick: () => { const { origin, url: value } = asking; setAsking(undefined); save(origin, value); } }}
      primaryAction={{ label: `Add to ${asking.targets.length} more`, onClick: () => { const { origin, url: value, targets } = asking; setAsking(undefined); save(origin, value, targets); } }}>
      <p className="pb-4 text-sm text-gray-800">Add this link to footnote{asking.targets.length === 1 ? '' : 's'} {listed(asking.targets)} too? They cite the same authority and have no link of their own. Each takes the link at its own pinpoint.</p>
    </Modal>}
  </div>;
}
