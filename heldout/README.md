# Held-out cases

The generated scenarios were written by the same hand as the system, so a good score on them proves little. These are cases written by **someone who has not read the code or the scenario generator**. The team is scored on them, and so is a one-prompt baseline, to see whether the multi-agent design earns its cost.

## For the person writing cases

Write each case as the stored records of one AI-agent purchase, plus what you believe the fair split is. Put them all in `heldout/cases.json`, as a list like [example.json](example.json). The two cases in the example are only there to show the format. Don't copy them, and don't put them in `cases.json`.

Aim for **12 cases**: every kind below at least once, some as disputes and some as holds. Vary the items, amounts, cities and wording. A few should be genuinely hard: two parties at fault, a claim that is half true, a fault that only one field gives away.

| Kind of fault | Who pays |
|---|---|
| The agent went outside its instruction: price, quantity, category, colour, an add-on, or it was tricked by text on a page | `agent_provider` |
| The merchant charged more than it listed, or added a fee it didn't disclose | `merchant` |
| Someone else used the agent: another device, far away, an old token | `fraud` |
| The purchase was fine and the customer is wrong (or lying) | `customer` |
| More than one of the above | split between them |

### Each case

| Field | What to write |
|---|---|
| `name` | A short unique id, e.g. `colour-swap` |
| `stage` | `"dispute"`: the money has moved and the customer complains. `"hold"`: the payment is stopped before it settles, with no claim yet |
| `truth` | Your split: `customer`, `agent_provider`, `merchant`, `fraud`, whole numbers adding to 100. **The team never sees this** |
| `mandate` | What the owner told the agent. Must have `instruction`, `max_amount`, `quantity`, `category` |
| `trail` | The agent's steps in order. Each has a `kind` (`search`, `view`, `compare`, `select`, `addon`, `cart`, `checkout`, `session`) and a `note`; add any detail fields (`observed_price`, `item`, `hidden_text`, …). `"actor": "unknown"` marks a step that wasn't the owner's agent |
| `listing` | What the merchant advertised. Must have `title`, `merchant`, `listed_price`, `fees_disclosed` |
| `order` | What was (or is about to be) charged. Must have `title`, `merchant`, `category`, `quantity`, `unit_price`, `fees`, `addons`, `total` |
| `session` | Where the checkout came from. Must have `issued_device`, `checkout_device`, `same_device` |
| `delivery` | Disputes only: what happened after (`delivered`, `address_match`, `post_purchase_activity`) |
| `claim` | Disputes only: the customer's complaint, in their words |

You can add any other fields to any record. Values must be text, numbers, `true`/`false` or `null`.

**One rule for holds:** a payment is only held if something looks off: the total is above the limit, there are more units than asked for, the price is above the listing, there's a fee the listing didn't disclose, the category is different, the device is different, or it's the agent's first purchase at that shop. If none of those is true, the checker will tell you, because the team would never see the case.

## Running it

Check the file without spending anything (the stand-in model, free):

```bash
EVAL_CASES=heldout/cases.json BLACKBOX_MODE=scripted npm run eval
```

The team on Haiku 4.5, each case twice, stopping at $3:

```bash
EVAL_CASES=heldout/cases.json BLACKBOX_MODE=live INVESTIGATOR_MODEL=claude-haiku-4-5 ARBITER_MODEL=claude-haiku-4-5 SPEND_CAP_USD=3 npm run eval -- 2
```

The one-prompt baseline on the same cases:

```bash
EVAL_CASES=heldout/cases.json BLACKBOX_MODE=live BASELINE_MODEL=claude-haiku-4-5 SPEND_CAP_USD=0.5 npm run baseline -- 2
```

Both print the dollars spent at list prices and write every case to `eval-results/`. The cap stops new model calls once it is reached. Calls already under way still finish, so a run can go a few cents over.
