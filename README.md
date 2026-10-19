# e2e

Developer journey end-to-end tests for Demeter, run against production, and the
contract checks that fail when website2, the Console and fabric drift apart in
production.

**This repository tests live surfaces only.** It reads what is deployed, over
HTTP and in a browser, and nothing else: it clones, vendors and reads no
product repository, and it gates no other repository's pull requests. Each
product repository keeps its own static checks. Drift between surfaces is
caught here, afterwards, against production.

Today it holds the harness and three contract checks. The journeys (a person's
path from `demeter.run` to a first request, and an agent's) build on the same
harness.

Every check is **report-only**: a failure shows on this repository's pull
requests or alerts from a scheduled run, but nothing here is a required status.

## Setup

Node 22 (`.nvmrc`) and pnpm (the version in `package.json`'s
`packageManager`; `corepack enable` provides it). No credentials: every
surface the checks read is public.

```sh
pnpm install
pnpm exec playwright install chromium   # for intent's last two steps
```

## Running a check

```sh
pnpm check pricing --env production         # one check
pnpm check intent,apex --env production     # several
pnpm check all --env production             # every check
```

| Option | Effect |
| --- | --- |
| `--env <name>` | The environment to check. Required. |
| `--alert` | Post one IRM alert per failed check, when `IRM_E2E_WEBHOOK_URL` is set; otherwise log that the alert was skipped. |
| `--force-fail` | Add a check named `force-fail` that fails on purpose, to prove the alert path. |
| `--results <dir>` | Where result files go (default `results/`). |

Environments are named in `src/env.ts`. `production` is the only one:
`https://demeter.run` (website2), `https://console.demeter.run`,
`https://legacy.demeter.run`, `https://rpc.demeter.run` (fabric's gRPC-web
API) and the Auth0 tenant `https://txpipe.us.auth0.com`.

## The checks

### `pricing`

The deployed surfaces that state a price agree:

| Surface | Read from | Shape |
| --- | --- | --- |
| fabric (what is billed) | `MetadataService/FetchMetadata` on `https://rpc.demeter.run`, gRPC-web, no auth | per kind, `plan.<tier>.cost.{minimum, delta}`: USD per month, USD per metered unit |
| website2's table (what a visitor reads) | `GET https://demeter.run/pricing` | one section per port; rows `MINIMUM FEE` and `PER 100K REQUESTS` / `PER 100K MESSAGES`, one display string (`$0.30`) per plan column |
| website2's landing cards | `GET https://demeter.run/` | a tier card per plan: a price, `per 100k requests`, and a note stating the minimum fee |

The Console's prices render only on signed-in pages, so its leg runs inside the
J2 journey, with the same comparator (`compare` in `src/surfaces/card.ts`). A
resource's pricing page quotes that resource's port only, so J2 names the
ports its surface owes: `compare(billed, { console }, { owes: { console:
['blockfrost'] } })`.

Each surface is reduced to one card per port and tier,
`{port, tier, minimum_usd, per_100k_usd}`, where `per_100k_usd` is USD per
100,000 of the port's metered unit (requests, messages, submits, or seconds of
open connection: a day of connection is 86,400 units). Tiers are fabric's:
`0` Free, `1` Flexible, `2` Pro I, `3` Pro II. Ogmios's tier `4` is off the card
(decision 0024) and compared with nothing. The landing cards price "all APIs,
one rate", so they are read as a quote for every port the `/pricing` table
lists. The pages are read as text: their server-rendered HTML carries NUL
bytes, and no browser is needed.

The check fails, printing one line per divergence that names the port, the
tier and each surface's value, when:

- a surface charges for a port and tier that fabric bills nothing for (no
  `cost` block, no such tier or no such port), which is how UTxO RPC was quoted
  and never billed;
- Ogmios, Kupo, Blockfrost or UTxO RPC, on tiers 1–3, is not priced by the
  `/pricing` table or the landing cards, or is priced with no minimum fee;
- a minimum fee or usage rate differs between any surfaces that state it.
  fabric stores rates to four significant digits, so values within 0.1% are the
  same;
- one surface states a port and tier more than once (two `/pricing` sections
  for Blockfrost, say), which would otherwise be compared on its last price
  only.

A port name, plan column, unit, price row or minimum-fee wording the readers
cannot place (`src/surfaces/ports.ts`, `src/surfaces/website2.ts`) also fails
it: each port in the table needs exactly one `MINIMUM FEE` row and one `PER …`
row, and each landing card a note reading "No minimum fee" or "Minimum fee
$…". A relabelled row read as no price would let the comparison skip it. A
table cell the reader cannot read (`1.7M`, `Free`) fails naming its port, row
and column. A failure that production causes is not suppressed: it stays red
and alerts.

A reader that fails fails its own step, and the `compare` step still compares
the surfaces that were read, naming the ones it could not: a reworded landing
card does not hide a divergence between fabric and the `/pricing` table.

**fabric does not publish its prices yet.** A live `FetchMetadata` record
carries only `options` (field 1) and `crd` (field 2); the per-tier `plan` that
fabric bills from is not serialised. Until fabric serves it, `pricing` fails
its first step with:

```
fabric's live metadata publishes no prices: none of its 12 FetchMetadata records carries a plan, only options and crd
```

and still compares website2's table with its landing cards. The reader takes
the plan from field 3 of each record, a JSON string of the same
`{"<tier>": {"dns", "cost": {"minimum", "delta"}}}` map fabric keeps per kind.

On the numbers before the rate-card rollout (the parents of fabric#272 and
website2#10, normalised in `test/fixtures/cards/`), the comparator fails with
22 divergences, among them the 4.7× Blockfrost one:

```
Blockfrost Flexible per 100k: fabric $0.06 · website2 landing $0.28
```

### `intent`

`intent=signup` is a string shared by two deployables: website2 builds it into
its sign-up CTAs, and the Console's login route turns it into Auth0's
`screen_hint=signup`. Neither side fails when the other changes.

From `https://demeter.run/` and `/pricing`, read as text:

- every link to `https://console.demeter.run/login` sends no `intent` or
  `intent=signup`, the one value the Console honours;
- every sign-up CTA, by its visible text (sign up, start building, get
  started, start free), goes to `/login?intent=signup`, and there is at least
  one;
- every sign-in link (sign in, log in) goes to `/login` with no query.

A link whose target is not a URL, which a browser cannot follow either, fails
the rule its text puts it under rather than being skipped.

From the Console:

- `GET /login?intent=signup` redirects to Auth0's `/authorize` with
  `screen_hint=signup`, and `GET /login` without it (the redirect is read, not
  followed);
- in Chromium, the first lands on Auth0's signup form and the second on its
  login form, told apart by the screen's path, page title and heading (recorded
  in `src/checks/intent.ts`). This is the login-versus-signup edge case:
  Classic Universal Login drops `screen_hint` silently. A page with no heading
  (an Auth0 error or rate-limit page) fails naming where the browser landed,
  the status it answered and its title.

### `apex`

The apex contract from the cutover-apex skill's `cutover.sh verify`, one
assertion per probe, with the same semantics: one request on its own
connection, as one curl per probe, no redirect followed, 15 s to answer (20 s
for the page body). As curl prints the status it received even when the body
then stalls, a status is kept once it arrives; only a read that needs the body
fails when the body does not finish, and says so. A `Location` that is not a
URL fails the probe that received it. A `Location` is compared by origin and
path, as it is printed. Every page and redirect any check requests goes
through the same `probe` (`src/http.ts`); fabric's `FetchMetadata`, which
needs HTTP/2, is the one request that does not, and it reports a stalled body
or a refused connection the same way (`src/surfaces/fabric.ts`).

| # | Request | Expected |
| --- | --- | --- |
| 1 | `GET https://demeter.run/` | body has `modulepreload" href="/assets/` (website2; the legacy app serves `/build/_assets/`) |
| 2 | `/pricing` | 200 |
| 3 | `/auth` | 302 to the Auth0 tenant's `/authorize` |
| 4 | `/callbacks/auth0` | 302 to `https://demeter.run/error` (the legacy callback's failure branch, without a code) |
| 5 | `/webhooks/stripe` | anything but 404 or no answer |
| 6 | `/install/dmtrctl.sh` | 302 to the latest `dmtrctl-installer.sh` release asset |
| 7 | `/faq` | 301 to `https://legacy.demeter.run/faq` |
| 8 | `/ports/cardano-ogmios-port` | 301 to `https://legacy.demeter.run/ports/cardano-ogmios-port` |
| 9 | `/assets/logos/favicon.ico` | 200 |
| 10 | `https://legacy.demeter.run/faq` | 200 |

## Results and alerts

Every check and journey writes `results/<name>.json`:

```json
{
  "name": "apex",
  "env": "production",
  "started_at": "2026-10-19T16:05:53.871Z",
  "finished_at": "2026-10-19T16:05:58.271Z",
  "ok": true,
  "steps": [{ "name": "https://demeter.run/pricing answers 200", "ok": true, "ms": 248, "detail": "200" }]
}
```

The run is printed to the terminal and, in GitHub Actions, appended to the job
summary. With `--alert` and `IRM_E2E_WEBHOOK_URL` set, each failed result posts
one IRM alert, `{alert_uid: "e2e-<name>", title, message, state: "alerting",
link_to_upstream_details}`, the shape fabric's `send_irm_alert` uses.

Nothing secret goes in a result, a summary or an alert: URLs are reduced to
origin and path (`src/http.ts`), and the webhook URL is never printed.

The harness for later pieces is `src/env.ts` (environments), `src/report.ts`
(`Run`, result files, the summary, alerts), `src/http.ts` (requests that never
follow a redirect), `src/html.ts` (server-rendered pages as text) and
`src/surfaces/` (the card, its comparator and each surface's reader). Browser
journeys go under `journeys/`, run by `playwright.config.ts`.

## Unit tests

```sh
pnpm test
pnpm typecheck
```

The readers are tested on responses and pages captured from production, and
the comparator on the pre-rollout numbers; `test/fixtures/README.md` says
where each came from. A variant is a copy of a captured page with one edit.
Requests, alerts and the `pricing` check end to end run against local servers
serving those captures (an HTTP/2 one for fabric), `apex` against a local apex
answering as production does, intent's browser steps against a stand-in page,
and `pnpm check` itself against stand-in checks, so no unit test reaches
production.

## Workflows

`.github/workflows/contracts.yml` runs:

- on `pull_request` and on `push` to `main`: install, typecheck and unit tests
  in the `unit` job, then `pnpm check all --env production`, no alert, in the
  `checks` job that needs it. The checks fail on every run while fabric
  publishes no prices, so a broken unit test fails a job of its own;
- daily at 05:00 UTC and on `workflow_dispatch`:
  `pnpm check all --env production --alert`. The dispatch takes a boolean
  `force_fail` input that makes the run fail on purpose. Only runs of `main`
  receive the webhook, so a dispatch on another branch logs that its alert was
  skipped;
- when one of those alerting runs fails before the checks start (anywhere in
  the `unit` job, or the `checks` job's checkout, install or Chromium
  install), one IRM alert with `alert_uid` `e2e-setup`, naming the step that
  failed: the checks did not run, so none of them alerts. The `setup-alert`
  job posts it with `curl` and `jq`, needing no checkout or Node, which may be
  what failed.

Any job that signs in as the standing test user sets the concurrency group
`production-test-user` (`cancel-in-progress: false`), so no two runs use the
user at once. None does yet.

### Secrets

| Name | Used by | For |
| --- | --- | --- |
| `IRM_E2E_WEBHOOK_URL` | scheduled and dispatched runs of `main` | the IRM integration alerts post to |
| `E2E_USER_PASSWORD`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET` | the journeys | signing in as the standing test user |
