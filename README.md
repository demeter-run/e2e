# e2e

Developer journey end-to-end tests for Demeter, run against production, and the
contract checks that fail when website2, the Console and fabric drift apart in
production.

**This repository tests live surfaces only.** It reads what is deployed, over
HTTP and in a browser, and nothing else: it clones, vendors and reads no
product repository, and it gates no other repository's pull requests. Each
product repository keeps its own static checks. Drift between surfaces is
caught here, afterwards, against production.

Today it holds the harness, three contract checks, and the coding agent's
journey (J0) with the agent-route mock it runs against on every merge. The
person's journey (J2) builds on the same harness.

Every check is **report-only**: a failure shows on this repository's pull
requests or alerts from a scheduled run, but nothing here is a required status.

## Setup

Node 22 (`.nvmrc`) and pnpm (the version in `package.json`'s
`packageManager`; `corepack enable` provides it). No credentials: every
surface the checks read is public, and the mock issues its own. Only J0
against production signs in, as the standing test user, with
`E2E_USER_PASSWORD`.

```sh
pnpm install
pnpm exec playwright install chromium   # for intent's last two steps and J0's claim
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

Environments are named in `src/env.ts`. `production` is
`https://demeter.run` (website2), `https://console.demeter.run`,
`https://legacy.demeter.run`, `https://rpc.demeter.run` (fabric's gRPC-web
API) and the Auth0 tenant `https://txpipe.us.auth0.com`. `mock` is the
agent-route mock below, at `E2E_MOCK_URL` (default `http://127.0.0.1:4010`),
standing in for the Console and the sign-in; the contract checks do not run
against it.

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

## The agent-route mock

A mock of the Console's agent routes and claim pages, built from the
registration-and-claim contract that the devex context publishes
(`solution/devex/contracts/registration-and-claim.md` in the Demeter domain):
its sections "HTTP for agents", "Errors" and "Claim pages". It is a plain Node HTTP server
(`src/mock/`) with no dependency, and every credential it issues is random and
reaches nothing real. It has no sign-in or payment routes for agents yet:
those arrive with the contract changes that add them, and extend the mock.

```sh
pnpm mock                                   # http://127.0.0.1:4010
pnpm mock --port 4020                       # http://127.0.0.1:4020
E2E_MOCK_URL=http://127.0.0.1:4020 pnpm j0 --env mock
```

`--env mock` reads the mock's URL from `E2E_MOCK_URL`. `--base-url` is the
origin the mock writes into claim and port URLs, by default where it listens
(`[…]` around an IPv6 `--host`). To reach the mock under another name, give
it that name and point `E2E_MOCK_URL` at the same origin, since J0 opens a
claim URL only on the environment's Console:

```sh
pnpm mock --port 4020 --host 0.0.0.0 --base-url http://mock.local:4020
E2E_MOCK_URL=http://mock.local:4020 pnpm j0 --env mock
```

| Route | What it does |
| --- | --- |
| `POST /api/agent/register` | `{"agent": {"name", "version"?, "url"?}}` → the six dotenv lines in the contract's order; name required and at most 64 characters, version and url at most 256 |
| `POST /api/agent/ports` | `dmtr-api-key` and `project-id` headers, `{"kind", "network", "throughputTier"?}` → `<PREFIX>_PORT_ID`, `<PREFIX>_URL`, `<PREFIX>_KEY`; checks in the Console's order (headers, body, network and tier, kind and its options, then key, expiry and the 3-port cap) |
| `GET /data/<port id>/…` | the fake data plane each `_URL` points at: `200` JSON to a request carrying the port's key in `dmtr-api-key`, `401` otherwise, and `401` once its project expires |
| `GET /claim/<token>`, `POST` | signed out, "Log in" and "Sign up" (and the page is remembered for after sign-in); signed in, the agent's identity, its ports and the expiry, a project-name field defaulting to the namespace, and "Claim project", which makes the user the owner, voids the token and the user code, and redirects to `/<namespace>/ports`. A used, unknown or expired token shows the expired page |
| `GET /activate?code=…`, `POST` | the same, for a user code typed in any case, with or without the hyphen |
| `GET /login`, `POST` | the mock's sign-in form: Auth0's field names (`#username`, `#password`, "Continue"), and any user name and password sign in |
| `GET /<namespace>/ports` | the claimed project's ports, for its owner |

Dotenv bodies are `text/plain; charset=utf-8` and errors JSON `{error,
message, retry_after_seconds?, docs}`, both `Cache-Control: no-store`, with
production's messages. The contract defines `POST` only: the mock answers any
other method on the two agent routes `405 invalid_request`, as production
does for every method but `GET` and `HEAD`, which production's framework
answers `400` in plain text. No test reads either. Credentials take the contract's formats:
`dmtr_apikey1…` keys, 32-byte base64url claim tokens, `XXXX-XXXX` user codes
from the contract's alphabet, expiry 7 days ahead in RFC 3339 UTC. The port
catalog (which kinds exist, and which networks each offers) is fabric's,
copied into `src/mock/catalog.ts` with its date.

### Control routes

Under `/__mock/`, never on a contract path, and not logged:

| Route | Body | Effect |
| --- | --- | --- |
| `POST /__mock/state` | `{"route": "register" \| "ports", "error": "<code>", "retry_after_seconds"?: <int>}` | every call to that route answers that error, any code of the contract's table with its status; `ip_cap` carries `retry_after_seconds` and `Retry-After` (86400 unless given) |
| | `{"route": …, "error": null}` | stops it |
| | `{"project": "<id or namespace>", "expired": true \| false}` | expires a project (`/ports` is `410 expired`, its ports stop answering, its claim link shows expired) or revives it |
| `GET /__mock/calls` | | every other call so far, `[{method, path, status, headers}]`: claim tokens, user codes and every credential the mock issued are `[redacted]`, and `dmtr-api-key`, `cookie` and `authorization` are redacted whole |
| `GET /__mock/state` | | the error states and expired projects, `{"errors": {"<route>": {"error", "retry_after_seconds"?}}, "expired": ["<project id>"]}`; `POST /__mock/state` answers the same |
| `POST /__mock/reset` | | forgets every project, session, error state and call |

```sh
curl -s -X POST localhost:4010/__mock/state -d '{"route": "register", "error": "ip_cap", "retry_after_seconds": 600}'
curl -s localhost:4010/__mock/calls | jq '.[] | "\(.method) \(.path) \(.status)"'
curl -s -X POST localhost:4010/__mock/reset -d '{}'
```

A handler error answers `500 mock_error` and is written to the mock's
standard error, with credentials redacted.

### For local development and the agent evals

The mock is what `agent-first-devex-journey-evals` points its agents at
instead of production: an agent given `E2E_MOCK_URL` as its Console registers,
creates ports, requests them and hands over a claim link exactly as the
contract says, and the call log shows what it did. Error states put it on the
paths production rarely takes (caps, the kill switch, an expired project).
Because the contract suite below runs against both the mock and production,
a mock that no longer behaves like production fails a run.

## The agent contract suite

`src/agent/contract.spec.ts` holds one test per rule of the contract's HTTP
sections, and runs against any environment. Each test is tagged:

- **`prod-safe`**: it reads, or uses the run's own registration. Run on
  production, these use J0's one registration (before J0 claims it): the
  register and ports bodies' line names and order, register's value formats
  (UUID, namespace, key prefix, a claim URL on the Console with a 43-character
  token, the user code, an expiry 7 days ahead), a 65-character agent name as
  `400 invalid_request`, a bad key on `/ports` as `401 unauthenticated`,
  mainnet and a paid tier as `403 pre_claim_limit`, an unknown kind as
  `400 invalid_request`, the port catalog on preprod and preview as the mock
  copies it, and every error body as JSON with `error`, `message` and `docs`
  that carries no credential. The catalog test creates nothing: it sends each
  kind with a key no project holds, which the Console checks last, so a kind
  offered on the network is `401`, one that is not `403`, and an unknown one
  `400`, whose message lists every kind the Console knows.
- **`mock-only`**: it needs a mock error state or more ports than a
  production run may create: `ip_cap` with `retry_after_seconds` and an equal
  `Retry-After`, `port_cap` on a fourth port, `global_cap`,
  `registration_disabled`, and `expired`.

A test reports statuses, codes and line names, never a body: a line that is
not `NAME=value` is named by the name it seems to carry, never its value.

```sh
pnpm contract --env mock                   # every test, on a registration of its own
pnpm contract --env mock --tag prod-safe   # one tag
```

`pnpm contract` resets the mock first, as J0 does, and a mock-only test puts
the route's previous error state back after it.

On production the suite runs only inside J0 (`pnpm j0 --contract
prod-safe`), which claims and deletes the registration it shares; `pnpm
contract --env production` refuses.

## J0, the coding agent's journey

J0 is the main journey of the journey matrix
(`solution/devex/contracts/journey-matrix.md`): a coding agent with no
account, as scripted calls with no model, up to a claim by a person.

```sh
pnpm j0 --env mock --contract all                                    # what CI runs
E2E_USER_PASSWORD=… pnpm j0 --env production --contract prod-safe    # the daily probe
```

It takes `--alert`, `--force-fail` and `--results` as `pnpm check` does, and
`--contract all|prod-safe` to run the contract tests on its registration
(`all` only on the mock). Its steps:

1. register as agent `e2e-j0` and write the body to `.env.demeter`, in a
   fresh temporary directory readable by this user only, never printed and
   removed at the end (or on `SIGINT` or `SIGTERM`);
2. create a Blockfrost port (`BlockfrostPort`) on `cardano-preprod` and
   append its body; the contract tests run here, on this registration;
3. `GET <_URL>/blocks/latest` with `dmtr-api-key: <_KEY>` until it answers
   2xx, every 5 s for up to 3 minutes while the port comes up;
4. claim in Chromium: open `DEMETER_CLAIM_URL`, only when it is on the
   environment's Console, "Log in", sign in (the mock's form as any user, or
   Auth0 as `e2e@txpipe.io`; nothing is typed unless the form is on the
   environment's sign-in origin), check the project name defaults to the
   namespace, "Claim project", and land on `/<namespace>/ports`;
5. the same request with the same key still answers 2xx;
6. on production, delete the claimed project through the Console, pass or
   fail. A claim whose landing failed may still have gone through, so once
   "Claim project" was pressed, the step waits up to 30 s for the project's
   page to load for the test user, and deletes it if it does. The delete
   posts the settings page's form without following its redirect to `/`,
   which would create "My First Project" for a user left with none. A
   redirect elsewhere means fabric took the delete; a redirect to `/login`
   fails the step (the session was refused); a 200, a 5xx or a lost answer
   is tried again, up to 3 times, unless the project's page has stopped
   loading meanwhile. The step then waits until the project's page fails to
   load twice in a row, 3 s apart, which is how a deleted namespace answers.
   What it cannot delete it names, with whether it is on the test user's
   account or expires unclaimed. On the mock instead, the call log holds
   exactly the calls steps 1–5 made.

A last step checks that no credential the run held (API key, port key,
claim URL and token, user code, the test user's password, the browser's
session cookies) appears in either result or, on the mock, in the call log;
every detail is scrubbed before it is written anyway, and a browser error
keeps only its first line, as its call log carries request headers. In
GitHub Actions each credential is also masked in the job log as it arrives.

Without `E2E_USER_PASSWORD` off the mock, J0 registers nothing (a project
nobody claims would stay behind for 7 days) and its one step fails, so the
probe's result and alert say so. A run that breaks outside its steps exits 3,
and a usage error exits 2.

### What the probe does in production

Once a day (and on each pull request that changes the probe) it creates one
provisional project, one Free (tier `0`) Blockfrost port on preprod and a
handful of requests, the project and port deleted within minutes: about $0 a
run. One registration a run sits well inside the caps of 3 per client IP in
24 hours and 200 unclaimed projects live, and the expiry sweep gets no
traffic from it. A run that fails before the claim leaves its provisional
project to expire in 7 days, and says so in its delete step. It signs in as
the standing test user only, in the browser.

What outlives the run: each claim makes fabric create a billing (Stripe)
customer for the test user, which deleting the project does not remove, so
the test user's billing account gains one customer a day. A run cancelled
after its claim, or whose delete fails, leaves the claimed project on the
test user's account until someone deletes it; both alert.

The prod-safe contract tests send requests the Console refuses, apart from
the 65-character name: should production ever accept it, that run leaves one
more unclaimed project to expire.

## Results and alerts

Every check and journey writes `results/<name>.json` (J0's run writes
`j0.json` and `agent-contract.json`):

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
and `pnpm check` itself against stand-in checks. The mock is tested over HTTP
(routes, error states, claim pages, control routes, redaction), and the
contract suite and `pnpm contract` against an in-process mock, and through a
proxy that rewrites its answers the way a drifted mock or production would:
a renamed or reordered dotenv line, a body in another form, a cacheable
answer, an error's status or code alone, a non-JSON error, a moved docs link,
an echoed key, a short claim token, a wrong expiry or `Retry-After`, a
catalog that lost or gained a kind, and a credential that reaches a result,
which the leak step must fail. Each makes the suite fail. So no unit test
reaches production. J0's browser steps run in `j0-mock.yml`.

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

`.github/workflows/j0-mock.yml` runs on `pull_request` and on `push` to
`main`: it starts the mock, runs `pnpm j0 --env mock --contract all`,
uploads the results and the mock's (redacted) call log, and prints the
mock's log, failing the job when it holds a handler error. Nothing in it
reaches production.

`.github/workflows/agent-j0-probe.yml` runs `pnpm j0 --env production
--contract prod-safe`:

- daily at 18:00 UTC and on `workflow_dispatch` (with `force_fail`), with
  `--alert`, so each failed result posts its IRM alert (`e2e-j0`,
  `e2e-agent-contract`). Only runs of `main` receive the webhook;
- on pull requests from this repository that change the probe (its
  workflow, `src/agent/`, the agent CLI, `src/mock/catalog.ts`,
  `src/signin.ts`, `src/env.ts`, `src/report.ts`, the package files), with
  no alert, so a change is proven against production before it merges. A
  dispatch needs the workflow on `main`: GitHub dispatches no workflow that
  the default branch does not have.

When the probe reports nothing, a `curl` and `jq` job posts one alert, as
`contracts.yml` does: `e2e-agent-j0-setup` when a step before J0 failed
(checkout, install or Chromium) or J0 exited with no result (a usage error,
or a break outside its steps), and `e2e-agent-j0-cancelled` when the job was
cancelled (its 20 minutes ran out, a newer run took its place in the
concurrency group, or someone cancelled it), since a claimed project may
then be left on the test user's account.

Any job that signs in as the standing test user sets the concurrency group
`production-test-user` (`cancel-in-progress: false`), so no two runs use the
user at once. The probe does.

### Secrets

| Name | Used by | For |
| --- | --- | --- |
| `IRM_E2E_WEBHOOK_URL` | scheduled and dispatched runs of `main` | the IRM integration alerts post to |
| `E2E_USER_PASSWORD` | the agent probe, and the journeys | signing in as the standing test user |
| `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET` | the journeys | signing in as the standing test user |
