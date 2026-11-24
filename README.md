# mend

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/auditore96/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/auditore96/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

One patch tool for every AI edit format, entered in the make.fun bounty
[Build mend, one patch tool for every AI edit format](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).

`main.ts` is a dependency-free Node 22 CLI whose `node main.ts [options] [PATCH]`
applies AI-written edits in four formats — unified diff (even with wrong line
numbers), SEARCH/REPLACE blocks, V4A patches, and JSON tool calls — to a tree
of text files, exactly as `SPEC.md` specifies. It finds the lines an edit names
at the first of three fuzzy matching tiers (exact, ignore trailing whitespace,
ignore leading and trailing whitespace with re-indentation) and changes every
file or none: a failed edit changes nothing, but later edits still run and all
failures are reported.

`runner.ts` is the kit's trial runner, kept exactly as shipped: it reads the
trial's checks, runs `main.ts` on each one in a fresh directory, and posts the
exit code, stdout, and resulting files.

## Verification

- Practice set: **100 of 100 checks pass, score 1000** (the kit starter
  scores 24/100). Verified with the kit's `check.ts` on Node 22.23.4 (the
  grader's version) and on Node 24.
- 21 extra adversarial checks, all passing: V4A pure moves, chained moves
  (`R a.txt -> c.txt`), `--check` with moves (no files written), SEARCH/REPLACE
  `--strict`, and parse errors reported at the right place.
- Deterministic: the same check gives the same exit code, stdout, and files
  every run; no times or randomness in the output.
