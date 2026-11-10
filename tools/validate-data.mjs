#!/usr/bin/env node
//
// Validates wai_data.csv against wai_meta.json, against itself, and against
// what index.html actually reads. It also validates the additive "measures"
// files -- wai_contributions.csv, wai_news.csv, wai_series.csv and
// wai_measures_meta.json -- and the forecast, wai_forecast.csv, when they are
// present, chiefly the identity that per date the contributions sum to wai_qoq.
//
// Zero dependencies, deliberately. This repository has no build step and no
// node_modules, and CI should not be the thing that introduces one. Everything
// here uses Node built-ins only.
//
// Run from the repository root:  node tools/validate-data.mjs
//
// With --check-staleness it additionally asserts that the published vintage is
// not too old. That check is opt-in because it depends on today's date rather
// than on the contents of the repository; see the staleness section below.

import { readFileSync, existsSync } from "node:fs";

const checkStaleness = process.argv.includes("--check-staleness");

const failures = [];
const notes = [];
const fail = (msg) => failures.push(msg);
const note = (msg) => notes.push(msg);

// wai_data.csv is produced by R, which can emit a UTF-8 BOM. Left in place it
// attaches to the header's first field, so "date" becomes "﻿date" and the
// header/columns comparison fails with a message that looks like a renamed
// column. Strip it and say so, rather than reporting a misleading mismatch.
const stripBom = (s, what) => {
  if (s.charCodeAt(0) === 0xfeff) {
    note(`${what} begins with a UTF-8 BOM; ignoring it. Harmless here, but `
      + `anything parsing this file with a stricter reader may choke on it.`);
    return s.slice(1);
  }
  return s;
};

// ---------------------------------------------------------------- load files

let meta;
try {
  meta = JSON.parse(stripBom(readFileSync("wai_meta.json", "utf8"), "wai_meta.json"));
} catch (e) {
  console.error(`FATAL: wai_meta.json does not parse: ${e.message}`);
  process.exit(1);
}

let csvText;
try {
  csvText = stripBom(readFileSync("wai_data.csv", "utf8"), "wai_data.csv");
} catch (e) {
  console.error(`FATAL: cannot read wai_data.csv: ${e.message}`);
  process.exit(1);
}

// A naive split on "," is only safe while no field is quoted or contains a
// comma. Assert that rather than assume it, so this parser cannot silently
// start misreading the file if its shape ever changes.
if (csvText.includes('"')) {
  console.error("FATAL: wai_data.csv contains a quote character. This validator's "
    + "naive CSV parse is no longer safe; teach it real quoting before trusting it.");
  process.exit(1);
}

const lines = csvText.split(/\r?\n/).filter((l) => l.length > 0);
const header = lines[0].split(",");
const rows = lines.slice(1).map((l) => l.split(","));

// ------------------------------------------- fields index.html actually reads
//
// Only these four are consumed by the page. If one goes missing the site
// breaks, so they are checked separately from the derived fields below.

for (const field of ["vintage_date", "run_timestamp", "mfbdfm_version", "columns"]) {
  if (meta[field] === undefined || meta[field] === null || meta[field] === "") {
    fail(`wai_meta.json is missing "${field}", which index.html reads. The page will break.`);
  }
}

if (meta.run_timestamp && Number.isNaN(Date.parse(meta.run_timestamp))) {
  fail(`run_timestamp "${meta.run_timestamp}" is not a parseable timestamp; `
    + `index.html renders it directly.`);
}

// ------------------------------------------------------ header vs meta.columns

if (Array.isArray(meta.columns)) {
  const a = meta.columns.join(",");
  const b = header.join(",");
  if (a !== b) {
    fail(`wai_meta.json "columns" does not match the CSV header.\n`
      + `      meta: ${a}\n       csv: ${b}`);
  }
} else {
  fail(`wai_meta.json "columns" is not an array.`);
}

// ------------------------------------------------------------- row structure

const dateIdx = header.indexOf("date");
if (dateIdx === -1) fail(`CSV has no "date" column.`);

rows.forEach((r, i) => {
  if (r.length !== header.length) {
    fail(`row ${i + 2} has ${r.length} fields, header has ${header.length}.`);
  }
});

// --------------------------------------------------------- dates: order, dupes

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
let prev = null;
const seen = new Set();

if (dateIdx !== -1) {
  rows.forEach((r, i) => {
    const d = r[dateIdx];
    const lineNo = i + 2;
    if (!DATE_RE.test(d)) {
      fail(`row ${lineNo}: date "${d}" is not YYYY-MM-DD.`);
      return;
    }
    if (Number.isNaN(Date.parse(d))) {
      fail(`row ${lineNo}: date "${d}" is not a real date.`);
      return;
    }
    if (seen.has(d)) fail(`row ${lineNo}: duplicate date "${d}".`);
    seen.add(d);
    if (prev !== null && d <= prev) {
      fail(`row ${lineNo}: date "${d}" does not come after the previous row's "${prev}". `
        + `The series must be strictly increasing; the chart assumes it.`);
    }
    prev = d;
  });
}

// --------------------------------------------------- numeric columns are numeric

header.forEach((col, ci) => {
  if (col === "date") return;
  rows.forEach((r, i) => {
    const v = r[ci];
    if (v === "") return;              // missing is legitimate and common here
    if (!Number.isFinite(Number(v))) {
      fail(`row ${i + 2}, column "${col}": "${v}" is not a finite number.`);
    }
  });
});

// ------------------------------------------------- confidence band consistency
//
// wai_qoq_lo <= wai_qoq <= wai_qoq_hi wherever all three are present. A band
// that has crossed its central estimate is a real defect and the chart would
// render it without complaint.

const qi = header.indexOf("wai_qoq");
const li = header.indexOf("wai_qoq_lo");
const hi = header.indexOf("wai_qoq_hi");

if (qi !== -1 && li !== -1 && hi !== -1) {
  rows.forEach((r, i) => {
    const q = r[qi], lo = r[li], up = r[hi];
    if (q === "" || lo === "" || up === "") return;
    const [qn, ln, un] = [Number(q), Number(lo), Number(up)];
    if (!(ln <= qn && qn <= un)) {
      fail(`row ${i + 2}: confidence band is inconsistent — `
        + `lo=${ln}, wai_qoq=${qn}, hi=${un}.`);
    }
  });
} else {
  note("confidence-band columns not all present; band check skipped.");
}

// ------------------------------------- derived metadata must agree with the CSV
//
// index.html does not read any of these, so they can drift silently while the
// page still looks correct. Anything else consuming wai_meta.json would be
// misled, which is exactly why they are checked here.

const approx = (a, b) => Math.abs(a - b) < 1e-9;

if (meta.n_obs !== undefined && meta.n_obs !== rows.length) {
  fail(`wai_meta.json n_obs=${meta.n_obs} but the CSV has ${rows.length} data rows.`);
}

if (dateIdx !== -1 && rows.length > 0) {
  const firstDate = rows[0][dateIdx];
  const lastDate = rows[rows.length - 1][dateIdx];

  if (meta.first_obs_date !== undefined && meta.first_obs_date !== firstDate) {
    fail(`wai_meta.json first_obs_date="${meta.first_obs_date}" but the CSV starts at "${firstDate}".`);
  }
  if (meta.last_obs_date !== undefined && meta.last_obs_date !== lastDate) {
    fail(`wai_meta.json last_obs_date="${meta.last_obs_date}" but the CSV ends at "${lastDate}".`);
  }

  const last = rows[rows.length - 1];
  const latest = [
    ["latest_wai_qoq", "wai_qoq"],
    ["latest_wai_yoy", "wai_yoy"],
    ["latest_index", "wai_index"],
  ];
  for (const [metaKey, csvCol] of latest) {
    const ci = header.indexOf(csvCol);
    if (meta[metaKey] === undefined || ci === -1) continue;
    const csvVal = last[ci];
    if (csvVal === "") {
      fail(`wai_meta.json ${metaKey}=${meta[metaKey]} but the CSV's final row has no ${csvCol}.`);
    } else if (!approx(Number(csvVal), Number(meta[metaKey]))) {
      fail(`wai_meta.json ${metaKey}=${meta[metaKey]} but the CSV's final row has ${csvCol}=${csvVal}.`);
    }
  }
}

// --------------------------------------- index.html's local references resolve
//
// Catches a vendored file being renamed or removed while the script tag that
// loads it stays behind -- which breaks the page with a blank chart and no
// obvious cause.

if (existsSync("index.html")) {
  const html = readFileSync("index.html", "utf8");
  const refs = [...html.matchAll(/(?:src|href)="([^"#?:]+)"/g)].map((m) => m[1]);
  for (const ref of new Set(refs)) {
    if (ref.startsWith("//") || ref.startsWith("data:")) continue;
    if (!existsSync(ref)) {
      fail(`index.html references "${ref}", which does not exist in the repository.`);
    }
  }
}

// ------------------------------------------------------- the measures files
//
// wai_contributions.csv, wai_news.csv, wai_series.csv and wai_measures_meta.json
// are written by export_wai_measures() alongside wai_data.csv. They are
// ADDITIVE: a checkout without them is a valid checkout of this repository and
// the page simply omits the panels that read them, so every check below is
// skipped rather than failed when the files are absent.
//
// What they need checking for is the same thing wai_meta.json's derived fields
// need it for: they restate the main series from a different angle, so they can
// disagree with wai_data.csv while every page on the site still renders
// perfectly. The contributions identity is the sharp end of that -- the whole
// claim of the contributions panel is that the stack sums to the WAI line, and
// nothing in the browser would notice if it stopped being true.

const num = (s) => Number(s);

// Reads a strictly-unquoted CSV into { header, rows } and fails the run if the
// shape is not what the caller declared. Mirrors the narrow contract the main
// parse above assumes, including being loud about quoting rather than guessing.
function readFlatCsv(path, expectedHeader) {
  const text = stripBom(readFileSync(path, "utf8"), path);
  if (text.includes('"')) {
    fail(`${path} contains a quote character. This validator's naive CSV parse `
      + `cannot be trusted on it, and neither can index.html's.`);
    return null;
  }
  const ls = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (ls.length === 0) {
    fail(`${path} is empty.`);
    return null;
  }
  const head = ls[0].split(",");
  if (head.join(",") !== expectedHeader.join(",")) {
    fail(`${path} header is "${head.join(",")}", expected "${expectedHeader.join(",")}". `
      + `These files are a published interface; renaming a column breaks other `
      + `people's scripts silently.`);
    return null;
  }
  const body = ls.slice(1).map((l) => l.split(","));
  let ragged = 0;
  body.forEach((r, i) => {
    if (r.length !== head.length) {
      if (ragged < 5) {
        fail(`${path} row ${i + 2} has ${r.length} fields, header has ${head.length}.`);
      }
      ragged++;
    }
  });
  if (ragged > 5) fail(`${path}: ${ragged - 5} further rows have the wrong field count.`);
  return ragged > 0 ? null : { header: head, rows: body };
}

// ------------------------------------------------------------ wai_forecast.csv
//
// The model's forecast past the data, to the end of the quarter after the
// running one. Additive like the measures files: absent is valid. What would go
// wrong silently is a forecast that overlaps the data, a band that does not
// bracket it, or a whole-quarter value sitting on a week that does not end a
// quarter -- the page would draw all three without complaint.

const FORECAST = "wai_forecast.csv";
const FORECAST_HEADER = ["date", "wai_qoq", "wai_qoq_lo", "wai_qoq_hi", "wai_yoy",
                         "wai_index", "wai_qoq_q", "wai_yoy_q"];
const quarterKey = (d) => `${d.slice(0, 4)}Q${Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1}`;
const endsQuarter = (d) => ["03", "06", "09", "12"].includes(d.slice(5, 7)) && d.slice(8, 10) === "28";

if (dateIdx !== -1 && rows.length > 0 && meta.weeks_observed !== undefined) {
  const lastDate = rows[rows.length - 1][dateIdx];
  const inQuarter = rows.filter((r) => quarterKey(r[dateIdx]) === quarterKey(lastDate)).length;
  if (meta.weeks_observed !== inQuarter) {
    fail(`wai_meta.json weeks_observed=${meta.weeks_observed} but wai_data.csv has ${inQuarter} `
      + `weeks of ${quarterKey(lastDate)}. The page labels the nowcast with this count.`);
  }
}

if (existsSync(FORECAST)) {
  const f = readFlatCsv(FORECAST, Array.isArray(meta.forecast_columns) ? meta.forecast_columns : FORECAST_HEADER);
  if (f) {
    const col = (name) => f.header.indexOf(name);
    const fd = f.rows.map((r) => r[col("date")]);
    const lastData = rows.length ? rows[rows.length - 1][dateIdx] : null;
    if (fd.some((d) => !DATE_RE.test(d))) fail(`${FORECAST} has a date that is not YYYY-MM-DD.`);
    for (let i = 1; i < fd.length; i++) {
      if (!(fd[i] > fd[i - 1])) { fail(`${FORECAST} dates are not strictly ascending at row ${i + 2}.`); break; }
    }
    if (fd.length === 0) fail(`${FORECAST} has no rows.`);
    if (lastData && fd.length && !(fd[0] > lastData)) {
      fail(`${FORECAST} starts at ${fd[0]}, not after wai_data.csv's last week ${lastData}. `
        + `The forecast must never overlap the data.`);
    }
    if (meta.forecast_end !== undefined && meta.forecast_end !== null && fd.length
        && meta.forecast_end !== fd[fd.length - 1]) {
      fail(`wai_meta.json forecast_end="${meta.forecast_end}" but ${FORECAST} ends at "${fd[fd.length - 1]}".`);
    }
    const [m, lo, hi] = ["wai_qoq", "wai_qoq_lo", "wai_qoq_hi"].map(col);
    let bad = 0;
    f.rows.forEach((r) => {
      if (r[m] === "" || !(num(r[lo]) < num(r[m]) && num(r[m]) < num(r[hi]))) bad++;
    });
    if (bad) fail(`${FORECAST}: ${bad} rows where the 95% band does not bracket wai_qoq, or wai_qoq is missing.`);
    const q = col("wai_qoq_q");
    const placed = f.rows.filter((r) => r[q] !== "");
    if (placed.some((r) => !endsQuarter(r[col("date")]))) {
      fail(`${FORECAST} has a whole-quarter wai_qoq_q on a week that does not end a quarter.`);
    }
    if (!placed.length) fail(`${FORECAST} carries no whole-quarter wai_qoq_q.`);
  }
} else if (meta.forecast_end) {
  fail(`wai_meta.json has forecast_end="${meta.forecast_end}" but ${FORECAST} is missing.`);
}

const MEASURES_META = "wai_measures_meta.json";
const CONTRIB = "wai_contributions.csv";
const NEWS = "wai_news.csv";
const SERIES = "wai_series.csv";
const CONTRIB_SERIES = "wai_contributions_series.csv";

// r2 is 1 - var(residual)/var(series) for a factor the model did not fit by
// least squares, so a series the factor explains essentially none of can come
// out a hair below zero: the published file has -0.0017 and -0.0009. A hard
// floor of 0 would therefore fail on correct data. This floor still catches the
// thing worth catching, which is an r2 that is not a share of variance at all.
const R2_FLOOR = -0.05;

let mmeta = null;
if (existsSync(MEASURES_META)) {
  try {
    mmeta = JSON.parse(stripBom(readFileSync(MEASURES_META, "utf8"), MEASURES_META));
  } catch (e) {
    fail(`${MEASURES_META} does not parse: ${e.message}`);
  }
} else {
  note(`${MEASURES_META} is absent; the measures checks are skipped. The page `
    + `omits the driver panels in that case, which is a supported state.`);
}

if (mmeta) {
  for (const field of ["vintage_date", "components", "news_available"]) {
    if (mmeta[field] === undefined || mmeta[field] === null || mmeta[field] === "") {
      fail(`${MEASURES_META} is missing "${field}", which index.html reads.`);
    }
  }
  if (mmeta.vintage_date !== undefined && mmeta.vintage_date !== meta.vintage_date) {
    fail(`${MEASURES_META} vintage_date="${mmeta.vintage_date}" but wai_meta.json says `
      + `"${meta.vintage_date}". The two are written by the same run and the page `
      + `presents the panels as describing the same vintage as the chart.`);
  }
}

const components = Array.isArray(mmeta?.components) ? mmeta.components : null;
if (mmeta && !components) fail(`${MEASURES_META} "components" is not an array.`);

// -------------------------------------------------------- wai_contributions.csv

if (existsSync(CONTRIB)) {
  const c = readFlatCsv(CONTRIB, ["date", "component", "value"]);
  if (c) {
    // index.html groups these rows by date and stacks them, so a date that is
    // not on wai_data.csv's grid would draw a bar with no WAI line above it.
    const sums = new Map();
    const seenComps = new Set();
    let offGrid = 0;
    c.rows.forEach((r, i) => {
      const [d, comp, v] = r;
      if (!DATE_RE.test(d)) {
        fail(`${CONTRIB} row ${i + 2}: date "${d}" is not YYYY-MM-DD.`);
        return;
      }
      if (!seen.has(d)) {
        if (offGrid < 5) {
          fail(`${CONTRIB} row ${i + 2}: date "${d}" is not a date in wai_data.csv.`);
        }
        offGrid++;
        return;
      }
      if (comp === "") fail(`${CONTRIB} row ${i + 2}: empty component name.`);
      seenComps.add(comp);
      if (!Number.isFinite(num(v))) {
        fail(`${CONTRIB} row ${i + 2}, value "${v}" is not a finite number.`);
        return;
      }
      sums.set(d, (sums.get(d) ?? 0) + num(v));
    });
    if (offGrid > 5) fail(`${CONTRIB}: ${offGrid - 5} further rows are off the date grid.`);

    if (components) {
      const extra = [...seenComps].filter((x) => !components.includes(x)).sort();
      const absent = components.filter((x) => !seenComps.has(x)).sort();
      if (extra.length) {
        fail(`${CONTRIB} has component(s) ${extra.join(", ")} that ${MEASURES_META} `
          + `"components" does not list. index.html reads the list from the metadata, `
          + `so an unlisted component is drawn by nothing.`);
      }
      if (absent.length) {
        fail(`${MEASURES_META} lists component(s) ${absent.join(", ")} that never `
          + `appear in ${CONTRIB}.`);
      }
    }

    // The identity: per date the components sum to wai_qoq. Values carry four
    // decimals, so the tolerance scales with how many of them are added up.
    if (qi !== -1 && dateIdx !== -1) {
      const qoq = new Map();
      rows.forEach((r) => { if (r[qi] !== "") qoq.set(r[dateIdx], num(r[qi])); });
      const nComp = seenComps.size || 1;
      const tol = 0.001 * nComp;
      let worst = 0, worstDate = null, broken = 0;
      for (const [d, s] of sums) {
        if (!qoq.has(d)) {
          fail(`${CONTRIB} decomposes ${d}, but wai_data.csv has no wai_qoq for it.`);
          continue;
        }
        const err = Math.abs(s - qoq.get(d));
        if (err > worst) { worst = err; worstDate = d; }
        if (err > tol) {
          if (broken < 5) {
            fail(`${CONTRIB}: contributions for ${d} sum to ${s.toFixed(4)} but `
              + `wai_qoq is ${qoq.get(d)} — off by ${err.toFixed(4)}, past the `
              + `${tol.toFixed(4)} rounding tolerance. The contributions panel claims `
              + `the stack adds up to the WAI line; here it does not.`);
          }
          broken++;
        }
      }
      if (broken > 5) fail(`${CONTRIB}: ${broken - 5} further dates break the identity.`);
      if (worstDate) {
        note(`${CONTRIB}: ${sums.size} dates × ${nComp} components; worst sum-vs-wai_qoq `
          + `gap ${worst.toFixed(4)} on ${worstDate} (tolerance ${tol.toFixed(4)}).`);
      }
    }
  }
} else if (mmeta) {
  note(`${MEASURES_META} is present but ${CONTRIB} is not; the contributions panel `
    + `will not render.`);
}

// ------------------------------------------------------------------ wai_news.csv
//
// news_available is the switch, not the file's presence: upstream writes no file
// at all when there is no previous fit to compare against, and the page is
// required to treat that 404 as "no news this week" rather than an error.

if (mmeta && mmeta.news_available === true) {
  if (!existsSync(NEWS)) {
    fail(`${MEASURES_META} says news_available: true but ${NEWS} does not exist.`);
  } else {
    // Long since one block per quarter (period,component,impact); the older
    // two-column file is one block for news_period.
    const head = stripBom(readFileSync(NEWS, "utf8"), NEWS).split(/\r?\n/)[0];
    const long = head.startsWith("period,");
    const n = readFlatCsv(NEWS, long ? ["period", "component", "impact"] : ["component", "impact"]);
    if (n) {
      const ci = long ? 1 : 0, ii = long ? 2 : 1;
      const sums = new Map();
      n.rows.forEach((r, i) => {
        if (!Number.isFinite(num(r[ii]))) {
          fail(`${NEWS} row ${i + 2}: impact "${r[ii]}" is not a finite number.`);
          return;
        }
        const p = long ? r[0] : mmeta.news_period;
        sums.set(p, (sums.get(p) || 0) + num(r[ii]));
        if (components && !components.includes(r[ci])) {
          fail(`${NEWS} row ${i + 2}: component "${r[ci]}" is not in ${MEASURES_META} `
            + `"components".`);
        }
      });
      const periods = Array.isArray(mmeta.news_periods) ? mmeta.news_periods
        : (mmeta.news_periods ? [mmeta.news_periods] : [mmeta.news_period]);
      const olds = [].concat(mmeta.news_nowcasts_old ?? mmeta.news_nowcast_old);
      const fresh = [].concat(mmeta.news_nowcasts_new ?? mmeta.news_nowcast_new);
      if (periods[0] !== mmeta.news_period) {
        fail(`${MEASURES_META}: news_periods starts at "${periods[0]}" but news_period is `
          + `"${mmeta.news_period}"; the first quarter must be the one news_period names.`);
      }
      for (const p of sums.keys()) {
        if (!periods.includes(p)) fail(`${NEWS} has quarter "${p}", which ${MEASURES_META} does not list.`);
      }
      periods.forEach((p, k) => {
        const o = olds[k], f = fresh[k];
        if (typeof o !== "number" || typeof f !== "number") {
          fail(`${MEASURES_META} has news_available: true but the old and new nowcast for `
            + `"${p}" are not both numbers; the news panel's caption reads them.`);
          return;
        }
        const rowsP = long ? n.rows.filter((r) => r[0] === p).length : n.rows.length;
        if (!rowsP) { fail(`${NEWS} has no rows for quarter "${p}".`); return; }
        const total = sums.get(p) || 0;
        const tol = 0.001 * Math.max(rowsP, 1);
        const gap = Math.abs(total - (f - o));
        if (gap > tol) {
          fail(`${NEWS} (${p}): impacts sum to ${total.toFixed(4)} but the revision is `
            + `${(f - o).toFixed(4)} — off by ${gap.toFixed(4)}, past ${tol.toFixed(4)}. The news `
            + `panel walks from one nowcast to the other through these impacts, so they must add up.`);
        } else {
          note(`${NEWS} (${p}): ${rowsP} impacts sum to ${total.toFixed(4)} against a `
            + `${(f - o).toFixed(4)} revision.`);
        }
      });
    }
  }
} else if (mmeta && existsSync(NEWS)) {
  note(`${NEWS} exists but ${MEASURES_META} says news_available is not true, so the `
    + `page ignores it. A leftover file from a previous run is the likely cause.`);
}

// --------------------------------------------------------- wai_news_history.csv
//
// The news of every weekly update, one block per update (date, the latest week
// of data) and quarter (period), for the page's "over the quarter" view. Built
// by the update pipeline from the published file plus the week's news. Each
// block must add up to its own revision, carry one old and one new nowcast, and
// the latest update's blocks must be this week's wai_news.csv.

const NEWS_HISTORY = "wai_news_history.csv";
if (existsSync(NEWS_HISTORY)) {
  const h = readFlatCsv(NEWS_HISTORY, ["date", "period", "nowcast_old", "nowcast_new", "component", "impact"]);
  if (h) {
    const blocks = new Map();
    let prev = "";
    h.rows.forEach((r, i) => {
      const [date, period, o, f, comp, imp] = r;
      if (!DATE_RE.test(date) || !DATE_RE.test(period)) fail(`${NEWS_HISTORY} row ${i + 2}: bad date or period.`);
      if (`${date} ${period}` < prev) fail(`${NEWS_HISTORY} row ${i + 2}: rows are not sorted by date and period.`);
      prev = `${date} ${period}`;
      if (![o, f, imp].every((x) => x !== "" && Number.isFinite(num(x)))) {
        fail(`${NEWS_HISTORY} row ${i + 2}: nowcast_old, nowcast_new and impact must be numbers.`);
        return;
      }
      const key = `${date} ${period}`;
      const b = blocks.get(key) || { o, f, sum: 0, n: 0, comps: new Set() };
      if (b.o !== o || b.f !== f) fail(`${NEWS_HISTORY} row ${i + 2}: block ${key} has more than one old or new nowcast.`);
      if (b.comps.has(comp)) fail(`${NEWS_HISTORY} row ${i + 2}: component "${comp}" twice in block ${key}.`);
      b.comps.add(comp); b.sum += num(imp); b.n++;
      blocks.set(key, b);
    });
    for (const [key, b] of blocks) {
      const gap = Math.abs(b.sum - (num(b.f) - num(b.o)));
      if (gap > 0.001 * b.n) {
        fail(`${NEWS_HISTORY} block ${key}: impacts sum to ${b.sum.toFixed(4)} but the revision `
          + `is ${(num(b.f) - num(b.o)).toFixed(4)}.`);
      }
    }
    // the latest update is this week's news
    if (mmeta && mmeta.news_available === true && existsSync(NEWS) && h.rows.length) {
      const latest = h.rows[h.rows.length - 1][0];
      const head = stripBom(readFileSync(NEWS, "utf8"), NEWS).split(/\r?\n/)[0];
      const n = readFlatCsv(NEWS, head.startsWith("period,") ? ["period", "component", "impact"] : ["component", "impact"]);
      if (n) {
        const long = head.startsWith("period,");
        const want = n.rows.map((r) => `${long ? r[0] : mmeta.news_period} ${r[long ? 1 : 0]} ${num(r[long ? 2 : 1])}`).sort();
        const got = h.rows.filter((r) => r[0] === latest).map((r) => `${r[1]} ${r[4]} ${num(r[5])}`).sort();
        if (want.join("|") !== got.join("|")) {
          fail(`${NEWS_HISTORY}: its latest update, ${latest}, is not this week's ${NEWS}. The `
            + `pipeline adds the week's news to the history; the two have come apart.`);
        }
      }
    }
    note(`${NEWS_HISTORY}: ${blocks.size} update-quarter blocks, each adding up to its revision.`);
  }
}

// ---------------------------------------------------------------- wai_series.csv

if (existsSync(SERIES)) {
  const s = readFlatCsv(SERIES,
    ["series", "name", "group", "frequency", "r2", "loading", "loading_lo", "loading_hi"]);
  if (s) {
    const ids = new Set();
    s.rows.forEach((r, i) => {
      const lineNo = i + 2;
      const [id, name, group, freq, r2, load, lo, up] = r;
      if (id === "") fail(`${SERIES} row ${lineNo}: empty series id.`);
      if (ids.has(id)) fail(`${SERIES} row ${lineNo}: duplicate series id "${id}".`);
      ids.add(id);
      if (name === "") fail(`${SERIES} row ${lineNo}: series "${id}" has no name.`);
      if (group === "") fail(`${SERIES} row ${lineNo}: series "${id}" has no group.`);
      if (components && group !== "" && !components.includes(group)) {
        fail(`${SERIES} row ${lineNo}: group "${group}" is not in ${MEASURES_META} `
          + `"components", so it shares no colour with the contributions panel.`);
      }
      if (!Number.isFinite(num(freq))) {
        fail(`${SERIES} row ${lineNo}: frequency "${freq}" is not a number.`);
      }
      for (const [label, v] of [["r2", r2], ["loading", load],
                                ["loading_lo", lo], ["loading_hi", up]]) {
        if (!Number.isFinite(num(v))) {
          fail(`${SERIES} row ${lineNo}: ${label} "${v}" is not a finite number.`);
          return;
        }
      }
      if (num(r2) < R2_FLOOR || num(r2) > 1) {
        fail(`${SERIES} row ${lineNo}: r2=${r2} is outside [${R2_FLOOR}, 1]; it is `
          + `meant to be the share of the series' variance the factor explains.`);
      }
      if (!(num(lo) <= num(load) && num(load) <= num(up))) {
        fail(`${SERIES} row ${lineNo}: loading band is inconsistent — `
          + `lo=${lo}, loading=${load}, hi=${up}.`);
      }
    });
    note(`${SERIES}: ${s.rows.length} series across `
      + `${new Set(s.rows.map((r) => r[2])).size} groups.`);
  }

  // The indicator panel: per date and group its rows must add up to that group's
  // row in wai_contributions.csv. Each value is rounded on its own, so the sum
  // can miss by half a unit of the last decimal per series.
  const cs = s && existsSync(CONTRIB_SERIES) ? readFlatCsv(CONTRIB_SERIES, ["date", "series", "value"]) : null;
  const co = cs && existsSync(CONTRIB) ? readFlatCsv(CONTRIB, ["date", "component", "value"]) : null;
  if (cs && co) {
    const groupOf = new Map(s.rows.map((r) => [r[0], r[2]]));
    const sums = new Map();
    let unknown = 0;
    cs.rows.forEach((r, i) => {
      const [d, id, val] = r;
      if (!groupOf.has(id)) {
        if (unknown++ < 5) fail(`${CONTRIB_SERIES} row ${i + 2}: series "${id}" is not in ${SERIES}.`);
        return;
      }
      if (!Number.isFinite(num(val))) fail(`${CONTRIB_SERIES} row ${i + 2}: value "${val}" is not a finite number.`);
      const key = `${d}|${groupOf.get(id)}`;
      sums.set(key, (sums.get(key) ?? 0) + num(val));
    });
    const tolerance = 0.0001 * s.rows.length;
    let worst = 0;
    co.rows.forEach((r) => {
      const key = `${r[0]}|${r[1]}`;
      if (sums.has(key)) worst = Math.max(worst, Math.abs(sums.get(key) - num(r[2])));
    });
    if (worst > tolerance) {
      fail(`${CONTRIB_SERIES}: series sum differs from the group in ${CONTRIB} by up to ${worst.toFixed(4)}.`);
    }
    note(`${CONTRIB_SERIES}: ${sums.size} date-group sums; worst difference from ${CONTRIB} ${worst.toFixed(4)}.`);
  }
} else if (mmeta) {
  note(`${MEASURES_META} is present but ${SERIES} is not; the series panel will not render.`);
}

// ------------------------------------------------ staleness of the published
//                                                    vintage  (--check-staleness)
//
// The realistic failure of the update pipeline is not a crash but the pipeline
// being quietly dead for weeks while the page serves stale numbers that look
// entirely fine. A reader can see it -- the page renders "Data as of ..." from
// vintage_date -- but nothing tells the maintainer without someone looking.
// This is the thing that tells them: run on a schedule from CI, a failed run on
// the default branch emails the repository owner, and no signal at all is the
// failure mode being replaced.
//
// Opt-in, and NOT part of the merge gate. Every other check here fails only
// when something in the repository is wrong; this one fails because a date
// passed. As a gate it would eventually block correct pull requests for a
// reason their authors cannot fix in the diff, which is how a gate teaches
// people to route around it.
//
// THE THRESHOLD IS THE WHOLE DESIGN, and today it is deliberately loose. The
// upstream input is a fixed snapshot ending 2026-04-07, so the vintage is
// frozen on purpose and will not move until the pipeline is unparked (#17). A
// threshold set to the cadence vintages are *expected* to arrive at would
// therefore be red from the day it landed -- noise from the start, and a
// permanently red scheduled job is one nobody reads. 365 days keeps the
// mechanism in place and silent through the freeze, while still being short
// enough that a year of no data is not allowed to pass unremarked.
//
// TIGHTEN THIS the day the pipeline resumes: the data is weekly, so a few weeks
// is the honest number once vintages are actually arriving.
const STALE_AFTER_DAYS = 365;

if (checkStaleness) {
  const v = meta.vintage_date;
  if (typeof v !== "string" || !DATE_RE.test(v) || Number.isNaN(Date.parse(v))) {
    fail(`--check-staleness: vintage_date "${v}" is not a YYYY-MM-DD date, so how old `
      + `the published data is cannot be determined.`);
  } else {
    const ageDays = Math.floor((Date.now() - Date.parse(`${v}T00:00:00Z`)) / 86_400_000);
    if (ageDays > STALE_AFTER_DAYS) {
      fail(`the published vintage is ${ageDays} days old (vintage_date ${v}), past the `
        + `${STALE_AFTER_DAYS}-day limit. Either the update pipeline has stopped and nobody `
        + `noticed, or the freeze is still intentional and STALE_AFTER_DAYS in `
        + `tools/validate-data.mjs is the thing that needs revisiting.`);
    } else {
      note(`vintage_date ${v} is ${ageDays} days old; the limit is ${STALE_AFTER_DAYS} days.`);
    }
  }
}

// -------------------------------------------------------------------- report

for (const n of notes) console.log(`note: ${n}`);

if (failures.length > 0) {
  console.error(`\n${failures.length} problem(s) found:\n`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(
  `OK: ${rows.length} rows, ${header.length} columns, `
  + `${rows[0]?.[dateIdx]} to ${rows[rows.length - 1]?.[dateIdx]}; `
  + `wai_meta.json agrees with the data and carries every field index.html reads.`
);
