import { nonce, useStore } from '../store';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let running = 0; // bumping this cancels a tour in progress

async function until(test: () => boolean, timeoutMs: number, token: number) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end && running === token && !test()) await wait(150);
}

// A 60-second walk through one case, start to finish. It drives the same store
// and the same engine as a person clicking would; nothing in it is pre-recorded.
export async function startTour() {
  const token = ++running;
  const st = () => useStore.getState();
  const say = (step: number, caption: string) => running === token && st().set({ tour: { caption, step, of: 7 } });
  const alive = () => running === token;

  st().back();
  say(1, 'Black Friday. Every arc is a purchase made by an AI shopping agent, not by a person.');
  await wait(5500);
  if (!alive()) return;

  const id = nonce();
  st().request({ type: 'custom', nonce: id, spec: { item: 1, max: 260, sabotage: 'injection', stage: 'hold' } }, false);
  say(2, 'One payment looks wrong. Blackbox stops it in mid-air, before any money moves.');
  await until(() => st().lastCreated?.nonce === id, 6000, token);
  await wait(3200);
  const caseId = st().lastCreated?.nonce === id ? st().lastCreated!.caseId : null;
  if (!alive() || !caseId) return endTour();

  st().open(caseId);
  say(3, 'This is that purchase, replayed. The corridor is what the owner allowed: the ceiling is their spending limit.');
  await wait(5500);
  if (!alive()) return;

  say(4, 'Three investigators examine it at the same time. A verifier checks every figure they cite against the sealed record.');
  await Promise.all([wait(4500), until(() => !!st().cases[caseId]?.closedAt, 20000, token)]);
  if (!alive()) return;

  const c = st().cases[caseId];
  const planted = c?.evidence.find((e) => typeof e.data.hidden_text === 'string');
  if (planted) st().set({ inspect: { evidenceId: planted.id, field: 'hidden_text' }, pageMode: 'agent' });
  say(5, 'Here is why it left the corridor: the product page carried an instruction that only an AI would read.');
  await wait(7500);
  if (!alive()) return;

  const closed = st().cases[caseId];
  say(
    6,
    closed?.status === 'blocked'
      ? "Blocked. The fault was the agent's, and the customer never lost a cent."
      : 'The team has reached its outcome, with every amount traced to a record.',
  );
  await wait(6500);
  if (!alive()) return;

  say(7, 'Now try it: drag the spending limit to ask “what if?”, or press “Break it yourself”.');
  await wait(6000);
  if (alive()) endTour();
}

export function endTour() {
  running++;
  useStore.getState().set({ tour: null });
}

export function TourCaption() {
  const tour = useStore((s) => s.tour);
  const view = useStore((s) => s.view);
  if (!tour) return null;
  return (
    <div className={`tour ${view}`} role="status">
      <div className="dots">
        {Array.from({ length: tour.of }, (_, i) => (
          <i key={i} className={i < tour.step ? 'on' : ''} />
        ))}
      </div>
      <p key={tour.step}>{tour.caption}</p>
      <button onClick={endTour}>Skip tour</button>
    </div>
  );
}
