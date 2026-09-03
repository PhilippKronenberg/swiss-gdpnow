# wai-webapp

What changed on the published dashboard, and when.

There are no version numbers here. A merge to `main` deploys to
<https://philippkronenberg.github.io/wai-webapp/> straight away, so what is
live is always the top of this file. Entries are dated by the day the change
reached `main`, newest first.

Two kinds of change matter to anyone citing the index, and they are marked so
they can be found quickly:

- **Data** — the published numbers themselves changed. `wai_data.csv` is
  republished in full on every update, so a change of this kind is invisible in
  the diff unless it is written down.
- **Presentation** — what the page shows or how it shows it. The page performs
  no estimation, so these never move a number.

Anything unmarked is repository infrastructure and does not affect what is
published.

## 2026-08-27

- *Presentation.* Muted text and links now clear WCAG AA. `--text-muted` — the
  small print under the four stat tiles, and the whole footer — went from
  `#78776f` to `#6d6c65`, darkened just far enough to pass and no further, so
  it still recedes from the body text instead of joining it. Links were painted
  with `--series-wai`, the chart's blue: at 4.08:1 that clears the 3:1 AA asks
  of a graphical object and misses the 4.5:1 it asks of text, so darkening the
  shared token would have repainted the chart line to fix the prose. They have
  their own `--link` token now and the chart is untouched (#11).

- The same work found a real bug behind that one. `:root[data-theme="dark"]`,
  the block the theme toggle switches on, was missing six brand tokens —
  `--brand`, `--brand-dark` and the four `--on-brand-*` values — so for those it
  fell back to the light `:root` and painted `#276873` onto a `#1a1a19` tile at
  2.74:1. **The page was below AA only for readers on a light operating system
  who pressed the toggle**; the same page under a dark system read the
  `prefers-color-scheme` block, which had the values, and was fine. That is why
  it survived: the palette is defined three times and only one of the three was
  wrong (#11).

## 2026-08-26

- *Presentation.* The dashboard is wrapped in a `<main>` landmark and its four
  blocks — the stat tiles, the controls, the chart card and the notes — carry
  accessible names, which is what turns a plain `<section>` into a region a
  screen reader can jump to. There was previously no skip-to-content target at
  all. Markup only: every stylesheet rule selects on class, and the rendered
  page is byte-identical (#12).

- CI gained an advisory `a11y` job: it serves the page over `http://` and runs
  axe-core against it. Served, not opened as a file, because `fetch()` is
  blocked over `file://` and an auditor pointed at the file grades the error
  banner instead of the dashboard. A step before the audit asserts the page
  actually rendered, so a silent data failure cannot pass as a clean audit
  (#9).

- The issue queue can now be worked unattended: an agent picks up one issue
  labelled `agent-ready` per run, opens a pull request, and never merges. Every
  change is still reviewed by a human before it is published (#2).

- `CLAUDE.md` records the decisions that are invisible from the code — the
  absent build step, Chart.js being vendored rather than CDN-loaded, the
  palette living in three separate blocks — so that they are defended rather
  than tidied away by whoever reads the file next (#2).

- *Presentation.* First pass over the design list: the brand green applied as
  tokens across all three palette blocks, a full-bleed header band, larger type
  throughout, the legend moved below the figure, and each figure now says what
  it refers to (#5).

- Nothing verified a change before it reached the live page. CI now runs
  `tools/validate-data.mjs`, checks the vendored assets against
  `vendor/SHA256SUMS`, and validates `index.html`, all with no dependency of
  its own. The check worth the most is on `wai_meta.json`: it restates facts
  derivable from the CSV that the page never reads, so those fields could drift
  out of agreement with the data while the dashboard still looked entirely
  correct (#3).

## 2026-08-25

- **Data.** Republished from a fresh fit on corrected `mfbdfm` code. The level
  index had been compounding the net weekly growth rate with `exp(gr)` instead
  of `(1 + gr)` — an error that could only push the index up, and that
  compounded. It was invisible in normal times and not invisible in 2020: the
  gap of the level index against published GDP opened to 0.09 index points in
  2020Q2 and went on widening to 0.17 by 2021Q2 rather than closing. It now
  holds inside ±0.02 across that transition. **Anyone holding a copy of
  `wai_index` taken before this date has values of order 0.1 index points too
  high from 2020 onward.** The fix itself touches only the level index; the
  series was regenerated from a fresh fit, so the growth columns move by
  sampling noise too. The quarterly aggregate still matches published GDP at a
  correlation of 1.0000 (mfbdfm #92).

- **Data.** *Presentation.* The synthetic sample data is gone, replaced by a
  real fit: 5000 draws after 1000 burn-in, 1741 weeks from 1990-01-07. The
  sample banner and the `"sample": true` flag went with it.

- **Data.** *Presentation.* `wai_qoq_q` and `wai_yoy_q` added — the WAI
  aggregated the way GDP is actually measured. Quarterly GDP is a flow, the
  quarter's average activity, while `wai_qoq` is an instantaneous annualised
  rate, so the weekly line and the GDP points are not point-comparable. Across
  2020Q2 activity collapsed and recovered inside the quarter, so the two
  measures answer different questions: on the last week of that quarter
  `wai_qoq` reads +45.9% as activity rebounds, while the quarter's average
  growth is -23.2% against GDP's -23.1%. Showing only the weekly line beside
  GDP invited exactly that misreading.

- **Data.** *Presentation.* Published GDP is shown on all three views rather
  than on QoQ alone: `gdp_yoy` and `gdp_index` join `gdp_qoq` in the CSV, each
  converted to the scale its WAI counterpart uses.

## 2026-08-24

- Two licences, because code and results are different things: `LICENSE` (MIT)
  covers the page and the vendored libraries, `LICENSE-DATA` (CC BY 4.0) covers
  `wai_data.csv` and `wai_meta.json`. The data licence is scoped to the derived
  aggregate index only — the third-party source series behind it are licensed
  from their providers, are not in this repository, and are not redistributable
  under those terms.

- First publication. One HTML file, one CSV, no build step and no server:
  three views (QoQ growth, YoY growth, level index), a 95% credible band,
  published GDP overlaid, range presets, a data table for the non-visual path
  and client-side CSV download. Chart.js and its date adapter are vendored
  rather than pulled from a CDN, so the page has no third-party runtime
  dependency and cannot be broken by a CDN outage. The data in this first
  commit was synthetic and labelled as such on the page.
