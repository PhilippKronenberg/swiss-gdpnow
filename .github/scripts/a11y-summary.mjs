// Turns the JSON @axe-core/cli writes into markdown for the run summary page.
//
// The CLI's own console output is fine but it scrolls past inside a job log,
// and this job is advisory -- nobody opens a log for a check that cannot block
// them. Putting the findings on the summary page is the difference between a
// report that gets read and one that does not.
//
// Node built-ins only, like tools/validate-data.mjs: CI must not be what
// introduces a dependency into a repository that deliberately has none.

import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  console.error("usage: a11y-summary.mjs <axe-results.json>");
  process.exit(2);
}

// The CLI can audit several URLs, so it always saves an array. This job passes
// exactly one.
const [page] = JSON.parse(readFileSync(path, "utf8"));

const out = [];
const say = (...lines) => out.push(...lines);

say("## Accessibility audit (advisory)", "");
say(`axe-core ${page.testEngine.version} against ${page.url}`, "");
say(
  `**${page.violations.length} violated**, ${page.passes.length} rules passed, ` +
    `${page.incomplete.length} need a human to look.`,
  "",
);

if (page.violations.length === 0) {
  say("No automatically detectable violations.", "");
} else {
  const byCount = [...page.violations].sort((a, b) => b.nodes.length - a.nodes.length);
  say("| Impact | Rule | Elements | Description |", "| --- | --- | --: | --- |");
  for (const v of byCount) {
    say(`| ${v.impact} | [\`${v.id}\`](${v.helpUrl}) | ${v.nodes.length} | ${v.help} |`);
  }
  say("", "<details><summary>The elements involved</summary>", "");
  for (const v of byCount) {
    say(`**${v.id}**`, "", "```");
    for (const node of v.nodes) say(node.target.join(" "));
    say("```", "");
  }
  say("</details>", "");
}

if (page.incomplete.length > 0) {
  const ids = page.incomplete.map((r) => `\`${r.id}\``).join(", ");
  say(`Needs manual review: ${ids}`, "");
}

// Said plainly because a green-looking summary invites the wrong conclusion.
say(
  "Automated testing catches perhaps 20-50% of accessibility problems, and " +
    "this run audits the light theme only. A clean result is not a claim that " +
    "the page is accessible.",
);

console.log(out.join("\n"));
