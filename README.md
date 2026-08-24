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
| `gdp_qoq` | Published GDP growth, on the last week of its quarter; empty elsewhere |

Rules the page relies on: no quoting, no embedded commas, ISO dates, **empty
string** for missing (never `NA`/`NaN`), fixed column order, rows sorted
ascending, LF line endings. A row whose field count disagrees with the header is
a hard error rather than a silent misparse.

Only the growth rate carries a band. The level index is a cumulation of the
growth rate and the model does not supply a compounded credible interval for it,
so none is drawn rather than one that would look like a level band without being
one.

## How the files get here

Written by `export_wai_web()` in `mfbdfm`:

```r
mfbdfm::export_wai_web("fits/updated/full_RT/fit_<date>.Rda",
                       dir = "/path/to/wai-webapp",
                       gdp = mfbdfm::get_real_time_gdp_vintages("quarterly"))
```

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

MIT for the page and its code. Vendored libraries are MIT (Chart.js).
