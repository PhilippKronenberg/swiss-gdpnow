// Turns the JSON a11y-audit.mjs writes into markdown for the run summary page.
//
// The audit's own console output is fine but it scrolls past inside a job log,
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

// One entry per palette: the page is audited three times, because it has three
// palettes and a single pass grades whichever one the browser happens to be in.
const pages = JSON.parse(readFileSync(path, "utf8"));

const out = [];
const say = (...lines) => out.push(...lines);

const engine = pages[0]?.testEngine?.version ?? "unknown";
const url = pages[0]?.url ?? "the served page";

say("## Accessibility audit (advisory)", "");
say(`axe-core ${engine} against ${url}, once per palette.`, "");

say("| Palette | Violations | Rules passed | Need a human |", "| --- | --: | --: | --: |");
for (const page of pages) {
  say(
    `| \`${page.label}\` | ${page.violations.length} | ${page.passes.length} | ` +
      `${page.incomplete.length} |`,
  );
}
say("");

for (const page of pages) {
  say(`### \`${page.label}\``, "", `${page.description}`, "");

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
      for (const node of v.nodes) {
        // The failure summary carries the measured contrast ratio and the two
        // colours, which is the whole finding for the class of bug this page
        // actually produces. Losing it means opening the JSON artefact.
        const why = (node.failureSummary ?? "").split("\n").slice(1).join(" ").trim();
        say(why ? `${node.target.join(" ")}\n    ${why}` : node.target.join(" "));
      }
      say("```", "");
    }
    say("</details>", "");
  }

  if (page.incomplete.length > 0) {
    const ids = page.incomplete.map((r) => `\`${r.id}\``).join(", ");
    say(`Needs manual review: ${ids}`, "");
  }
}

// Said plainly because a green-looking summary invites the wrong conclusion.
say(
  "Automated testing catches perhaps 20-50% of accessibility problems. A clean " +
    "result is not a claim that the page is accessible.",
);

console.log(out.join("\n"));
