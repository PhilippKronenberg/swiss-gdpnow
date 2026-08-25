# wai-webapp

Public dashboard for the **Weekly Activity Index (WAI)** — a high-frequency
indicator of Swiss GDP growth, estimated with the
[`mfbdfm`](https://github.com/PhilippKronenberg/mfbdfm) R package.

Published at <https://philippkronenberg.github.io/wai-webapp/>.

> **The data currently in this repo is synthetic sample data, not the WAI.**
> It exists so the front end can be built and reviewed before the update
> pipeline is wired up. The page shows a banner saying so, driven by
> `"sample": true` in `wai_meta.json`. Both go away when the first real export
> lands.

## What this repository is

A static page and the data it reads. No build step, no server, no framework —
`index.html` is opened directly by the browser, fetches one CSV, and draws it.

```
index.html                              the entire application
wai_data.csv                            the entire data layer
wai_meta.json                           run metadata (drives the "as of" line)
vendor/chart.umd.js                     Chart.js 4.4.0 (MIT)
vendor/chartjs-adapter-date-fns...js    its date adapter (MIT)
```

Chart.js is **vendored rather than loaded from a CDN**, so the page has no
third-party runtime dependency: it works offline, behind restrictive corporate
proxies, and cannot be broken by a CDN outage or a re-published version.

## The data contract

`wai_data.csv` is the whole interface between the R package and this page. The
page performs no estimation — it selects columns.

| Column | Meaning |
| --- | --- |
| `date` | ISO date, weekly on the 7th/14th/21st/28th |
| `wai_qoq`, `wai_qoq_lo`, `wai_qoq_hi` | Annualised QoQ growth and its 95% credible band |
| `wai_yoy` | Year-over-year growth |
| `wai_index` | Level index, 2019Q4 = 100 |
| `gdp_qoq`, `gdp_yoy`, `gdp_index` | Published GDP on the same three measures, on the last week of its quarter; empty elsewhere |

Rules the page relies on: no quoting, no embedded commas, ISO dates, **empty
string** for missing (never `NA`/`NaN`), fixed column order, rows sorted
ascending, LF line endings. A row whose field count disagrees with the header is
a hard error rather than a silent misparse.

Official GDP is published on all three measures, on the same scale as the WAI
series so they share an axis: `gdp_qoq` is annualised percent, `gdp_yoy` is
percent, `gdp_index` is rebased to 2019Q4 = 100. `mfbdfm::gdp_web_series()` does
that conversion — the vintage database itself returns log differences and
fractions, which differ from the WAI scale by a factor of roughly 400.

Only the growth rate carries a band. The level index is a cumulation of the
growth rate and the model does not supply a compounded credible interval for it,
so none is drawn rather than one that would look like a level band without being
one.

## How the files get here

Written by `export_wai_web()` in `mfbdfm`:

One command, from the `mfbdfm` repository root on the machine that holds the
source data:

```sh
Rscript analysis/update_wai_web.R              # refresh, fit, export, push
Rscript analysis/update_wai_web.R --dry-run    # everything except the push
Rscript analysis/update_wai_web.R --skip-prep  # reuse the prepared dataset
```

That script refreshes the data, fits the model at the latest vintage, exports
via `mfbdfm::export_wai_web()`, validates the result against the contract above,
and commits and pushes here — but only if every check passes and something
actually changed. Point it at this checkout with `WAI_WEBAPP_DIR`.

It refuses to publish if the header drifts from the contract, if missing values
are encoded as `NA`, if rows are unsorted or duplicated, if the band does not
bracket the mean, or if the new series ends *earlier* than the published one —
that last one being the failure most likely to slip through, since the file is
perfectly well-formed.

The model is estimated on a host that holds the licensed source data, and only
the derived aggregate output is pushed here. Nothing from the private
`data/dataset/` is ever published. See `dev/wai-webapp-plan.md` in the `mfbdfm`
repo for the full pipeline plan.

## Local preview

```sh
python3 -m http.server 8000    # then open http://localhost:8000/
```

Opening `index.html` via `file://` will not work — the page uses `fetch()`.

## Methodology

Kronenberg (2026), *Swiss Journal of Economics and Statistics*, 162:10,
<https://doi.org/10.1186/s41937-026-00157-w>, extending Eckert, Kronenberg,
Mikosch & Neuwirth (2025), *Journal of Applied Econometrics*, 40(3), 270–290,
<https://doi.org/10.1002/jae.3104>.

## Licence

Two licences, because the code and the results are different things:

- **Code** (`index.html`, everything under `vendor/`) — [MIT](LICENSE).
  Chart.js and its date adapter are MIT too.
- **Data** (`wai_data.csv`, `wai_meta.json`) —
  [CC BY 4.0](LICENSE-DATA). Share and adapt for any purpose, including
  commercially, with attribution. This is what makes the results freely
  showable and citable.

The data licence covers the **derived aggregate index only**. The third-party
source series used to estimate it are licensed from their providers, are not in
this repository, and are not redistributable under these terms.

Suggested attribution:

> Weekly Activity Index (WAI), Philipp Kronenberg, CC BY 4.0.
> <https://philippkronenberg.github.io/wai-webapp/>
