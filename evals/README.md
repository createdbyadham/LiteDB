# Text-to-SQL evaluation harness

Measures whether LiteDB's Text-to-SQL agent produces SQL that **answers the
question**, across dialects and model providers, reproducibly.

Every number LiteDB publishes about its AI accuracy comes from this directory.
If a claim is not reproducible with the commands below, it should not be made.

## Quick start

```bash
npm run eval:selftest                  # verify the harness itself (no API calls)
npm run eval:verify                    # verify the golden set (no API calls)
npm run eval -- --provider ollama      # score a local model
npm run eval -- --provider openai --model gpt-4o-mini
```

Requires Node 24+ (`node:sqlite` is unflagged from 24 onwards). SQLite needs no
setup; Postgres needs `EVAL_POSTGRES_URL`.

## What is measured

**Execution accuracy.** The generated query and the reference query are both
executed against the same fixture database, and their result sets are compared.

This is deliberate. String similarity and AST comparison both punish correct
answers for being phrased differently — `EXISTS` instead of `IN`, a CTE instead
of a subquery, a different join order — and reward memorised surface form. What
a user cares about is whether the rows are right.

The tradeoff is that execution accuracy accepts a query that is right on this
fixture and wrong in general. That is why the fixture is designed with the
distinctions that matter (see *Ambiguity* below) rather than being random data.

### Comparison rules

| Rule | Behaviour | Why |
| --- | --- | --- |
| Column names | Ignored | The model may alias freely; `AS total` vs `AS sum` is not an error. |
| Column order | Significant | Projection order is part of what was asked. |
| Row order | Significant only when the question pins it | `ordered: true` on the case; otherwise rows are canonically sorted. |
| Numeric type | Normalised | Postgres `NUMERIC` (`'188.00'`) and SQLite `REAL` (`188`) must compare equal. |
| Floats | 6 decimal places | Stops `AVG()` drift from failing a correct answer. |
| `NULL` | Distinct from `0` and `''` | Collapsing them would hide real join bugs. |

### Outcome taxonomy

A single pass/fail number hides which problem you have, so failures are typed:

| Outcome | Meaning | Counted against the model |
| --- | --- | --- |
| `pass` | Result set matched the reference | — |
| `wrong_result` | Valid SQL, answered the wrong question | Yes |
| `invalid_sql` | Did not execute — bad syntax, unknown column | Yes |
| `guard_rejected` | Not a single read-only statement | Yes |
| `api_error` | Provider or transport failure | **No** — excluded from the denominator |

Separating `wrong_result` from `invalid_sql` matters: the first is a reasoning
failure, the second is usually a schema-context failure, and they are fixed in
completely different places. Excluding `api_error` matters because a rate limit
is not a model mistake, and letting it depress the score makes runs
incomparable.

## The fixture

A small storefront: `customers`, `categories`, `products`, `orders`,
`order_items`, `payments`, `reviews`. Seed data is hand-written and fixed, so
every run sees identical rows.

Both dialects load the same `seed.sql`; only the DDL differs.

### Ambiguity is deliberate

The schema is built so that a model cannot succeed by pattern-matching column
names:

- **`name`** exists on `customers`, `products` and `categories`.
- **`status`** exists on `orders` and `payments`, with overlapping values.
- **`created_at`** exists on `customers`, `products` and `reviews`.
- **`orders.total`** is denormalised and can disagree with the sum of its line
  items — and for exactly one order in the fixture, it does.
- **`products.price`** is current; **`order_items.unit_price`** is historical.
  They differ in the seed data, so "the price actually paid" is a real
  distinction rather than a trivia question.

The `ambiguous-schema` slice exists to measure precisely this, and it is the
slice that separates models most sharply.

## Slices

| Slice | Cases | Probes |
| --- | ---: | --- |
| `single-table` | 10 | Filters, projections, ordering, simple aggregates |
| `joins` | 10 | Inner/outer joins, anti-joins, `NOT EXISTS` |
| `aggregation` | 10 | `GROUP BY`, `HAVING`, multi-table aggregates |
| `window-functions` (dev) | 25 | Ranking and tie behaviour, `LAG`/`LEAD`, explicit `ROWS` frames, `NTILE`, `FIRST_VALUE`, percentiles, running totals, per-partition top-N |
| `ambiguous-schema` | 8 | Whether the right column was chosen at all |
| `window-functions` (**test**) | 18 | Held-out; `--split test`. Written after the exemplars, covering function surface rather than observed failures |

**81 cases today — 63 dev, 18 held-out test.** The target is 120; the harness does not change as cases are
added, since a case is a JSON object.

### Result: qwen2.5-coder:7b, SQLite, 63 cases

| Slice | Accuracy |
| --- | ---: |
| `single-table` | 100% (10/10) |
| `joins` | 100% (10/10) |
| `aggregation` | 100% (10/10) |
| `ambiguous-schema` | 87.5% (7/8) |
| **`window-functions`** | **52% (13/25)** |
| Overall | 79.4% (50/63) |

Overall accuracy is **not comparable across case-set versions** — expanding
`window-functions` from 6 to 25 cases moved that slice from 14% of the set to
40%, which pushed the overall number down even as per-slice accuracy improved.
Compare slices, not totals.

The window-function failures share one mechanism: the model **substitutes a
`GROUP BY` aggregate or a self-join for a window function**, then loses the
per-row output the question asked for. `wf-14` answers "each product and how
many products are in its category" with a `GROUP BY` returning 5 rows instead
of 12; `wf-16` and `wf-17` return `MAX(price)`/`MIN(price)` where the question
asked for the product *name*; `wf-07`, `wf-11`, `wf-18` and `wf-21` all reach
for self-joins.

A second, narrower failure repeats three times (`wf-03`, `wf-06`, `wf-21`): asked
for "the order id", the model writes `orders.order_id`. That column does not
exist on `orders` — but `order_id` *does* exist on `order_items`, so this is
cross-table name bleed rather than pure invention.

### Tested and rejected: qualified column names

The obvious fix for that bleed is to render columns as `orders.id` rather than
bare `id`, on the theory that bare names under a table header bind weakly.
`--qualified` implements it. Result over 63 cases:

| Schema format | Accuracy | Window slice | Avg prompt tokens |
| --- | ---: | ---: | ---: |
| Bare column names | 79.4% | 52.0% | 478 |
| `--qualified` | 81.0% | 56.0% | 519 |

The mechanism was confirmed where predicted: `wf-03` and `wf-06`, both
`orders.order_id` hallucinations, were fixed, and `wf-07` with them. But the
same failure moved rather than disappeared — `wf-02` **gained** `order_id`
having previously been correct, and `wf-10` swapped a working self-join for a
correlated subquery whose inner `orders.order_date` silently rebinds to the
inner table.

Net +1 case for +8.6% tokens on every request, with three fixed and two broken.
The intervention perturbs failures roughly at random with a slight positive
bias; it does not remove the class. **Not adopted as the default**, and the
flag is kept so the experiment can be re-run against a stronger model or a
larger case set, where the result may differ.

### Factorial test: directive vs execution-guided repair

Two interventions against the window-function failures, tested alone and
together on the same 63 cases.

- `--directive` adds anti-substitution guidance to the system prompt, steering
  toward window functions and away from GROUP BY and self-joins.
- `--repair N` feeds engine errors back to the model for up to N extra
  attempts. It fires **only on execution failure** — a query that runs but
  answers the wrong question produces no error, so there is nothing to repair.

| Arm | Accuracy | Window slice | Avg prompt tokens | Wall clock |
| --- | ---: | ---: | ---: | ---: |
| Baseline | 79.4% | 52% | 478 | 133s |
| `--directive` | 79.4% | 56% | 612 (+28%) | 145s |
| **`--repair 1`** | **81.0%** | **60%** | **514 (+7.5%)** | 146s |
| Both | 81.0% | 60% | 657 (+37%) | 143s |

One case (`jn-06`) is excluded from the comparison: it passes in the baseline
invocation and fails in all three arms on a byte-identical prompt, which makes
it a cross-invocation coin flip rather than an effect of either intervention.
Net of that, case by case:

| Arm | Fixed | Broken | Net |
| --- | --- | --- | ---: |
| `--directive` | `wf-06`, `wf-15` | `wf-19` | +1 |
| `--repair 1` | `wf-03`, `wf-06` | — | +2 |
| Both | `wf-03`, `wf-06`, `wf-15` | `wf-19` | +2 |

**Repair wins, and the directive adds nothing on top of it.** Both arms score
identically to repair alone while costing 37% more prompt tokens on every
request. Repair's cost is paid only by failures — 4 of 63 cases retried — so it
is a fraction of the directive's, which taxes all 63.

Two details worth keeping:

- The directive's regression is not a new failure class. `wf-19` broke by
  writing `orders.order_id`, the *same* cross-table bleed already documented
  above. The guidance perturbed a case that had been avoiding it rather than
  introducing anything novel — the same shuffling seen with `--qualified`.
- Repair's boundary is visible in `wf-21`. It was `invalid_sql`, got repaired
  into valid SQL, and landed on `wrong_result`: `SELECT customer_id, id AS
  order_id FROM orders ORDER BY customer_id, order_date DESC LIMIT 2` — a
  global `LIMIT 2` instead of two rows per customer. The error signal fixed the
  syntax and could say nothing about the logic. That is the technique working
  exactly as far as it can and no further.

Repair also cut `invalid_sql` from 3 cases to 1, which is the class it targets.
It leaves the dominant `wrong_result` class untouched, and nothing here reached
it — consistent with both prompt-level experiments above.

### Retrieved few-shot: the intervention that worked

`--fewshot K` retrieves up to K worked examples from `src/lib/fewShot.ts` and
injects them as conversational turns before the question. Retrieval is lexical
tag overlap — deterministic, no model load. Exemplars are written against an
**unrelated employees/departments schema**, so they teach the shape of an
answer and cannot leak one.

All arms below run with `--repair 1`:

| Arm | Accuracy | Window slice | Avg prompt tokens | Wall clock |
| --- | ---: | ---: | ---: | ---: |
| Baseline (no repair) | 79.4% | 52% | 478 | 133s |
| `--repair 1` | 81.0% | 60% | 514 | 146s |
| `--fewshot 2` | 87.3% | 76% | 671 | 152s |
| **`--fewshot 3`** | **90.5%** | **84%** | **666** | 153s |
| `--fewshot 4` | 90.5% | 84% | 680 | 164s |

**K=3 is the plateau.** A fourth exemplar buys nothing and costs latency.

Against `--repair 1` alone, three exemplars fixed `wf-07`, `wf-14`, `wf-15`,
`wf-16`, `wf-17`, `wf-18` and `wf-23`, and broke `wf-03` — net +6 cases. Those
seven are precisely the GROUP-BY-and-self-join substitutions that the directive,
the qualified schema and the sample values had all failed to move. `wrong_result`
fell from 11 cases to 2.

The contrast exemplar earned its place: `aggregation` and `single-table` both
stayed at 100%, so demonstrating window functions did not push the model into
using them where `GROUP BY` is correct — the exact regression the anti-
substitution directive caused.

#### Held-out validation

The dev numbers above are tuned-on. `evals/cases/window-holdout.json` is an
18-case `split: test` set written afterwards to cover **function surface rather
than observed failures** — weighted deliberately toward window functions no
exemplar demonstrates. Run it with `--split test`.

| Arm | Held-out accuracy |
| --- | ---: |
| `--repair 1` | 38.9% (7/18) |
| `--repair 1 --fewshot 3` | **55.6% (10/18)** |

Set against the dev slice, 52% → 84%:

**Roughly half the improvement generalises.** +32pp where the exemplars were
tuned, +16.7pp on questions they were not. Anyone quoting 84% as the method's
accuracy is quoting a number that includes its own tuning.

The interesting part is *which* cases few-shot fixed. Four of the five use
functions no exemplar contains: `NTILE` (`wh-02`), `PERCENT_RANK` (`wh-03`), a
window used as a filter (`wh-11`), and a centred `ROWS ... FOLLOWING` frame
(`wh-18`). The exemplars are not teaching syntax to copy — they are teaching
*that a window function is the right tool here*, and the model supplies the
function it needs. That is a stronger claim than pattern matching, and it is
what makes the technique worth keeping.

Two cases regressed, and both are demonstration bias rather than noise:

- **`wh-05`** wants a two-row frame. Without exemplars the model wrote the
  correct `ROWS BETWEEN 1 PRECEDING AND CURRENT ROW`. With them it pattern-
  matched the `LAG` exemplar into `amount + LAG(amount) OVER (ORDER BY id)` —
  wrong ordering column, wrong shape. A superficially similar exemplar pulled
  it off a correct answer.
- **`wh-08`** moved *toward* the better mechanism — a correlated subquery
  became a partitioned window — but dropped the `100.0 *` and added a stray
  column. Right tool, wrong projection.

So demonstrations carry a real cost: they transfer the nearest pattern, which
is wrong when the question is a near neighbour of an exemplar rather than an
instance of it. At K=3 the trade is clearly positive (5 fixed, 2 broken), but
it is a trade, not a free win.

#### Local vs cloud, on the held-out set

The same 18 held-out cases, two models, with and without exemplars:

| Model | `--repair 1` | `--repair 1 --fewshot 3` |
| --- | ---: | ---: |
| `qwen2.5-coder:7b` (local, 6 GB GPU) | 38.9% (7/18) | 55.6% (10/18) |
| `gpt-5.6-luna` (cloud) | 88.9% (16/18) | **94.4% (17/18)** |

Three things fall out of this.

**The privacy/quality gap is 50 points at baseline**, and few-shot does not
close it: a local 7B with exemplars still scores 33 points below a frontier
model without them. For window-function work on a 6 GB card, "run it locally"
costs real accuracy, and now there is a number attached to that rather than an
intuition.

**Retrieved few-shot is not only a small-model crutch.** It helped the cloud
model too, +5.6pp, which is a smaller absolute gain simply because there was
less headroom. The technique generalises upward; the size of the win does not.

**The entire `invalid_sql` class is a small-model problem.** Execution-guided
repair fired **zero times** across both cloud runs — the model never emitted
SQL that failed to execute. Repair earns its keep locally and is dead weight
against a frontier model, which is a routing argument, not an argument against
repair.

One case reverses direction and is worth recording. `wh-05` is where
demonstration bias hurt the local model, which copied the `LAG` exemplar
instead of writing an explicit frame. The cloud model gets `wh-05` **wrong
without exemplars and right with them** — it treats a near-neighbour exemplar
as guidance rather than a template. So demonstration bias is itself a
capability-dependent failure, not a property of the technique.

Cost of the exemplars on the cloud path: 482 → 683 prompt tokens, and 1.9s →
2.3s per query.

#### The caveat that matters

**The exemplar library was written after reading the failure list.** Its five
window exemplars map onto the observed failure modes almost one to one:
`COUNT(*) OVER` for `wf-14`, top-N-per-group for `wf-04`/`wf-21`, `LAG` for
`wf-06`/`wf-11`, `FIRST_VALUE` for `wf-16`/`wf-17`, running total for
`wf-02`/`wf-18`. That is tuning against the test set, and 84% on this slice is
therefore an **optimistic** estimate of what a user with an unseen question
would get.

What the number does support: these failures are reachable by demonstration
rather than being a hard capability ceiling. What it does not yet support: a
claim about unseen questions. Closing that needs held-out window cases written
without reference to the exemplars — the natural next use of the remaining
budget toward 120 cases, and the reason `--fewshot` is not on by default.

### Agreement with the reference is not the same as correctness

Running a frontier model against the set exposed three cases where the
*question* was defective, not the answer:

- **`ag-03`** — "the average review rating for each product name." The
  reference inner-joins, returning the 10 reviewed products. The model
  left-joined, returning all 12. Both readings are defensible.
- **`ag-05`** — same shape, with `COALESCE(..., 0)` for never-sold products.
  The model's reading is arguably the better one.
- **`wh-17`** — "each customer id, their order id, and the total of their most
  recent order" reads naturally as one row per customer, which is what the
  model produced. The reference returns one row per order.

All three were scored as failures. All three were mine.

The local model passed `ag-03` and `ag-05` only because it happened to share
the same assumption the reference encodes. That is the trap: a weaker model
agreeing with you looks like validation, and it is really just correlated bias.
**It took a stronger model to reveal that the golden set silently encodes one
particular reading of an ambiguous question.**

The fix is to disambiguate the question, never to relax the reference toward
whatever the model produced — that would turn the benchmark into a record of
model behaviour rather than a test of it. `wh-17` is a held-out case, so
correcting it means it has now been looked at; that is defensible for repairing
a broken instrument, but it is not a licence to tune.

Practical consequence for anyone extending the set: if two competent engineers
could read a question two ways, the case is broken, and you will not find out
until a model is good enough to pick the other one.

## Sample values

The schema context includes a few distinct values for columns that are genuine
enumerations, because names and types alone cannot resolve them: asked for
"customers in Germany" against a column storing `'DE'`, the model can only
guess. Eligibility is decided in `src/lib/schemaSamples.ts` — shared with the
app, so the benchmark measures what ships.

Selection is deliberately narrow, and the first implementation was not narrow
enough. It emitted every customer name, every product name, review free text
and — because SQLite stores dates in `TEXT` columns — every date, tripling the
prompt and putting personal data in it. The current rules require a column to
have fewer distinct values than the table has rows (a unique `name` column in
an 8-row table is an identifier, not an enum), reject date-shaped and
prose-shaped values, and skip columns whose names suggest secrets or PII.

Measured on `qwen2.5-coder:7b` / SQLite, temperature 0, on the 44-case set that preceded the window-function expansion:

| Schema context | Accuracy | Avg prompt tokens |
| --- | ---: | ---: |
| Names and types only (`--no-samples`) | 84.1% | 433 |
| Curated sample values | 86.4% | 475 |
| Unfiltered sample values (rejected) | 90.9% | ~1270 |

The curated setting fixed exactly the two cases it was designed to fix
(`st-01`, `jn-09` — both country-code lookups), and regressed one unrelated
join (`jn-06`), for a net of one case.

That regression is worth being precise about. It was real and repeatable *on
the 44-case set* — `jn-06` passed with `--no-samples` and failed with samples,
deterministically. But on the 63-case set it passes with samples. Same prompt,
different outcome, because the surrounding request sequence differs. So it is
better read as **prompt-sensitivity on a knife-edge case than as a systematic
regression**: the two country-code fixes are the durable result, and the third
case is a coin that this prompt change happened to flip.

The unfiltered row is the honest awkward result: it scored highest. It is
rejected anyway because it leaks personal data and triples prompt cost, but it
raises a real question this harness cannot yet answer — whether the gain came
from the *values* or simply from more schema text reinforcing table structure.
Distinguishing those needs a padding control, and a larger golden set than 44
cases before any of these differences should be treated as settled.

## Safety

The harness executes text produced by a language model, so it assumes that text
is hostile. Two independent layers:

1. **Static guard** (`src/guard.ts`) — the statement must be a single statement
   beginning with `SELECT` or `WITH`, with no write keyword anywhere in it after
   comments and quoted spans are blanked out. Whole-statement matching is
   required because Postgres permits data-modifying CTEs.
2. **Engine enforcement** (`src/fixture.ts`) — SQLite runs on a read-only
   connection to a throwaway temp file; Postgres runs every query inside a
   `BEGIN READ ONLY` transaction that is always rolled back.

Either layer alone is insufficient, and the self-test asserts both. The guard's
keyword scan was silently dead when first written — a `\b` in a template literal
is a backspace character, not a word boundary — and the self-test is what caught
it. That is the argument for testing your measuring equipment.

## Reproducibility

- **Frozen clock.** The prompt embeds a date. It is pinned (`EVAL_DATE`,
  default `2024-09-01`) so a case that depends on "this year" cannot start
  failing in January.
- **`temperature: 0`, `top_p: 1`**, matching the shipped app.

  Measured on this setup, reproducibility is better than expected but has a
  sharp edge. `--repeat 3` over 63 cases produced **0 flaky cases and sd
  0.0pp**, twice. Two separate invocations of the same case set also matched
  exactly. But one case (`jn-06`) failed in the 44-case runs and passed in the
  63-case runs on a byte-identical prompt.

  The pattern that fits: results are reproducible **for a fixed case set**, and
  change only when the sequence of requests around a case changes — consistent
  with server-side KV-cache reuse rather than sampling. So an A/B on the same
  case set is trustworthy; a number compared across case-set versions is not.

  **`--repeat N` therefore measures within-invocation stability, not the noise
  that actually matters.** It loops inside one process against a warm model, so
  at temperature 0 it will almost always report zero variance. It earns its
  keep against hosted providers and any temperature above 0; for cold-start
  variance, run the CLI separately with different `--tag` values and compare.
- **Shared prompt code.** The harness imports `buildTextToSqlMessages` from
  `src/lib/promptBuilder.ts` — the same function the desktop app calls. If it
  grew a Tauri or DOM dependency the harness would stop measuring shipped
  behaviour, which is why that module is kept free of both.
- **References verified first.** Every reference query is executed before any
  model call. A broken reference fails the run in about a second instead of
  after paying for a full set of completions, and can never be misreported as
  a model failure.

## Adding a case

Append to the relevant file in `cases/`:

```json
{
  "id": "ag-11",
  "slice": "aggregation",
  "difficulty": "medium",
  "question": "Which customers spent more than 500 in total?",
  "sql": "SELECT c.name FROM customers c JOIN orders o ON o.customer_id = c.id GROUP BY c.name HAVING SUM(o.total) > 500",
  "ordered": false,
  "notes": "Optional: record the trap the case is testing."
}
```

Use the object form of `sql` (`{ "sqlite": "...", "postgres": "..." }`) only
when the dialects genuinely diverge. Then run `npm run eval:verify`.

Two rules: the question must be answerable from the schema alone, and the
reference must be *a* correct answer — not the only one. The comparator accepts
any query producing the same rows.

## CLI

| Flag | Default | Meaning |
| --- | --- | --- |
| `--provider` | `ollama` | `openai`, `github`, `azure`, `ollama` |
| `--model` | provider default | Model override |
| `--dialect` | `sqlite` | `sqlite` or `postgres` |
| `--slice` | all | Restrict to one slice |
| `--difficulty` | all | `easy`, `medium`, `hard` |
| `--limit` | all | Cap the number of cases |
| `--concurrency` | `4` | Parallel in-flight requests |
| `--tag` | derived | Output filename stem |
| `--no-samples` | off | Omit sample values from the schema context (A/B control) |
| `--qualified` | off | Render columns as `table.column` (A/B; see *Tested and rejected*) |
| `--repeat` | `1` | Repeat the set N times; reports mean, range and flaky cases |
| `--directive` | off | Add anti-substitution guidance (A/B; see *Factorial test*) |
| `--repair` | `1` | Extra attempts after an engine error (execution-guided repair) |
| `--no-repair` | off | Disable repair (A/B control) |
| `--fewshot` | `0` | Retrieve K worked exemplars into the prompt (see *Retrieved few-shot*) |
| `--split` | all | `dev` or `test`. Never tune against `test` |
| `--verify-references` | off | Check the golden set and exit |

`npm run eval:schema` prints the schema block exactly as the model receives it,
which is the fastest way to see what a prompt change actually did.

### Credentials

| Provider | Environment |
| --- | --- |
| `openai` | `OPENAI_API_KEY` |
| `github` | `GITHUB_MODELS_TOKEN` or `GITHUB_TOKEN` |
| `azure` | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT` |
| `ollama` | none (`OLLAMA_HOST` to override the endpoint) |

Results are written to `results/<tag>.json` and `results/<tag>.md`.

## CI

- **Every pull request** runs the self-test and golden-set verification. No
  credentials, no cost.
- **Nightly** runs the scored eval on both dialects and uploads the reports.
