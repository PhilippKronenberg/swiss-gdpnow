// Runs axe-core against the served page once per palette.
//
// The page has three palettes -- a light `:root`, a
// `@media (prefers-color-scheme: dark)` override, and a `:root[data-theme="dark"]`
// block for the toggle -- and headless Chrome defaults to light, so a single
// audit grades one of the three. Both contrast defects this repository has
// produced so far (#11, #15) lived in a dark block and CI was green through
// both. #11 lived *only* in the toggle block, so reaching dark through
// `prefers-color-scheme` emulation alone would still have missed it.
//
// So: three passes. Light, dark reached through the toggle button, and dark
// reached through the media query.
//
// `@axe-core/cli` has no way to set a theme before it audits -- there is no
// pre-navigation hook and no `prefers-color-scheme` flag -- so this drives
// Chrome itself. It talks W3C WebDriver to the preinstalled chromedriver over
// plain HTTP with `fetch`, which keeps the promise the rest of this repository
// makes: Node built-ins only, nothing installed into the repository. axe-core
// itself is fetched at run time by the workflow the way html-validate is.
//
// Usage: a11y-audit.mjs <url> <path-to-axe.js> <output.json>

import { spawn } from "node:child_process";
import { accessSync, constants, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [url, axeSourcePath, outPath] = process.argv.slice(2);
if (!url || !axeSourcePath || !outPath) {
  console.error("usage: a11y-audit.mjs <url> <path-to-axe.js> <output.json>");
  process.exit(2);
}

const PORT = 9515;
const BASE = `http://127.0.0.1:${PORT}`;
const axeSource = readFileSync(axeSourcePath, "utf8");

// GitHub's runners ship a chromedriver matched to their Chrome and point
// $CHROMEWEBDRIVER at it. Prefer that one over whatever is on PATH, which may
// be an unrelated build: a chromedriver a major version behind its browser
// refuses to start a session at all.
function chromedriverBinary() {
  const candidates = [
    process.env.CHROMEWEBDRIVER && join(process.env.CHROMEWEBDRIVER, "chromedriver"),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      accessSync(c, constants.X_OK);
      return c;
    } catch {
      /* fall through to PATH */
    }
  }
  return "chromedriver";
}

// --- WebDriver over fetch --------------------------------------------------

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  // WebDriver reports failures in the body, not only in the status line.
  if (!res.ok || json.value?.error) {
    throw new Error(
      `${method} ${path} failed: ${json.value?.error ?? res.status} ` +
        `${json.value?.message ?? ""}`.trim(),
    );
  }
  return json.value;
}

async function waitForDriver() {
  for (let i = 0; i < 40; i++) {
    try {
      const status = await call("GET", "/status");
      if (status.ready) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("chromedriver never became ready");
}

// The same flags the job used when it drove Chrome directly. `--headless=new`
// rather than the old headless: the old one is a separate browser with its own
// rendering quirks, and the whole point here is to grade what a reader sees.
const CHROME_ARGS = [
  "--headless=new",
  "--no-sandbox",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--window-size=1280,1024",
];

async function newSession() {
  const { sessionId } = await call("POST", "/session", {
    capabilities: {
      alwaysMatch: { browserName: "chrome", "goog:chromeOptions": { args: CHROME_ARGS } },
    },
  });
  const s = {
    id: sessionId,
    get: (path) => call("GET", `/session/${sessionId}${path}`),
    post: (path, body) => call("POST", `/session/${sessionId}${path}`, body),
    quit: () => call("DELETE", `/session/${sessionId}`).catch(() => {}),
  };
  // axe on a page this size is quick, but the default script timeout is 30s
  // and a timeout here would look like a page defect rather than a budget.
  await s.post("/timeouts", { script: 90000, pageLoad: 60000 });
  return s;
}

const exec = (s, script, args = []) => s.post("/execute/sync", { script, args });
const execAsync = (s, script, args = []) => s.post("/execute/async", { script, args });

// chromedriver's vendor passthrough to the DevTools Protocol. This is how
// `prefers-color-scheme` gets emulated; WebDriver proper has no equivalent.
const cdp = (s, cmd, params = {}) => s.post("/goog/cdp/execute", { cmd, params });

// --- the passes ------------------------------------------------------------

// Asserts the page actually rendered before anything grades it. The failure
// this guards against is silent: if the CSV never arrives, axe still runs,
// still reports, and still looks like a real audit of a page that mostly is
// not there. Repeated in front of every pass, because a theme switch that
// broke the page must not read as a clean audit either.
async function confirmRendered(s, label) {
  const deadline = Date.now() + 20000;
  let state;
  for (;;) {
    state = await exec(
      s,
      `return {
         tiles: document.querySelectorAll(".stat-value").length,
         canvasSized: !!document.querySelector("#chart[width]"),
         controls: !!document.querySelector(".controls"),
         banner: document.getElementById("error-banner")?.hidden === true,
         theme: document.documentElement.getAttribute("data-theme"),
         bg: getComputedStyle(document.documentElement).getPropertyValue("--surface-0").trim()
       };`,
    );
    if (state.tiles >= 1 && state.canvasSized && state.controls && state.banner) break;
    if (Date.now() > deadline) {
      throw new Error(
        `[${label}] the dashboard never rendered: ` + JSON.stringify(state),
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log(
    `[${label}] rendered: ${state.tiles} stat tiles, ` +
      `data-theme=${state.theme ?? "(unset)"}, --surface-0=${state.bg}`,
  );
  return state;
}

async function runAxe(s, label) {
  await execAsync(s, `${axeSource}\narguments[0]();`);
  const results = await execAsync(
    s,
    `var done = arguments[0];
     axe.run(document, {})
       .then(function (r) { done({ ok: true, results: r }); })
       .catch(function (e) { done({ ok: false, message: String(e) }); });`,
  );
  if (!results.ok) throw new Error(`[${label}] axe.run failed: ${results.message}`);
  return results.results;
}

// The toggle is the path both known bugs were on, so take it: press the real
// button and let the page's own handler run, rather than setting the attribute
// behind its back. The handler flips relative to the current theme, so assert
// where it landed instead of assuming one press is enough.
async function applyToggleDark(s) {
  for (let i = 0; i < 3; i++) {
    const theme = await exec(
      s,
      `document.getElementById("theme-btn").click();
       return document.documentElement.getAttribute("data-theme");`,
    );
    if (theme === "dark") return;
  }
  throw new Error("the theme button never reached data-theme=dark");
}

const PASSES = [
  {
    label: "light",
    description: "the :root palette, as a reader on a light system sees it",
    async setup() {
      /* headless Chrome defaults to light; nothing to do */
    },
  },
  {
    label: "dark-toggle",
    description: 'the :root[data-theme="dark"] palette, reached by pressing the theme button',
    async setup(s) {
      await applyToggleDark(s);
    },
  },
  {
    label: "dark-media",
    description: "the @media (prefers-color-scheme: dark) palette, reached by emulating a dark system",
    async before(s) {
      await cdp(s, "Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: "dark" }],
      });
    },
    async setup() {
      /* the media query does the work */
    },
  },
];

// --- run -------------------------------------------------------------------

const driver = spawn(chromedriverBinary(), [`--port=${PORT}`, "--allowed-ips=127.0.0.1"], {
  stdio: ["ignore", "pipe", "inherit"],
});
driver.stdout.resume();

const pages = [];
let failed = false;

try {
  await waitForDriver();

  for (const pass of PASSES) {
    console.log(`--- ${pass.label}: ${pass.description}`);
    // A session per pass, not a reload: the toggle writes wai-theme into
    // localStorage, and a fresh session is the only way to be sure the next
    // pass is grading the palette it says it is.
    const s = await newSession();
    try {
      if (pass.before) await pass.before(s);
      await s.post("/url", { url });
      await confirmRendered(s, pass.label);
      await pass.setup(s);
      // The theme switch re-renders the chart; give the DOM a moment to settle
      // before measuring colours against it.
      await confirmRendered(s, pass.label);
      const results = await runAxe(s, pass.label);
      console.log(
        `[${pass.label}] ${results.violations.length} violations, ` +
          `${results.passes.length} passes, ${results.incomplete.length} incomplete`,
      );
      if (results.violations.length > 0) failed = true;
      pages.push({ label: pass.label, description: pass.description, ...results });
    } finally {
      await s.quit();
    }
  }
} catch (e) {
  // Loud and distinct from a violation: exit 1 means the page broke a rule,
  // exit 2 means the audit never happened and the run says nothing about the
  // page either way. Both are red, but only one is a finding.
  console.log(`::error::a11y audit could not run: ${e.message}`);
  driver.kill();
  process.exit(2);
} finally {
  driver.kill();
}

writeFileSync(outPath, JSON.stringify(pages, null, 2));
console.log(`wrote ${outPath}`);

// Mirrors what `@axe-core/cli --exit` did: red when the page violates
// something. The job is `continue-on-error`, so red informs rather than blocks.
process.exit(failed ? 1 : 0);
