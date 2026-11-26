import type { CaseFile } from '../../../shared/types';
import { ROLES } from '../../../shared/types';
import { PARTY_COLOR, STATUS_LABEL, topParty } from '../store';

// One line saying where a case stands. In progress is neutral; only an outcome is coloured.
export function CaseState({ c, detail = false }: { c: CaseFile; detail?: boolean }) {
  const ruling = c.arbiter.ruling;
  const color =
    c.status === 'blocked'
      ? 'var(--breach)'
      : c.status === 'released'
        ? 'var(--ok)'
        : c.status === 'ruled' && ruling
          ? PARTY_COLOR[topParty(ruling.split)]
          : c.status === 'manual_review' || c.status === 'failed'
            ? 'var(--faint)'
            : 'var(--text)';
  const active = ROLES.filter((r) => c.investigators[r].status !== 'skipped');
  const verified = active.filter((r) => c.investigators[r].status === 'verified').length;
  return (
    <span className={`state ${c.status} ${c.closedAt ? 'closed' : 'open'}`} style={{ ['--c' as string]: color }}>
      <i />
      {STATUS_LABEL[c.status]}
      {detail && c.status === 'investigating' && (
        <em>
          {verified} of {active.length} verified
        </em>
      )}
    </span>
  );
}
