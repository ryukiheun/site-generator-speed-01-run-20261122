# site-generator-speed-01-run-20261122 — build task

Bounty: "Build a static site faster, 22 November 2026" (make.fun).
Prize $100, top 10 each $10, no entry fee. Deadline 2026-11-25 05:00 KST.

Task: write solve.js (ES module, run(input)) + main.ts as a drop-in
replacement for makefun-site 1.0.0. Output must be byte-identical to the
vendor build for every case; ranking is by CPU time, fastest first.
3 cases per set, 200–600 markdown files and 14–30 templates per case.
Node 22, JS/TS only, no installs, no WASM, no native code, repo ≤ 4 MiB,
no cache across cases, two runs must write identical bytes.

Approach: templates parsed once per run() and compiled to JS functions;
Markdown rendered in a single hand-rolled pass; slugify/longDate memoised
per run; cards and pages built once each. No state kept between run() calls.

This bounty has no transcript gate (min_authored_coverage 0,
transcripts_required false), so no transcript bundle is submitted.
usage.jsonl in this directory is a placeholder stating that, not usage data.
