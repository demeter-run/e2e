# e2e

Developer journey end-to-end tests for Demeter, run against production, and the
contract checks that fail when the seams between website2, the Console and
fabric drift.

Today this repository holds the harness and four browserless contract checks.
The journeys (a person's path from `demeter.run` to a first request, and an
agent's) build on the same harness.

Every check is **report-only**: a failure shows on the pull request or alerts
from a scheduled run, but nothing here is a required status.

## Setup

- Node 22 (`.nvmrc`) and pnpm (the version in `package.json`'s
  `packageManager`; `corepack enable` provides it).
- Read access to `demeter-run/webui` and `demeter-run/website2`, which are
  private. Locally, your git credentials provide it. In CI, the
  `E2E_SOURCES_TOKEN` secret does (see [Secrets](#secrets)).

```sh
pnpm install
pnpm exec playwright install chromium   # for intent's live steps
```

## Running a check

```sh
pnpm check <name>                     # one check
pnpm check pricing,endpoint-parity    # several
pnpm check all --env production       # every check, live steps included
```

| Option | Effect |
| --- | --- |
| `--env <name>` | Run live steps against a named environment. Without it, only static steps run, and a live-only check is skipped (`all`) or refused (by name). |
| `--fabric <dir>`, `--webui <dir>`, `--website2 <dir>` | Read that repository from a directory instead of a fresh shallow clone of its `main`. |
| `--alert` | Post one IRM alert per failed check, when `IRM_E2E_WEBHOOK_URL` is set; otherwise log that the alert was skipped. |
| `--force-fail` | Add a check named `force-fail` that fails on purpose, to prove the alert path. |
| `--results <dir>` | Where result files go (default `results/`). |

Environments are named in `src/env.ts`. `production` is the only one:
`https://demeter.run` (website2), `https://console.demeter.run`,
`https://legacy.demeter.run` and the Auth0 tenant
`https://txpipe.us.auth0.com`.

Each repository source defaults to a fresh shallow clone of `main`, made in a
temporary directory for the run and removed after it. To check a local branch,
point at it: `pnpm check pricing --webui ../webui`.

## The checks

### `pricing` (static)

The three surfaces that state a price agree:

| Surface | Read from | Shape |
| --- | --- | --- |
| fabric (what is billed) | `bootstrap/rpc/crds/<kind>.json` | `plan.<tier>.cost.{minimum, delta}`: USD per month, USD per metered unit |
| the Console (what a customer confirms) | `src/app/utils/pricing/values.ts` | `PRICING[<slug>].tiers[…].plans[<plan>].cost.{fixed, usageBased, usageBasedLabel}` |
| website2 (what a visitor reads) | `src/content/portPricing.ts` (the `/pricing` table) and `src/content/plans.ts` (the landing cards) | display strings such as `'$0.30'` |

Each surface is reduced to one card per port and tier,
`{port, tier, minimum_usd, per_100k_usd}`, where `per_100k_usd` is USD per
100,000 of the port's metered unit (requests, messages, submits, or seconds of
open connection: the Console's "24hs of open connection" is 86,400 units).
Tiers are fabric's: `0` Free, `1` Flexible, `2` Pro I, `3` Pro II. Ogmios's
tier `4` is off the card (decision 0024) and compared with nothing. The landing
cards price "all APIs, one rate", so they are read as a quote for every port
the `/pricing` table lists. The website2 TypeScript modules are loaded with
`tsx`; plain `node` cannot import them.

The check fails, printing one line per divergence that names the port, the
tier and each surface's value, when:

- a surface charges for a port and tier that fabric bills nothing for (no
  `cost` block, no such tier or no such port), which is how UTxO RPC was quoted
  and never billed;
- Ogmios, Kupo, Blockfrost or UTxO RPC, on tiers 1–3, is not priced by the
  Console, the `/pricing` table or the landing cards;
- a minimum fee or usage rate differs between any surfaces that state it, for
  every port fabric and the Console both name. fabric stores rates to four
  significant digits, so values within 0.1% are the same.

A Console slug or website2 port name the check cannot place
(`src/surfaces/ports.ts`) also fails it.

```sh
pnpm check pricing
pnpm check pricing --fabric ../fabric --webui ../webui --website2 ../website2
```

Pointed at the commits before the rate-card rollout (the parents of
fabric#272, webui#137 and website2#10), it fails and names the 4.7× Blockfrost
divergence:

```
Blockfrost Flexible per 100k: fabric $0.06 · console $0.28 · website2 landing $0.28
```

### `intent` (static, plus live steps with `--env`)

`intent=signup` is a string shared by two repositories: website2 builds it into
its sign-up CTAs, and the Console's login route turns it into Auth0's
`screen_hint=signup`. Neither side fails when the other changes.

Static, from website2's `src/content/links.ts` and the Console's
`src/app/routes/login.tsx`:

- every `?intent=` value website2 sends is one `login.tsx` recognises;
- the sign-up CTAs (`signUp`, `startBuilding`, `getStarted`) go to
  `https://console.demeter.run/login?intent=signup`;
- the sign-in CTA (`signIn`) goes to `/login` with no intent.

Live, with `--env production`:

- `GET /login?intent=signup` redirects to Auth0's `/authorize` with
  `screen_hint=signup`, and `GET /login` without it (the redirect is read, not
  followed);
- in Chromium, the first lands on Auth0's signup form and the second on its
  login form, told apart by the screen's path, page title and heading (recorded
  in `src/checks/intent.ts`). This is the login-versus-signup edge case:
  Classic Universal Login drops `screen_hint` silently.

```sh
pnpm check intent                    # static
pnpm check intent --env production   # static and live
```

### `apex` (live only)

The apex contract from the cutover-apex skill's `cutover.sh verify`, one
assertion per probe, with the same semantics: one request, no redirect
followed, 15 s to answer (20 s for the page body).

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

```sh
pnpm check apex --env production
```

### `endpoint-parity` (static)

website2 promises "Switching plan or port never changes your endpoints". In
fabric, an endpoint host is rendered from the tier's `plan.<tier>.dns` and an
`authToken` fixed at creation, so the promise holds exactly when every tier of
every `bootstrap/rpc/crds/*.json` carries the same `dns`. One step per kind.

```sh
pnpm check endpoint-parity
```

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

`env` is null for a static run. The run is printed to the terminal and, in
GitHub Actions, appended to the job summary. With `--alert` and
`IRM_E2E_WEBHOOK_URL` set, each failed result posts one IRM alert,
`{alert_uid: "e2e-<name>", title, message, state: "alerting",
link_to_upstream_details}`, the shape fabric's `send_irm_alert` uses.

Nothing secret goes in a result, a summary or an alert: URLs are reduced to
origin and path (`src/http.ts`), and the webhook URL is never printed.

The harness for later pieces is `src/env.ts` (environments), `src/report.ts`
(`Run`, result files, the summary, alerts) and `src/sources.ts` (repository
sources). Browser journeys go under `journeys/`, run by
`playwright.config.ts`.

## Unit tests

```sh
pnpm test
pnpm typecheck
```

The extractors and the comparison are tested against verbatim copies of the
three repositories' files in `test/fixtures/main/` (sources and commits in
`test/fixtures/README.md`). A variant is a scratch copy with one edit.

## Workflows

`.github/workflows/contracts.yml` runs:

- on `pull_request` and on `push` to `main`: `pnpm check all --env production`,
  no alert;
- daily at 05:00 UTC and on `workflow_dispatch`:
  `pnpm check all --env production --alert`. The dispatch takes a boolean
  `force_fail` input that makes the run fail on purpose. Only runs of `main`
  receive the webhook, so a dispatch on another branch logs that its alert was
  skipped;
- on `workflow_call`, for the repositories the checks guard (below).

Any job that signs in as the standing test user sets the concurrency group
`production-test-user` (`cancel-in-progress: false`), so no two runs use the
user at once. None does yet.

### Calling the checks from another repository

The reusable workflow `demeter-run/e2e/.github/workflows/contracts.yml@main`,
called on `workflow_call` with two inputs: `repo` (one of `website2`, `webui`,
`fabric`), the repository under test, and `checks` (a comma-separated subset
of `pricing`, `intent`, `endpoint-parity`). It checks out the other two
repositories at `main`, uses the caller's pull-request head for `repo`, and
runs `pnpm check <name>` for each. It fails the job on a failed check and
never alerts IRM. `intent` runs its static half only.

```yaml
# .github/workflows/contracts.yml in demeter-run/webui
name: contracts
on:
  pull_request:
jobs:
  contracts:
    uses: demeter-run/e2e/.github/workflows/contracts.yml@main
    with:
      repo: webui
      checks: pricing,intent
    secrets: inherit
```

`secrets: inherit` passes `E2E_SOURCES_TOKEN`, without which the private
repositories cannot be cloned.

### Secrets

| Name | Used by | For |
| --- | --- | --- |
| `IRM_E2E_WEBHOOK_URL` | scheduled and dispatched runs of `main` | the IRM integration alerts post to |
| `E2E_SOURCES_TOKEN` | every run that reads webui or website2 | read access to `demeter-run/webui` and `demeter-run/website2` |
| `E2E_USER_PASSWORD`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET` | the journeys | signing in as the standing test user |
