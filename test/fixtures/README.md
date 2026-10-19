# Fixtures

`main/` holds verbatim copies of the files the contract checks read, laid out
as in their repositories, taken on 2026-10-19 from each repository's `main`:

| Directory | Repository | Commit | Files |
| --- | --- | --- | --- |
| `main/fabric` | `demeter-run/fabric` | `d887e2be3507` | `bootstrap/rpc/crds/*.json` |
| `main/webui` | `demeter-run/webui` | `598b74222746` | `src/app/utils/pricing/{values,types}.ts`, `src/app/utils/enums.ts`, `src/app/routes/login.tsx` |
| `main/website2` | `demeter-run/website2` | `e21011dff93c` | `src/content/{portPricing,plans,links}.ts` |

Tests that need a variant copy `main/` to a temporary directory and edit the
copy, so every variant is one visible change from the real files. Refresh a
copy by copying the file again and updating this table; a test that pins a
count (the divergences on `main`, say) will then say what moved.
