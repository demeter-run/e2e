# e2e

Developer journey end-to-end tests for Demeter, run against production, the
contract checks that fail when website2, the Console and fabric drift apart in
production, and the daily port suite that creates each kind of port and checks
it answers from the chain tip.

**This repository tests live surfaces only.** It reads what is deployed, over
HTTP and in a browser, and nothing else: it clones, vendors and reads no
product repository, and it gates no other repository's pull requests. Each
product repository keeps its own static checks. Drift between surfaces is
caught here, afterwards, against production.

Today it holds the harness, three contract checks, the port suite and J2, a
person's path from `demeter.run` to a first request. The port suite and J2 are
the parts that write: as the standing test user, the port suite creates a
project and its ports through fabric's API, and J2 a project and a port
through the Console, and each deletes them. The agent's journey builds on the
same harness.

Every check is **report-only**: a failure shows on this repository's pull
requests or alerts from a scheduled run, but nothing here is a required status.

## Setup

Node 22 (`.nvmrc`) and pnpm (the version in `package.json`'s
`packageManager`; `corepack enable` provides it). `pnpm test` also runs the
J2 workflow's scripts as the runner does (bash with `-e` and `pipefail`, the
workflow's `shell: bash`), so it needs `bash`, `curl` and `jq` on `PATH`;
without `curl` or `jq`, the alert script's test fails naming the missing
tool. The checks need no
credentials: every surface they read is public. The journeys sign in as the
standing test user, `e2e@txpipe.io` (decision 0047), whose password is
`E2E_USER_PASSWORD`. The port suite signs in too (see
[its section](#the-port-suite)).

```sh
pnpm install
pnpm exec playwright install chromium   # for intent's last two steps and the journeys
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

## The port suite

```sh
pnpm ports --env production      # takes --alert, --force-fail and --results as pnpm check does
```

It replaces fabric's daily `test/e2e` (and its `.github/workflows/e2e.yml`),
doing what that script did, with a gRPC client instead of `grpcurl` and the
node-to-client protocol instead of `socat` and `cardano-cli`:

1. **Sign in** as the standing test user, `e2e@txpipe.io` (decision 0047):
   Auth0's password grant on `https://txpipe.us.auth0.com/oauth/token`,
   audience `demeter-api`, with `E2E_USER_PASSWORD`, `AUTH0_CLIENT_ID` and
   `AUTH0_CLIENT_SECRET`. Without a token the run ends here.
2. **Create a project**, `e2e project`, with fabric's
   `ProjectService/CreateProject` on `rpc.demeter.run:443` (native gRPC),
   allowed a minute so a slow commit is not a project the run never learns
   the id of. Without one the run ends here. The run then reads
   `FetchProjects`, the Console's list, until it lists the project: a
   project that never shows there would make step 4's check pass vacuously.
3. **Create each port kind** in that project, mainnet, tier 0, with
   `ResourceService/CreateResource`, then read it back with
   `FetchResourcesById` until its spec carries its key (`authToken`), and
   **check it answers**:

   | Kind | Spec | Passes when |
   | --- | --- | --- |
   | `CardanoNodePort` | `version: stable` | a node-to-client connection over TLS to `<key>.cnode-m1.demeter.run:9443` reports a tip whose `syncProgress` (as `cardano-cli query tip` computes it) is 99–100 |
   | `BlockfrostPort` | `operatorVersion: 1` | `GET https://<key>.blockfrost-m1.demeter.run/blocks/latest` answers a `slot` at the chain tip |
   | `KupoPort` | `pruneUtxo: true`, `operatorVersion: 1` | `GET https://<key>.mainnet-v2.kupo-m1.demeter.run/health` answers a `most_recent_checkpoint` at the chain tip |
   | `OgmiosPort` | `version: 6` | `GET https://<key>.cardano-mainnet-v6.ogmios-m1.demeter.run/health` answers a `lastKnownTip.slot` at the chain tip |
   | `UtxoRpcPort` | `operatorVersion: 1` | `QueryService/ReadParams` on `mainnet.utxorpc-v0.demeter.run:443`, key in `dmtr-api-key`, answers a `ledger_tip.slot` at the chain tip |
   | `SubmitApiPort` | `operatorVersion: 1` | `POST https://<key>.submitapi-m1.demeter.run/api/submit/tx` with an empty CBOR body answers 400 |

   The node goes first: "at the chain tip" means at or past the node's slot
   less 120. When the node's port is not created or not synced, the others
   report the slot they answered and fail, as there is no tip to compare it
   with. fabric's Mumak
   and DbSync checks were commented out, and are not here.
4. **Delete the project**, pass or fail, with `DeleteProject` on the id step 2
   returned, and only that one: deleting it deletes its ports. A failed delete
   names the project it left behind. fabric deletes
   by an event, so the run then reads `FetchProjects`, the Console's list,
   until the project is gone.

The retry budget is fabric's: five tries, three seconds before each (the node
check's waits double from three seconds; the Submit API's come between
tries). A kind that fails does not stop the others, and a request that gets
no answer names why (DNS, a refused connection, TLS). The run is one result,
`results/ports.json`, one step per action above, and alerts once, as
`e2e-ports`. A `--force-fail` run adds the harness's `force-fail` check, so
it alerts as `e2e-force-fail`, the same alert a forced `pnpm check` run
posts.

The access token, the three credentials and every port's key are never
written: a step's detail has each replaced with `***` (`Run.conceal` in
`src/report.ts`), and in GitHub Actions they are masked in the log too.

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

A journey's result also carries `elapsed_seconds` when it has a stopwatch: J2's
seconds from landing on the site to the first successful request.

The run is printed to the terminal and, in GitHub Actions, appended to the job
summary. With `--alert` and `IRM_E2E_WEBHOOK_URL` set, each failed result posts
one IRM alert, `{alert_uid: "e2e-<name>", title, message, state: "alerting",
link_to_upstream_details}`, the shape fabric's `send_irm_alert` uses.

Nothing secret goes in a result, a summary or an alert: URLs are reduced to
origin and path (`src/http.ts`), and the webhook URL is never printed.

The harness for later pieces is `src/env.ts` (environments and their test
user), `src/report.ts` (`Run`, result files, the summary, alerts),
`src/secrets.ts` (what is redacted), `src/http.ts` (requests that never
follow a redirect), `src/html.ts` (server-rendered pages as text),
`src/surfaces/` (the card, its comparator and each surface's reader) and
`src/journeys/` (Auth0's sign-in, the Console's pages, requests to a port,
and the step runner a spec shares). Browser journeys go under `journeys/`,
run by `pnpm journey` through `playwright.config.ts`.

## Journeys

A journey drives Chromium through production as a person does, signed in as
the standing test user:

```sh
read -s E2E_USER_PASSWORD && export E2E_USER_PASSWORD   # typed, never in the shell history
pnpm j2 --env production                                # pnpm journey j2 --env production
```

It takes the same `--env`, `--alert`, `--force-fail` and `--results` options
as `pnpm check`. `pnpm journey <name>` runs the spec under `journeys/` with
Playwright, then prints its results, appends the job summary and alerts as
the checks do. A journey's results are its verdict: each test records its
steps and does not throw, because Playwright replaces its worker, and the
signed-in browser the tests share, after any failed test. The spec fails the
Playwright run once, last, naming the results that failed. A test Playwright
ends anyway, by its timeout or an error outside a step, fails its result: the
step it was in reads "did not finish", and a step says how the test ended.
Every action has a 30-second limit and every navigation a 60-second one
(`playwright.config.ts`), so a click that cannot happen fails its step rather
than hold it until the test's timeout.

**What it costs and leaves behind.** J2 deletes every project the test user
owns before it starts and after it ends, pass or fail, so it must not overlap
another run signed in as the user. The concurrency group below keeps this
repository's runs apart. Fabric's daily e2e runs as the same user from
another repository: scheduled at 12:00 UTC, GitHub has started it as late as
21:07 UTC, so a pull request's J2 can overlap it, and its clean-up then
deletes that run's project too. J2 itself deploys only into "My First
Project": a Console that lands on another project fails the first-project
step, and the port step does not run. In between it creates "My First
Project" and one Free Blockfrost port on preprod: about $0 a run. The
request, its usage and its cost appear in production data under the test
user.

**Secrets.** The password and the port's key never reach a result, a log, a
summary or an alert: they are kept secret (`src/secrets.ts`), every step's
detail is redacted, a browser error is cut to its first line, and the key
travels only in the `dmtr-api-key` header. A failed step leaves a screenshot
(`results/<name>-<step>.png`; J2's clean-up's is
`j2-clean-up-worker-<n>-01.png`) with the password field and the port's key
painted over. A screenshot never replaces another: a name already taken gets
`-2`, and `pnpm journey` clears the journey's screenshots from an earlier run
with its results. The key's masks are found independently (`keyMasks` in
`src/journeys/console.ts`): any text of a key's shape, the value of each row
that writes the key ("Auth Token" and "Authenticated Endpoint URL"), the
"Instance info" section, and the key itself once it is read. So the key
stays covered while any two of the section's heading, the rows' labels and
the key's shape drift. Playwright's traces stay off: they record what is typed, the
cookies sent (the Console's session is a signed Auth0 access token) and every
response body, the key included, and none of that can be masked.

### `j2`

`demeter.run` to a first successful request, then its usage and cost in the
Console. The test user signs in where a person would sign up (decision 0047),
so the elapsed time is a lower bound for a person: it leaves out filling the
signup form.

| # | Step | Passes when |
| --- | --- | --- |
| 1 | Clean slate | the user signs in at the Console's `/login`, every project it owns is deleted, and it signs out with the sidebar's sign-out link once the Console's app has started, through Auth0's `/v2/logout` (loading the Console's `/logout` as a page loops). A click that goes nowhere is clicked once more, and the detail says so. Before the stopwatch. |
| 2 | Land | `https://demeter.run/` answers 200 (the stopwatch starts) and its "Pricing" link opens `/pricing` |
| 3 | Price | `/pricing` renders a Blockfrost Flexible "PER 100K REQUESTS" price, recorded in the detail |
| 4 | Sign up | the page's sign-up CTA requests `console.demeter.run/login?intent=signup` and lands on Auth0's signup screen; its "Log in" link leads to the login form, where the user signs in |
| 5 | First project | the Console lands on `/{namespace}/ports` of "My First Project" |
| 6 | Port | "ADD PRODUCTS" → Blockfrost → `cardano-preprod` (Free) → "DEPLOY" shows the success toast; the port's page shows its endpoint and key |
| 7 | First request | `GET <endpoint>/epochs/latest` answers 2xx within 3 minutes. The stopwatch stops: `elapsed_seconds` in the result and the summary |
| 8 | Usage, then cost | the port's usage view counts a request within 5 minutes, then the billing page's "Project Usage" lists the port within 75 (fabric's daemon reads Prometheus every 3600 s), with the units fabric counted, which read 0 for J2's one request |
| 9 | Console price | the port's pricing page quotes Blockfrost as fabric bills it, through the `pricing` check's comparator |
| 10 | Clean up | pass or fail, every project the user owns is deleted, and the Console then names none |

Steps 1 and 10 delete through the form behind the project settings' "DELETE"
button, reading the Console's redirect rather than following it: after the
last project the Console redirects to `/`, which creates "My First Project"
for a user with none.

Step 9 fails while fabric publishes no prices, as `pricing` does, and still
reports the Console's quote.

Three edge cases ride on J2's signed-in session, each a result of its own:

- **`j2-401`:** the port's key with its last character changed answers `401`.
  The proxies' meters drop `401`, `429` and `503` from billing.
- **`j2-429`:** bursts of 30 concurrent requests answer at least one `429`,
  and no 5xx. Free allows 60 requests a minute, shared among the proxy's
  replicas, so the bursts repeat (up to five) until one answers `429`.
- **`j2-legacy-cookie`:** the legacy app still serves `/auth` and
  `/callbacks/auth0` on the apex with its own Auth0 client, and names its
  session cookie as the Console does, `_session-v2` on the `demeter.run`
  zone. The test drops the Console's cookie, signs in at `/auth` through
  Auth0's session, checks the legacy callback set `_session-v2`, and then
  that the browser still reaches the Console's ports page. The detail says
  whether the Console read that cookie or signed the browser in again, and
  lists the browser's `_session-v2` cookies by domain.

## Unit tests

```sh
pnpm test
pnpm typecheck
pnpm test:browser   # needs Chromium: pnpm exec playwright install --only-shell chromium
```

The readers are tested on responses and pages captured from production, and
the comparator on the pre-rollout numbers; `test/fixtures/README.md` says
where each came from. A variant is a copy of a captured page with one edit.
Requests, alerts and the `pricing` check end to end run against local servers
serving those captures (an HTTP/2 one for fabric), `apex` against a local apex
answering as production does, intent's browser steps against a stand-in page,
and `pnpm check` itself against stand-in checks. The Console's pricing grid is
read from its cells as webui renders them (the page renders only signed in, so
no capture of it is committed), `pnpm journey` runs against a stand-in
Playwright, the project deletion against a stand-in Console and the port
requests against a local server; `j2.yml`'s scripts run in bash with a
stand-in `pnpm` and a local webhook. No unit test reaches production or needs
a browser. The browser tests under `test/browser/` take a failed step's masked
screenshot of a stand-in port page, as the Console lays it out, whose heading,
labels or key shape have drifted, one or two at a time, and read its pixels
back: every pixel of the key must be painted over. They also sign out of a
stand-in Console, whose link navigates after a fetch as Remix's router does or
at once, through a stand-in Auth0 whose `/v2/logout` redirects back to a page
on the Console's origin, which the sign-out must wait for, or never answers,
which must fail the sign-out within its limit.

## Workflows

`.github/workflows/ports.yml` runs the port suite:

- daily at 10:00 UTC and on `workflow_dispatch` (with the same `force_fail`
  input): `pnpm ports --env production --alert`, the result file uploaded as
  the `ports-results` artifact. fabric's `0 12 * * *` run has started between
  15:18 and 16:42 UTC, as GitHub delays scheduled runs, so 10:00 keeps clear
  of it while both exist;
- on pull requests from this repository that change what the suite runs
  (anything under `src/`, the workflow, `.nvmrc` or the dependencies,
  `package.json`, `pnpm-lock.yaml` and `pnpm-workspace.yaml`): the same run,
  no alert, so a change is proven against production before it merges. GitHub
  dispatches only workflows already on the default branch;
- when an alerting run fails before the suite starts, one `e2e-ports-setup`
  alert naming the step.

It runs in the `production-test-user` concurrency group with `queue: max`:
runs that sign in as the test user wait for each other, and every waiting run
is kept. By default the group keeps one pending run, and a newer one cancels it
without failing, so no alert would say that day went unchecked.

`.github/workflows/contracts.yml` runs:

- on `pull_request` and on `push` to `main`: install, typecheck, unit tests,
  Chromium and the browser tests in the `unit` job, then
  `pnpm check all --env production`, no alert, in the `checks` job that
  needs it. The checks fail on every run while fabric
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

`.github/workflows/j2.yml` runs `pnpm j2 --env production`:

- daily at 06:00 UTC and on `workflow_dispatch`, with `--alert`. The dispatch
  takes the same `force_fail` input, and only runs of `main` receive the
  webhook;
- on pull requests from this repository that change what J2 runs (the specs,
  every file they import, `playwright.config.ts`, the toolchain and the
  dependencies; a unit test fails when an import is missing from the list),
  no alert: GitHub dispatches only workflows on the default branch, so this
  is how a branch walks J2 before it merges. The sign-in proof (`pnpm journey
  sign-in`) runs first, and J2 only when the test user could sign in. A pull
  request from a fork runs neither. A newer push to the pull request cancels
  its older run, waiting or walking (J2's job is gated on `!cancelled()`,
  not `always()`, which would walk on), so superseded pushes do not queue
  for the test user; the next run's clean slate deletes what a cancelled one
  left;
- when one of the alerting runs reports nothing, one IRM alert says so, as no
  result would: `e2e-j2-cancelled` when the job was cancelled (its timeout
  ran out, another job of the group took its place, or someone cancelled
  it), and `e2e-j2-setup` when it failed with no result or was skipped. The
  message says whether J2 was walked: not when a set-up step failed (it
  names the step), `pnpm j2` exited 2 on a usage error such as a missing
  `E2E_USER_PASSWORD`, or the job was skipped (the run was cancelled as it
  started, before GitHub evaluated J2's job; a run cancelled once J2 waits
  its turn for the test user ends it cancelled, as above); maybe partway
  when it exited 3 on a break outside the journey; maybe not at all, or
  partway, when the job failed with no step to name (GitHub could not set it
  up, or its runner was lost). Those that may
  have cut a walk short, and a cancelled job, may leave a project on the
  test user's account until the next run, and say so. `pnpm journey` exits
  0 or 1 only once it has reported the run. A unit test runs the workflow's
  three scripts: J2's step, the one naming the set-up step that failed, and
  the alert; another holds the jobs' and that step's `if:` gates as written.

The job's timeout is 150 minutes: J2's test has 100, mostly the 75-minute wait
on the cost, and when it times out the clean-up, the edge cases in a new
worker and that worker's clean-up take up to 33 more. It uploads `results/`:
the result files and the masked screenshots.

Every job that signs in as the standing test user sets the concurrency group
`production-test-user` (`cancel-in-progress: false`, `queue: max`), so no two
runs use the user at once and no waiting run is dropped. `queue: max` holds
only while every job of the group sets it: by default the group keeps one
pending job, and a newer one cancels it without failing it. The `ports` job
and J2's two jobs set it; the agent probe will.

### Secrets

| Name | Used by | For |
| --- | --- | --- |
| `IRM_E2E_WEBHOOK_URL` | scheduled and dispatched runs of `main` | the IRM integration alerts post to |
| `E2E_USER_PASSWORD` | the port suite and the journeys | signing in as the standing test user: the journeys through Auth0's form, the port suite by a password grant |
| `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET` | the port suite | its password grant |
