# site-generator-speed-01 entry

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/ryukiheun/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/ryukiheun/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A fast drop-in for makefun-site 1.0.0: `solve.js` (dependency-free ES module)
reimplements its front matter, template dialect, Markdown subset, slug rule
and build report, returning byte-identical output for every case.

Practice: 3/3 cases byte-identical to the baseline. Locally measured run()
CPU ~3.1x the baseline (fresh process, median); whole-execution CPU ~2.1x
gross, ~2.7x net of the do-nothing control. Node 22, standard library only,
no network, no clock, no randomness — two runs write identical bytes.

- `main.ts` — the harness driver: reads `/input/cases.json`, answers each case
  alone with `run()`, writes `/output/answers.json`. Keeps the baseline's
  `--no-incremental-marking` V8 flag and `MAKEFUN_INPUT_DIR` /
  `MAKEFUN_OUTPUT_DIR` support.
- `solve.js` — the fast implementation. Templates are parsed once per `run()`
  and compiled to JS functions; Markdown is rendered in a single pass, its
  inline scanner using a native-regex fast path and indexOf-based closers;
  `slugify`/`longDate` are memoised per run; cards and pages are built once
  each. No state is kept between `run()` calls, no network, no WASM/native
  code, no dependencies.

## License

MIT — see `LICENSE`.
