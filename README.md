# Blackbox

**The guarantee for purchases made by AI agents.**

An AI shopping agent buys something. The customer says they never asked for it. Today nobody knows who pays: card networks have no dispute category for agent purchases, so the merchant usually absorbs the loss.

Blackbox records every agent purchase and does two things with that record:

- **Before the money moves:** a risky payment is stopped for a few seconds while a team of agents checks it, then blocked or released.
- **After a customer complains:** the team works out who was at fault — the customer, the agent's provider, the merchant, or a fraudster — and splits the liability.

Every figure anyone reports is traceable to a sealed record.

> **Prototype.** Built to try the idea and learn Mozaik ahead of the JigJoy Black Friday AI Hackathon. All data is synthetic. No real accounts, no real money. Nothing here is financial advice.

## Run it

```bash
npm install
npm run dev
```

Open http://localhost:5173. No API key is needed: without one, the agents run on a rule-based stand-in model (see [Two modes](#two-modes)).

```bash
npm run proof        # headless: run 8 disputes, print rulings and measured concurrency
npm run start        # production build, served by the engine on http://localhost:8787
```

## What you see

**Live view.** A globe on Black Friday. Each arc is a purchase made by a shopping agent. A held payment stops in mid-air (white) until the team decides: it turns red and dissolves if blocked, or green and lands if released. Disputed purchases stay lit and pin a marker where the buyer is. The **Risk board** tab ranks agent providers and merchants by the loss their own conduct caused, and prices the guarantee for each.

**Replay.** Click a case. The owner's instruction is drawn as a corridor:

- **Height is money.** The ceiling is the spending limit.
- **Width is scope.** The walls are the owner's own agent session.
- **The line is the agent's recorded journey**, plotted from the stored trail.

Where the line leaves the corridor is where the purchase left the mandate. The lights are the investigators: they roam while reading evidence, park on the record they cite, and face each other when one challenges another.

**Things to try**

- **▶ Guided tour** walks one case from the globe to the verdict in about a minute. It drives the real engine; nothing is pre-recorded.
- **Break it yourself** lets you set the errand and the limit, pick a sabotage, and choose whether Blackbox steps in before or after settlement.
- **What the agent read:** click a "View" step, then switch the page preview from what a person sees to what the agent read. Planted text shows up.
- **What if the limit were…?** Drag the slider in the case panel and the journey moves in or out of the corridor as you drag. "Re-run" has the team rule on the same records with that limit.
- **Download the evidence pack** on a closed case: one HTML file with the outcome, every finding and its checked citations, and every sealed record.
- **Sound** is off by default; the speaker button turns on short cues.

## The agents

Twelve participants share one Mozaik runtime. Nobody calls anybody: each declares the situations it reacts to.

| Participant | Kind | Wakes on | Does |
|---|---|---|---|
| Intake | code | — | Publishes `purchase.settled`, `purchase.pending` and `dispute.opened` |
| Sentinel | code | `purchase.pending` | Screens the payment with plain rules; holds the risky ones (`purchase.held`) |
| Mandate Analyst | model | `purchase.held`, `dispute.opened` | Did the agent stay inside its instruction? |
| Session Forensics | model | `purchase.held`, `dispute.opened` | Was this the owner's own session? |
| Listing Auditor | model | `purchase.held`, `dispute.opened` | Did the merchant charge what it advertised? |
| Claim Examiner | model | `dispute.opened` | Does the customer's claim hold up? (Skipped on a hold: nobody has complained yet.) |
| Verifier | code | `finding.submitted` | Checks every cited value against the sealed record |
| Moderator | code | all findings verified | If two findings blame different parties, makes each investigator answer the other |
| Arbiter | model | `case.ready` | Splits liability between the four parties |
| Risk officer | human | — | Approves or rejects rulings on large orders |
| Ledger | code | `ruling.issued` | Blocks or releases a hold; computes the money on a dispute; keeps the risk board |
| Bridge | code | everything | Streams events to the browser, measures concurrency |

### How they run concurrently

- **Parallel by construction.** All four investigators match `dispute.opened`, so one event starts four `runLoop`s at once. Several disputes are open at the same time, so loops from different cases overlap too. The strip at the bottom of the screen plots every model call as it happens; `npm run proof` recomputes the peak overlap from the raw intervals.
- **Shared state.** Cases, evidence, findings and counters live on a `RuntimeState` subclass ([server/state.ts](server/state.ts)). Each (case, agent) pair gets its own `ModelContext`, so two live loops never write to the same one.
- **Checks between agents.** The Verifier is plain code. A citation is `{ evidence_id, field, value }`; if the value does not match the record the finding is rejected, and the investigator is sent back to resubmit ([server/agents/verify.ts](server/agents/verify.ts)). A retry waits for that agent's previous turn to go idle first.
- **Cross-examination.** When two verified findings put weight on different parties, the Moderator opens a challenge in both directions at once. Each investigator re-enters its own context, weighs the other's evidence, and either maintains or revises its figure with `respond_to_challenge`. Only then does the Arbiter rule.
- **State-based triggers.** The Moderator does not wait for a particular agent: it acts when the shared case file holds every finding, verified. The Arbiter claims a case synchronously so two events cannot start two rulings.
- **Interception.** `issue_ruling` on an order at or above €1,000 is held mid-turn by an `InterceptionHandler` until a person approves it in the UI. Only that loop waits. A rejection rewrites the pending tool call so no ruling is recorded.

### Care with financial data

- Every number an agent reports must be cited, and every citation is checked in code against the record it names.
- No model produces a money amount. The Arbiter outputs percentages; the Ledger computes `order total × share` and shows the formula and its source next to each line ([server/agents/team.ts](server/agents/team.ts)).
- Records are sealed in a hash chain when a case opens ([server/data/scenarios.ts](server/data/scenarios.ts)): each hash covers the record and the hash before it. The Verifier recomputes a record's hash before accepting any citation to it, and re-walks the chain each time.
- The scenario's ground truth is kept apart from the evidence and is never given to an agent. It is shown only after a case closes. Cases with a hand-set limit have no ground truth and are not scored.

## Two modes

| | Scripted (default) | Live |
|---|---|---|
| Needs | nothing | one of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` in `.env` |
| Agent decisions | rule-based stand-in ([server/model/scripted.ts](server/model/scripted.ts)) | a real model |
| Mozaik loop, tools, events, interception, verifier | real | real |

The stand-in is an `InferenceRunner` that drives the real loop (inference → tool call → inference → answer) and decides from the evidence returned by `read_evidence`. It is not intelligent, and its rules were written by the same hand as the scenarios, so **its agreement with the ground truth says nothing about how a real model would do.**

In scripted mode, 15% of first submissions carry a deliberately wrong citation (`FAULT_RATE`) so the Verifier's rejection path is exercised and visible.

**Live mode has not been run yet** — no provider key was available when this was built. The prompts and tool schemas are written for it, but expect to tune them.

## Synthetic data

[server/data/scenarios.ts](server/data/scenarios.ts) generates six kinds of dispute, seeded by `SEED`:

| Scenario | What happened | Fault |
|---|---|---|
| `injection` | Hidden page text told the agent to ignore the limit | Agent provider |
| `quantity` | The agent ordered several when asked for one | Agent provider |
| `price_switch` | The merchant charged more than it listed | Merchant |
| `hidden_fee` | An undisclosed fee, plus an add-on the agent chose | Shared |
| `hijack` | The agent's token was replayed from another device | Fraud (guarantee absorbs) |
| `friendly` | A valid purchase the customer denies | Customer |

Merchant and agent-provider names are invented. The globe's land outline is Natural Earth 110m via `world-atlas` (public domain).

## Layout

```
server/            Mozaik engine
  agents/team.ts     every participant and its situation handlers
  agents/tools.ts    read_evidence, submit_finding, issue_ruling
  agents/verify.ts   citation checking
  model/             scripted stand-in and the guarded runner
  data/              synthetic world and scenarios
web/src/           React + three.js client
  views/Globe.tsx      live view
  views/CaseScene.tsx  the corridor replay
shared/types.ts    types shared by both
scripts/proof.ts   headless run
```

## Known gaps

- Live mode is untested end to end. The one attempt ran into a free-tier quota of 20 requests a day, about one case. `MAX_RPM` paces calls for low quotas.
- Not exercised in a browser yet: the evidence-pack download and the sound cues.
- The scripted model returns one tool call per inference; Mozaik also runs only the first tool call of a model response, so a real model that emits parallel tool calls will have the rest dropped.
- Nothing is persisted: restarting the engine starts a new run.
- The UI is built for desktop widths (about 1,300 px and up is best).
