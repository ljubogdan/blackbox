# Blackbox

[![CI](https://github.com/ljubogdan/blackbox/actions/workflows/ci.yml/badge.svg)](https://github.com/ljubogdan/blackbox/actions/workflows/ci.yml)

**The guarantee for purchases made by AI agents.**

An AI shopping agent buys something. The customer says they never asked for it. Today nobody knows who pays: card networks have no dispute category for agent purchases, so the merchant usually absorbs the loss.

Blackbox records every agent purchase and does two things with that record:

- **Before the money moves:** a risky payment is stopped for a few seconds while a team of agents checks it, then blocked or released.
- **After a customer complains:** the team works out who was at fault — the customer, the agent's provider, the merchant, or a fraudster — and splits the liability.

Every figure anyone reports is traceable to a sealed record.

**Measured on real models:** Claude Sonnet 4.6 ruled 12 of 12 synthetic cases correctly, with its liability splits 6 points off the ground truth on average. Claude Haiku 4.5 ruled 34 of 36 (three of each kind), 17.5 points off. No citation from either model failed the Verifier. See [Results](#results).

> **Prototype.** Built on Mozaik for the JigJoy Black Friday AI Hackathon (Agents in Finance). All data is synthetic. No real accounts, no real money. Nothing here is financial or legal advice, and the app says so on every screen.

## How it meets the brief

| Criterion | Points | What to look at |
|---|---|---|
| Useful | 30 | The track's own ideas, *investigate held payments* and *route payments beyond an agent's authority to a human approver*, applied to purchases made by AI agents: a risky payment is held, investigated, then blocked or released, and a disputed one is split between the parties at fault. Rulings on orders of €1,000 or more wait for a person. |
| Multi-agent design on Mozaik | 30 | Thirteen participants in one runtime; nobody calls anybody ([The agents](#the-agents)). Four investigators wake on the same event and run in parallel: `npm run proof` measures the peak number of model calls at once (13 in a scripted run). Shared state is a `RuntimeState` subclass ([server/state.ts](server/state.ts)). Checks between agents: the Verifier sends back any finding whose citation does not match its record, the Moderator makes investigators who disagree answer each other, and `issue_ruling` refuses a share no finding supports. |
| It works | 25 | `npm install && npm run dev`, no API key needed. CI runs the typecheck, the test suite, the build and a full scripted eval on every push. On real models: Sonnet 4.6 12 of 12, Haiku 4.5 34 of 36 ([Results](#results)). |
| Care with financial data | 15 | Every number an agent reports cites a field of a hash-sealed record, and code checks each one before the finding counts. No model produces a money amount: the Ledger computes them in whole cents and shows each formula and its source. The ground truth is never shown to an agent ([Care with financial data](#care-with-financial-data)). |

## Run it

```bash
npm install
npm run dev
```

Open http://localhost:5173. No API key is needed: without one, the agents run on a rule-based stand-in model (see [Two modes](#two-modes)).

```bash
npm run proof        # headless: run 8 disputes, print rulings and measured concurrency
npm run eval         # score the team on every kind of case (see Measuring accuracy)
npm test             # the Verifier, the hash chain, the Ledger's sums, and tool calls in the loop
npm run start        # production build, served by the engine on http://localhost:8787
```

## What you see

**Network.** The first screen is a globe. Every merchant runs its own Blackbox in its own city, and each purchase an agent makes flies from the buyer's city to the merchant's. When a ruling confirms an attack (hidden text planted by a third-party review widget, or a stolen agent token replayed from one device), the Network agent keeps its signature and a wave goes round the world from that merchant's city, raising a shield over every merchant it passes. When the same attack lands at another merchant, the Sentinel recognises it and blocks the payment on arrival, with no investigation: it breaks on that city's shield and a line points back to the merchant the knowledge came from. Attacks arrive as campaigns: the same widget or device lands at a different merchant each time.

The top bar counts what is **Guaranteed**, what was **Stopped before settlement** and what was **Stopped by the network**. The panel on the side has three tabs:

- **Cases:** every open and recent case, held payments and disputes alike. Click a city on the globe to show only that merchant's cases; click a case to open it.
- **Network:** every learned attack, what it has stopped, and the case it was learned from.
- **Risk pricing:** what each agent provider's and merchant's own conduct has cost so far, and the rate the guarantee should charge them.

The strip at the bottom opens the engine view: every model call over the last 45 seconds, so you can see the agents working at the same moment.

**Case.** Opening a case flies down into the merchant's city. A case reads like a storage bar:

- **The amount charged**, and one line on what the records show before anyone rules (stayed inside the mandate, went over the limit, ordered more than asked, made from another device).
- **One bar of the order taken apart:** the item as listed, units beyond what was asked for, price above the listing, an add-on the agent chose, a fee the listing did not show. Each part is in the colour of whoever caused it. The owner's limit is drawn across the bar, and everything past it is struck through.
- **The agent's steps** under it, with the step where the purchase left the mandate marked.

On the left: the owner's instruction, the customer's claim or why the payment was held, and the what-if slider. On the right: the sealed records and the case's activity. Click a part of the bar or a step to open its record. **Show the team** brings up the four investigators' cards (their findings, citations, and any challenge between them) and the verdict.

**Things to try**

- **Approve a ruling.** A ruling on an order of €1,000 or more stops and waits for you. The top bar counts what is waiting and opens the oldest. In the case, the ruling is shown as a draft until you approve it or send it to manual review. Once two rulings are waiting, the stream keeps new disputes to small orders (`MAX_AWAITING`).
- **Simulate** lets you set the purchase and the limit, pick what goes wrong, and choose whether Blackbox steps in before or after settlement.
- **What the agent read:** click a "Viewed" step, then switch the page preview from what a person sees to what the agent read. Planted text shows up.
- **What if the limit were…?** Drag the slider and the limit line moves across the bar as you drag. "Re-run the case with this limit" has the team rule on the same records with that limit.
- **Tamper with a record.** In an open record, change any field. The engine runs the Verifier's own checks on a copy and shows which seal breaks and which findings would be sent back. The case on file is never touched.
- **Download the evidence pack** on a closed case: one HTML file with the outcome, every finding and its checked citations, and every sealed record.
- **Sound** is off by default; the speaker button turns on short cues. The pause button stops the purchase stream.

## The agents

Thirteen participants share one Mozaik runtime. Nobody calls anybody: each declares the situations it reacts to.

| Participant | Kind | Wakes on | Does |
|---|---|---|---|
| Intake | code | — | Publishes `purchase.settled`, `purchase.pending` and `dispute.opened` |
| Sentinel | code | `purchase.pending` | Blocks a payment that matches a learned attack on arrival; otherwise screens it with plain rules and holds the risky ones (`purchase.held`) |
| Mandate Analyst | model | `purchase.held`, `dispute.opened` | Did the agent stay inside its instruction? |
| Session Forensics | model | `purchase.held`, `dispute.opened` | Was this the owner's own session? |
| Listing Auditor | model | `purchase.held`, `dispute.opened` | Did the merchant charge what it advertised? |
| Claim Examiner | model | `dispute.opened` | Does the customer's claim hold up? (Skipped on a hold: nobody has complained yet.) |
| Verifier | code | `finding.submitted` | Checks every cited value against the sealed record, and that the investigator cited the records its question is about |
| Moderator | code | all findings verified | If two findings blame different parties, makes each investigator answer the other |
| Arbiter | model | `case.ready` | Splits liability between the four parties |
| Risk officer | human | — | Approves or rejects rulings on large orders |
| Ledger | code | `ruling.issued` | Blocks or releases a hold; computes the money on a dispute; keeps the risk board |
| Network | code | `case.closed` | Learns an attack's signature from a confirming ruling and shares it with every merchant; credits each catch to the signature that made it |
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
- A true value can still be beside the point, so each investigator must also cite the records its own question is about: the Mandate Analyst the mandate and the order, Session Forensics the session, the Listing Auditor the listing and the order, the Claim Examiner the mandate or the session. A finding that misses one is sent back like one with a wrong value ([server/agents/verify.ts](server/agents/verify.ts)).
- **What the checks do not prove.** The Verifier proves that every fact in a finding is real and that the investigator looked at the right records. It does not prove that the conclusion follows from them: no code can tell whether "this was fraud" is the right reading of a session record. That is left to three other layers: investigators who disagree must answer each other, the Arbiter sees every finding side by side, and a person approves every ruling on a large order. Writing rules that judge the reasoning was considered and rejected, because they would be written by the same hand as the scenarios and would know the answers.
- No share without a finding. A party other than the customer can be given a share only if a verified finding puts at least 20/100 on it (`MATERIAL`); `issue_ruling` refuses any other split and the Arbiter has to issue it again. Without this, a model hedging with "fraud 5%" blocked a clean held payment, because any share outside the customer's blocks a hold.
- No model produces a money amount. The Arbiter outputs percentages; the Ledger computes `order total × share` in whole cents and shows the formula and its source next to each line ([server/agents/team.ts](server/agents/team.ts)). On a shared ruling the amounts recovered and absorbed always add up to the refund: the odd cent goes to the share that rounding cut the most.
- Records are sealed in a hash chain when a case opens ([server/data/scenarios.ts](server/data/scenarios.ts)): each hash covers the record and the hash before it. The Verifier recomputes a record's hash before accepting any citation to it, and re-walks the chain each time.
- The scenario's ground truth is kept apart from the evidence and is never given to an agent. It is shown only after a case closes. Cases with a hand-set limit have no ground truth and are not scored.

## Two modes

| | Scripted (default) | Live |
|---|---|---|
| Needs | nothing | one of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` in `.env`, or `LOCAL_BASE_URL` for your own model server |
| Agent decisions | rule-based stand-in ([server/model/scripted.ts](server/model/scripted.ts)) | a real model |
| Mozaik loop, tools, events, interception, verifier | real | real |

The stand-in is an `InferenceRunner` that drives the real loop (inference → tool call → inference → answer) and decides from the evidence returned by `read_evidence`. It is not intelligent, and its rules were written by the same hand as the scenarios, so **its agreement with the ground truth says nothing about how a real model would do.**

In scripted mode, 15% of first submissions carry a deliberately wrong citation (`FAULT_RATE`) so the Verifier's rejection path is exercised and visible.

**Live mode has run the full eval on Claude** (see [Results](#results)) and one case on Gemini. OpenAI keys are untested. `ANTHROPIC_BASE_URL` sends Claude requests through a gateway; note that a variable already set in your shell wins over `.env`.

`LOCAL_BASE_URL` and `LOCAL_MODEL` run the team on your own Ollama or LM Studio server, which must speak the OpenAI Responses API. Raise its context window first: Blackbox's prompts pass 4,096 tokens, Ollama's default, within the first case. A 4B model was tried and was too slow to finish a case in 12 minutes, so this is for free plumbing tests, not for measuring accuracy.

When a provider says no, the guarded runner ([server/model/guard.ts](server/model/guard.ts)) sorts the failure. A per-minute limit is waited out. A model that is out of quota for the day, or that stays overloaded, is rested and the request moves to the next model in `FALLBACK_MODELS` (for Gemini, `gemini-3.5-flash-lite` then `gemini-3.8-flash` by default). If no model can answer, the turn ends and the reason is written to the case's activity log. This has been seen working against the real API: a run that started on a model with no quota left finished its case on the next one.

Gemini 3 models sign each function call and reject the next request unless the signature is sent back. Mozaik's Gemini mapper drops it, so [server/model/gemini.ts](server/model/gemini.ts) keeps the signatures and returns them.

## Measuring accuracy

`npm run proof` shows the system working. It counts the payments the network blocked on a learned signature apart from the cases the team decided, but it is still not a measure of accuracy: the mix of cases depends on the stream.

`npm run eval` is the measure. It starts the engine with no stream (`STREAM=off`) and no network learning (`NETWORK=off`), so every case goes through the team. It runs each of the 12 kinds of case (six faults as disputes, five as holds, one clean hold) the same number of times, and for each kind prints how many rulings were right and how far the split was from the ground truth on average. A held payment is right if it was blocked or released correctly; a dispute is right if the party with the largest share is the right one. Every case, with its findings and log, is written to `eval-results/`.

```bash
npm run eval          # each kind once: 12 cases
npm run eval -- 3     # each kind three times: 36 cases
```

A case takes about 15 model calls, so one round of 12 is about 180 calls. That is far beyond a free Gemini key (20 requests a day per model); a live eval needs a paid key. In scripted mode the eval runs for free and scores 12 of 12, which only shows the harness works.

### Results

The same model in every role, on 26 November 2026. Haiku ran three cases of each of the 12 kinds; Sonnet ran one of each.

| Model | Correct | Mean off (points) | Citations rejected | Model calls |
|---|---|---|---|---|
| Claude Sonnet 4.6 | 12 / 12 | 6 | 0 | 186 |
| Claude Haiku 4.5 | 34 / 36 | 17.5 | 0 | 606 |
| Claude Haiku 4.5, before the `MATERIAL` rule (one of each) | 10 / 12 | 24 | 0 | 211 |

Naming the party at fault was the easy part; splitting the loss was not. Before the rule, Haiku spread small shares across parties the evidence cleared, and blocked the clean payment for a 5% fraud share. Since the rule, Haiku has released the clean payment every time. Its two misses in 36 were one price-switch dispute and one hijack dispute; its splits are loosest on hijacks (about 34 points off) and injections (22 to 28).

Single runs vary: two 12-case Haiku runs of the same code came out 12 and 7 points off, and the 36-case run 17.5, so Sonnet's one run per kind is the weaker figure. The scenarios are synthetic and written by the same hand as the system, so this compares models on this benchmark, not on real disputes.

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

Merchant and agent-provider names are invented.

## Layout

```
server/            Mozaik engine
  agents/team.ts     every participant and its situation handlers
  agents/tools.ts    read_evidence, submit_finding, issue_ruling
  agents/network.ts  attack signatures: what the network learns and recognises
  agents/verify.ts   citation checking
  model/             scripted stand-in, the guarded runner, and local model servers
  data/              synthetic world and scenarios
web/src/           React + three.js client
  views/Globe.tsx      the network as a globe
  ui/CaseStage.tsx     a case: the charge taken apart, and the agent's steps
  ui/CasePanels.tsx    the case's records, investigators, verdict and what-if
  ui/LivePanels.tsx    the Cases, Network and Risk pricing tabs
shared/types.ts    types shared by both
scripts/proof.ts   headless run
tests/             node:test suites, run with npm test
```

## Known gaps

- The live eval has been run once per kind, on Claude only. Gemini's free tier allows 20 requests a day per model, and a case takes 10 to 15, so a free key runs about one case per model per day; a rehearsal of the whole demo needs a paid key. `MAX_RPM` paces calls for low quotas, and `INVESTIGATOR_MODEL` / `ARBITER_MODEL` pick the models.
- Not exercised in a browser yet: the evidence-pack download and the sound cues.
- Mozaik's loop runs only the first tool call of a model response. When a model asks for several at once, the guarded runner ([server/model/guard.ts](server/model/guard.ts)) hands the rest to the loop one at a time, so each is run, intercepted and recorded without another model call. This is covered by a test against Mozaik's loop with a scripted model, but not yet by a real provider: the scripted stand-in only ever returns one call per inference.
- Nothing is persisted: restarting the engine starts a new run.
- The UI is built for desktop widths (about 1,300 px and up is best).
