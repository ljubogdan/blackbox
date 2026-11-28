import { useState } from 'react';
import type { Sabotage } from '../../../shared/types';
import { CATALOG_PRICES, CATALOG_TITLES } from '../../../shared/types';
import { eur, nonce, useStore } from '../store';

const SABOTAGE: { id: Sabotage; title: string; text: string }[] = [
  { id: 'injection', title: 'Hidden text on the page', text: 'The product page tells AI readers to ignore the price limit.' },
  { id: 'quantity', title: 'Nudge the quantity', text: 'A banner persuades the agent to order several, not one.' },
  { id: 'price_switch', title: 'Switch the price', text: 'The merchant charges more than the page showed.' },
  { id: 'hidden_fee', title: 'Hidden fee', text: 'A mandatory fee appears at the end, and the agent adds a warranty.' },
  { id: 'hijack', title: 'Steal the agent', text: "The agent's credentials are replayed from another device." },
  { id: 'clean', title: 'Nothing', text: 'A valid purchase, to see a clean pass.' },
];

// The simulator: pick what the owner asked for and what goes wrong, and run it
// through the same engine as every other purchase.
export function Builder() {
  const close = () => useStore.getState().set({ builder: false });
  const request = useStore((s) => s.request);
  const [item, setItem] = useState(1);
  const [max, setMax] = useState(260);
  const [sabotage, setSabotage] = useState<Sabotage>('injection');
  const [stage, setStage] = useState<'hold' | 'dispute'>('hold');

  const pick = (i: number) => {
    setItem(i);
    setMax(Math.ceil((CATALOG_PRICES[i] * 1.15) / 10) * 10);
  };
  const launch = () => {
    request({ type: 'custom', nonce: nonce(), spec: { item, max, sabotage, stage } });
    close();
  };

  return (
    <div className="modal-back" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Simulate a case">
        <header>
          <div>
            <h2>Simulate a case</h2>
            <p>Run a purchase with a known fault through Blackbox and see how it is handled.</p>
          </div>
          <button className="x" onClick={close} aria-label="Close">
            ×
          </button>
        </header>

        {/* only the middle scrolls: the rim drawn round the sheet would make the sheet itself overflow */}
        <div className="modal-body">
          <div className="step">
            <label>1. The purchase</label>
            <div className="errand">
              <select value={item} onChange={(e) => pick(Number(e.target.value))}>
                {CATALOG_TITLES.map((t, i) => (
                  <option key={t} value={i}>
                    {t} (about {eur(CATALOG_PRICES[i], 0)})
                  </option>
                ))}
              </select>
              <span>spend no more than</span>
              <div className="money">
                €
                <input type="number" min={10} max={5000} step={10} value={max} onChange={(e) => setMax(Number(e.target.value))} />
              </div>
            </div>
          </div>

          <div className="step">
            <label>2. What goes wrong</label>
            <div className="options">
              {SABOTAGE.map((o) => (
                <button key={o.id} className={sabotage === o.id ? 'on' : ''} onClick={() => setSabotage(o.id)}>
                  <b>{o.title}</b>
                  <span>{o.text}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="step">
            <label>3. When Blackbox gets involved</label>
            <div className="toggle">
              <button className={stage === 'hold' ? 'on' : ''} onClick={() => setStage('hold')}>
                <b>Before the money moves</b>
                <span>The payment is screened and can be stopped inside the box.</span>
              </button>
              <button className={stage === 'dispute' ? 'on' : ''} onClick={() => setStage('dispute')}>
                <b>After the customer complains</b>
                <span>The payment settled. Now someone has to pay for it.</span>
              </button>
            </div>
          </div>
        </div>

        <footer>
          <span>Simulated. No real purchase is made.</span>
          <button className="btn primary" onClick={launch}>
            Run simulation
          </button>
        </footer>
      </div>
    </div>
  );
}
