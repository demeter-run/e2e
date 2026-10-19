# Fixtures

Nothing here is product source. Two kinds of file:

## `live/`: captured from production

Taken on 2026-10-19 from what is deployed, byte for byte:

| File | Request |
| --- | --- |
| `fetch-metadata.bin` | `POST https://rpc.demeter.run/demeter.ops.v1alpha.MetadataService/FetchMetadata`, gRPC-web, an empty request: the response body (frames and trailer) |
| `pricing.html` | `GET https://demeter.run/pricing` |
| `home.html` | `GET https://demeter.run/` |

The HTML keeps the NUL bytes the server-rendered pages carry. A test that
needs a variant edits a copy of the text in memory (`edit` in
`../helpers.ts`), so every variant is one visible change from the captured
page. Refresh a file by capturing it again; a test that pins a count will say
what moved.

## `cards/`: normalised by hand

`pre-rate-card.json` holds the prices before the rate-card rollout, which is
no longer deployed anywhere, as the shared card (`{port, tier, minimum_usd,
per_100k_usd}`), one list per surface. Normalised once from the parents of the
rollout's pull requests, named in the file's `sources`:

- `fabric`: `demeter-run/fabric` at `a02e05848db4` (parent of fabric#272),
  every kind's `plan.<tier>.cost`; per 100k is `delta × 100000`, and a tier
  with no `cost` is both fields null.
- `website2`: `demeter-run/website2` at `08f1a267a555` (parent of
  website2#10), the `/pricing` table. Blockfrost and UTxO RPC were `—`, not
  yet published; Ogmios was priced per 24 h of connection, 86,400 metered
  seconds.
- `website2 landing`: the same commit's landing cards, "all APIs, one rate",
  as a quote for each of the four ports the table lists.

The Console's numbers from webui#137's parent are not here: its prices render
only signed in, so its leg belongs to the J2 journey.
