import type { CaseFile } from '../../shared/types';
import { PARTIES, PARTY_NAME, ROLE_NAME, ROLES } from '../../shared/types';
import { PARTY_COLOR } from './store';

// The evidence pack: one self-contained HTML file with the outcome, every
// finding and its checked citations, and every sealed record. It is what a
// merchant or an agent provider would hand to their bank.

const esc = (v: unknown) => String(v ?? '—').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
const eur = (n: number) => `€${n.toFixed(2)}`;

const STATUS: Record<CaseFile['status'], string> = {
  investigating: 'Under investigation',
  arbitrating: 'With the arbiter',
  awaiting_approval: 'Awaiting human approval',
  ruled: 'Ruled',
  blocked: 'Blocked before settlement',
  released: 'Released',
  manual_review: 'Sent to manual review',
  failed: 'Failed',
};

const CSS = `
@page{margin:18mm}
*{box-sizing:border-box}
body{font:14px/1.55 -apple-system,BlinkMacSystemFont,"SF Pro Text","Inter","Helvetica Neue",Arial,sans-serif;color:#16161a;background:#f3f2ee;margin:0;font-variant-numeric:tabular-nums}
main{max-width:840px;margin:36px auto;padding:56px 64px 48px;background:#fff;border:1px solid #dddcd6}
header{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;padding-bottom:22px;border-bottom:2px solid #16161a}
.brand{font-weight:650;letter-spacing:-.02em;font-size:15px}
.kind{font-size:12px;color:#6a6a70;text-align:right;line-height:1.5}
h1{font:600 34px/1.1 -apple-system,BlinkMacSystemFont,"SF Pro Display","Inter","Helvetica Neue",Arial,sans-serif;letter-spacing:-.03em;margin:28px 0 6px}
.sub{color:#6a6a70;font-size:13px}
h2{font:600 20px/1.2 -apple-system,BlinkMacSystemFont,"SF Pro Display","Inter","Helvetica Neue",Arial,sans-serif;letter-spacing:-.022em;margin:38px 0 12px;padding-top:16px;border-top:1px solid #dddcd6}
h3{font-size:13.5px;font-weight:650;margin:20px 0 4px}
h3 span{font-weight:400;color:#6a6a70}
p{margin:6px 0}
.note{margin:18px 0 0;padding:10px 14px;background:#f3f2ee;font-size:12.5px;color:#4a4a50}
dl{display:grid;grid-template-columns:170px 1fr;gap:0;margin:0}
dt,dd{margin:0;padding:7px 0;border-bottom:1px solid #ecebe6}
dt{color:#6a6a70;font-size:12.5px}
.quote{font-size:15px}
.outcome{display:flex;align-items:baseline;gap:12px;margin:0 0 12px}
.outcome b{font-size:16px}
.rationale{font-size:15.5px;line-height:1.5;margin:14px 0}
.split{display:flex;height:38px;border-radius:5px;overflow:hidden;gap:2px;margin:10px 0 6px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.split div{display:flex;flex-direction:column;justify-content:center;padding:0 10px;min-width:0;color:#111;font-size:11px;font-weight:600;white-space:nowrap;overflow:hidden}
.split b{font-size:15px;line-height:1.1}
table{border-collapse:collapse;width:100%;font-size:12.5px;margin:6px 0}
th,td{padding:6px 10px 6px 0;text-align:left;vertical-align:top;border-bottom:1px solid #ecebe6}
th{font-weight:600;font-size:11.5px;color:#6a6a70;border-bottom:1px solid #16161a}
td.num,th.num{text-align:right;padding-right:0;white-space:nowrap}
tr.rec th{width:34%;border-bottom:1px solid #ecebe6;font-weight:400}
code{font:inherit;font-size:12px;color:#33333a;word-break:break-all}
.muted{color:#6a6a70}.ok{color:#0c7a50}.bad{color:#c2331f}
.seal{font-size:12.5px;color:#4a4a50}
footer{margin-top:40px;padding-top:14px;border-top:1px solid #dddcd6;font-size:11.5px;color:#6a6a70;display:flex;justify-content:space-between;gap:20px}
@media print{body{background:#fff}main{border:0;margin:0;padding:0;max-width:none}h2,h3{break-after:avoid}table,dl{break-inside:auto}tr{break-inside:avoid}}
`;

export function buildPack(c: CaseFile): string {
  const ruling = c.arbiter.ruling;
  const findings = ROLES.map((r) => c.investigators[r]).filter((i) => i.finding);
  const generated = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Blackbox evidence pack ${esc(c.id)}</title>
<style>${CSS}</style></head><body><main>
<header>
<div class="brand">Blackbox</div>
<div class="kind">Evidence pack<br><code>${esc(c.id)}</code><br>${esc(generated)}</div>
</header>
<h1>${esc(c.purchase.item)}</h1>
<div class="sub">${c.stage === 'hold' ? 'Payment held before settlement' : 'Dispute after settlement'}${c.whatIfOf ? ` · what-if re-run of ${esc(c.whatIfOf)}` : ''}</div>
<div class="note">Synthetic data produced by the Blackbox prototype. No real customer, account or payment is described here. Not financial or legal advice.</div>

<h2>Purchase</h2>
<dl>
<dt>Amount</dt><dd>${eur(c.purchase.total)}</dd>
<dt>Merchant</dt><dd>${esc(c.purchase.merchant.name)}</dd>
<dt>Agent provider</dt><dd>${esc(c.purchase.provider)}</dd>
<dt>Owner's instruction</dt><dd>${esc(c.mandate.text)}</dd>
${c.stage === 'hold' ? `<dt>Why it was held</dt><dd>${esc(c.flag)}</dd>` : `<dt>Customer's claim</dt><dd class="quote">“${esc(c.claim)}”</dd>`}
</dl>

<h2>Outcome</h2>
<div class="outcome"><b>${esc(STATUS[c.status])}</b>${ruling ? `<code>${esc(ruling.reason_code)}</code>` : ''}</div>
${
  ruling
    ? `<div class="split">${PARTIES.filter((p) => ruling.split[p] > 0)
        .map((p) => `<div style="width:${ruling.split[p]}%;background:${PARTY_COLOR[p]}"><b>${ruling.split[p]}%</b>${esc(PARTY_NAME[p])}</div>`)
        .join('')}</div><p class="rationale">${esc(ruling.rationale)}</p>`
    : '<p>No ruling was recorded.</p>'
}
${c.settlement ? `<table><tr><th>Line</th><th>Calculation</th><th>Source</th><th class="num">Amount</th></tr>${c.settlement.map((l) => `<tr><td>${esc(l.label)}</td><td><code>${esc(l.formula)}</code></td><td><code>${esc(l.source)}</code></td><td class="num">${eur(l.amount)}</td></tr>`).join('')}</table>` : ''}

<h2>Findings</h2>
${findings
  .map((i) => {
    const f = i.finding!;
    const checks = new Map((i.checks ?? []).map((k) => [`${k.evidence_id}.${k.field}`, k]));
    return `<h3>${esc(ROLE_NAME[f.role])} <span>· ${f.liability}/100 on ${esc(PARTY_NAME[f.party])} · confidence ${f.confidence}/100 · ${i.attempts} attempt${i.attempts === 1 ? '' : 's'}</span></h3>
<p>${esc(f.summary)}</p>
${i.challenge?.status === 'answered' ? `<p class="muted">Challenged by the ${esc(ROLE_NAME[i.challenge.from])}${i.challenge.stance === 'revise' ? `, and revised from ${i.challenge.before}/100` : ''}. ${esc(i.challenge.reply)}</p>` : ''}
<table><tr><th>Record</th><th>Field</th><th>Cited value</th><th>Check</th></tr>${f.citations
      .map((k) => {
        const chk = checks.get(`${k.evidence_id}.${k.field}`);
        return `<tr><td><code>${esc(k.evidence_id)}</code></td><td><code>${esc(k.field)}</code></td><td>${esc(k.value)}</td><td class="${chk?.ok ? 'ok' : 'bad'}">${chk ? (chk.ok ? 'Matches the record' : esc(chk.reason)) : 'Not checked'}</td></tr>`;
      })
      .join('')}</table>`;
  })
  .join('')}

<h2>Sealed records</h2>
<p class="seal">Each record's hash covers its content and the hash of the record before it. Chain ${c.integrity.ok ? '<span class="ok">verified</span>' : '<span class="bad">broken</span>'} across ${c.integrity.records} records. Head <code>${esc(c.integrity.head.slice(0, 24))}…</code></p>
${c.evidence
  .map(
    (e) => `<h3><code>${esc(e.id)}</code> <span>· ${esc(e.title)}</span></h3>
<table>${Object.entries(e.data)
      .map(([k, v]) => `<tr class="rec"><th><code>${esc(k)}</code></th><td>${esc(v)}</td></tr>`)
      .join('')}<tr class="rec"><th><code>sha256</code></th><td><code>${esc(e.hash)}</code></td></tr></table>`,
  )
  .join('')}
<footer><span>Blackbox · the guarantee for purchases made by AI agents</span><span>Synthetic data · not financial or legal advice</span></footer>
</main></body></html>`;
}

export function downloadPack(c: CaseFile) {
  const url = URL.createObjectURL(new Blob([buildPack(c)], { type: 'text/html' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `blackbox-${c.id}.html`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
