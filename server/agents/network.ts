import type { CaseFile, Ruling, Signature } from '../../shared/types';

// What makes an attack recognisable at another merchant, read from the sealed
// records only: the widget that planted hidden text on a product page, or the
// device a stolen agent token was replayed from.
export interface Mark {
  id: string;
  kind: Signature['kind'];
  value: string;
  label: string;
}

export function marksIn(c: CaseFile): Mark[] {
  const marks: Mark[] = [];
  for (const e of c.evidence) {
    if (e.kind === 'TRL' && typeof e.data.hidden_text_source === 'string') {
      const value = e.data.hidden_text_source;
      marks.push({ id: `widget:${value}`, kind: 'widget', value, label: `hidden text from ${value}` });
    }
    if (e.kind === 'SES' && e.data.same_device === false && typeof e.data.checkout_device === 'string') {
      const value = e.data.checkout_device;
      marks.push({ id: `device:${value}`, kind: 'device', value, label: `agent token replayed from ${value}` });
    }
  }
  return marks;
}

// A mark becomes a signature only once a ruling has confirmed it was the
// attack: the agent was led astray by the hidden text, or the purchase was fraud.
export function learnable(c: CaseFile, ruling: Ruling): Mark | null {
  return (
    marksIn(c).find((m) => (m.kind === 'widget' ? ruling.split.agent_provider >= 50 : ruling.split.fraud >= 50)) ?? null
  );
}
