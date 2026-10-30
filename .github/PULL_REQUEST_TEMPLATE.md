## Description
Briefly describe the change and its rationale.

## Type of Change
- [ ] New feature (e.g. new channel, CLI flag, Split-Horizon heuristic)
- [ ] Bug fix (e.g. false positive in slop classifier, dork operator overflow)
- [ ] Domain list update (`blocklist.json` or `sources.json`)
- [ ] Documentation / README improvement
- [ ] Test suite addition

## Checklist
- [ ] Verified both TypeScript and Python suites pass via `npm run verify`
- [ ] If updating `data/*.json`, synchronized files with `python/deslop_search/data/`
- [ ] Tested CLI commands manually (`dist/cli.js` & `python -m deslop_search`)
- [ ] Kept the `SlopClassifier` deterministic and $O(N)$ with zero runtime network calls
