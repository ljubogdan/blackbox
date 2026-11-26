import type { CaseFile } from '../../shared/types';
import { PARTIES, PARTY_NAME, ROLE_NAME, ROLES } from '../../shared/types';

// The evidence pack: one self-contained HTML file with the outcome, every
// finding and its checked citations, and every sealed record. It is what a
// merchant or an agent provider would hand to their bank.

const esc = (v: unknown) => String(v ?? '—').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
const eur = (n: number) => `€${n.toFixed(2)}`;

export function buildPack(c: CaseFile): string {
  const ruling = c.arbiter.ruling;
  const findings = ROLES.map((r) => c.investigators[r]).filter((i) => i.finding);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Blackbox evidence pack ${esc(c.id)}</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;color:#111;max-width:820px;margin:40px auto;padding:0 24px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:28px 0 8px;border-bottom:1px solid #ccc;padding-bottom:4px}
table{border-collapse:collapse;width:100%;font-size:12.5px}td,th{border:1px solid #ddd;padding:4px 8px;text-align:left;vertical-align:top}
th{background:#f4f4f4}code{font:12px ui-monospace,monospace}.muted{color:#666}.ok{color:#0a7d4f}.bad{color:#c22}
.note{background:#f6f6f6;border-left:3px solid #999;padding:8px 12px;margin:12px 0}
</style></head><body>
<h1>Evidence pack — ${esc(c.id)}</h1>
<div class="muted">${c.stage === 'hold' ? 'Payment held before settlement' : 'Dispute after settlement'} · generated ${new Date().toISOString()}${c.whatIfOf ? ` · what-if re-run of ${esc(c.whatIfOf)}` : ''}</div>
<div class="note">Synthetic data produced by the Blackbox prototype. No real customer, account or payment is described here. Not financial or legal advice.</div>

<h2>Purchase</h2>
<table>
<tr><th>Item</th><td>${esc(c.purchase.item)}</td></tr>
<tr><th>Amount</th><td>${eur(c.purchase.total)}</td></tr>
<tr><th>Merchant</th><td>${esc(c.purchase.merchant.name)}</td></tr>
<tr><th>Agent provider</th><td>${esc(c.purchase.provider)}</td></tr>
<tr><th>Owner's instruction</th><td>${esc(c.mandate.text)}</td></tr>
${c.stage === 'hold' ? `<tr><th>Why it was held</th><td>${esc(c.flag)}</td></tr>` : `<tr><th>Customer's claim</th><td>${esc(c.claim)}</td></tr>`}
</table>

<h2>Outcome</h2>
<p><b>${esc(c.status.replace('_', ' ').toUpperCase())}</b>${ruling ? ` — <code>${esc(ruling.reason_code)}</code>` : ''}</p>
${ruling ? `<table><tr>${PARTIES.map((p) => `<th>${esc(PARTY_NAME[p])}</th>`).join('')}</tr><tr>${PARTIES.map((p) => `<td>${ruling.split[p]}%</td>`).join('')}</tr></table><p>${esc(ruling.rationale)}</p>` : '<p>No ruling was recorded.</p>'}
${c.settlement ? `<table><tr><th>Line</th><th>Calculation</th><th>Source</th><th>Amount</th></tr>${c.settlement.map((l) => `<tr><td>${esc(l.label)}</td><td><code>${esc(l.formula)}</code></td><td><code>${esc(l.source)}</code></td><td>${eur(l.amount)}</td></tr>`).join('')}</table>` : ''}

<h2>Findings</h2>
${findings
  .map((i) => {
    const f = i.finding!;
    const checks = new Map((i.checks ?? []).map((k) => [`${k.evidence_id}.${k.field}`, k]));
    return `<h3 style="font-size:14px;margin:16px 0 4px">${esc(ROLE_NAME[f.role])} — ${f.liability}/100 on ${esc(PARTY_NAME[f.party])} (confidence ${f.confidence}/100, ${i.attempts} attempt${i.attempts === 1 ? '' : 's'})</h3>
<p>${esc(f.summary)}</p>
${i.challenge?.status === 'answered' ? `<p class="muted">Challenged by the ${esc(ROLE_NAME[i.challenge.from])}: ${i.challenge.stance === 'revise' ? `revised from ${i.challenge.before}/100` : 'maintained'}. ${esc(i.challenge.reply)}</p>` : ''}
<table><tr><th>Record</th><th>Field</th><th>Cited value</th><th>Check</th></tr>${f.citations
      .map((k) => {
        const chk = checks.get(`${k.evidence_id}.${k.field}`);
        return `<tr><td><code>${esc(k.evidence_id)}</code></td><td><code>${esc(k.field)}</code></td><td>${esc(k.value)}</td><td class="${chk?.ok ? 'ok' : 'bad'}">${chk ? (chk.ok ? 'matches the record' : esc(chk.reason)) : 'not checked'}</td></tr>`;
      })
      .join('')}</table>`;
  })
  .join('')}

<h2>Sealed records</h2>
<p class="muted">Each record's hash covers its content and the hash of the record before it. Chain ${c.integrity.ok ? '<span class="ok">verified</span>' : '<span class="bad">BROKEN</span>'} across ${c.integrity.records} records; head <code>${esc(c.integrity.head.slice(0, 24))}…</code></p>
${c.evidence
  .map(
    (e) => `<h3 style="font-size:13px;margin:14px 0 4px"><code>${esc(e.id)}</code> — ${esc(e.title)}</h3>
<table>${Object.entries(e.data)
      .map(([k, v]) => `<tr><th style="width:34%"><code>${esc(k)}</code></th><td>${esc(v)}</td></tr>`)
      .join('')}<tr><th><code>sha256</code></th><td><code>${esc(e.hash)}</code></td></tr></table>`,
  )
  .join('')}
</body></html>`;
}

export function downloadPack(c: CaseFile) {
  const url = URL.createObjectURL(new Blob([buildPack(c)], { type: 'text/html' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `blackbox-${c.id}.html`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
