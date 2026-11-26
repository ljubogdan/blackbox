import type { CaseFile } from '../../shared/types';

// The screen every payment passes before it settles. Plain rules, instant, no
// model: it does not decide anything, it only picks which payments are worth
// stopping for a few seconds so the investigators can look.
export function screen(c: CaseFile): string | null {
  const data = (kind: string) => c.evidence.find((e) => e.kind === kind)?.data ?? {};
  const mnd = data('MND');
  const ord = data('ORD');
  const ses = data('SES');
  const lst = data('LST');
  if (ses.same_device === false) return 'checkout device differs from the one the mandate was issued on';
  if (Number(ord.total) > Number(mnd.max_amount)) return 'amount is above the mandate limit';
  if (Number(ord.quantity) > Number(mnd.quantity)) return 'quantity is above the mandate';
  if (Number(ord.unit_price) > Number(lst.listed_price)) return 'charge is higher than the listed price';
  if (lst.fees_disclosed === false && Number(ord.fees) > 0) return 'a fee is charged that the listing did not disclose';
  if (ord.category !== mnd.category) return 'category is outside the mandate';
  if (ses.first_purchase_at_merchant === true) return "first purchase by this agent at this merchant";
  return null;
}
