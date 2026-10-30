**中文** · [README.md](./README.md)

<p align="center">
  <img src="assets/banner.svg" alt="doctors" width="640">
</p>

<p align="center">
  <a href="https://github.com/huanweide/doctors/stargazers"><img src="https://img.shields.io/github/stars/huanweide/doctors" alt="Stars"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/huanweide/doctors" alt="License"></a>
  <a href="https://github.com/huanweide/doctors/blob/main/package.json"><img src="https://img.shields.io/badge/dependencies-0-brightgreen" alt="Zero dependency"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D18-339933" alt="Node"></a>
</p>

# doctors · the code-health checkup bundle

> Others give you a "green light"; we give you a **conclusion you can trust**: 21 checkup axes behind one entry point, zero-dependency, offline, read-only — **if no gate threshold is configured, it says `inconclusive`, never lies to you with a green light**.

`one repo → one clone → pick any of 21 axes → health score + severity → CI gate (pass / fail / inconclusive)`

[30-second overview](#30-second-overview) · [What it does](#what-it-does) · [Features](#features) · [Quick start](#quick-start) · [Axis index](#axis-index) · [CLI cheat sheet](#cli-cheat-sheet) · [Architecture](#architecture) · [Add your own axis](#add-your-own-axis) · [Roadmap](#roadmap) · [Contributing](#contributing) · [Security boundary](#security-boundary)

## 30-second overview

No install, no config, no network. Clone it and the first command already checks your own project:

```console
$ git clone https://github.com/huanweide/doctors.git && cd doctors
$ node cli.js repo .

=== repodoctor repository hygiene ===
Repo: /home/you/my-project
Issues found: 3
  [LOW ] secret leak   packages/commitdoctor/test.js
         known false-positive hit (exempted to low): -----BEGIN PRIVATE KEY----- — reason: unit-test crafted key-detection sample (not a real credential)
  [MED ] lockfile   (whole repo)
         has package.json but no dependency lockfile; dependencies not reproducible

Health score: 88 / 100  (HIGH 0 / MED 1 / LOW 2)
```

The difference in one line: **most scanners report "nothing found / no threshold set" as passed; doctors reports it as `inconclusive` (undecided, not the same as passed).**

```console
$ node cli.js cyc scan --root ./packages/litdoctor

    [high] index.js:353  cyclomatic complexity too high
          cyclomatic complexity 20 > threshold 10 (too many branches; suggest split function / early return / lookup table)
  Health score       : 0 / 100  [structural risk high]
  Gate: undecided (conclusion untrustworthy, not the same as passed)  [state=inconclusive configured=false]
     reason: no gate threshold configured; this output is in no way a "gate passed" conclusion. Pass --max-high / --max-complexity / … explicitly.
```

## What it does

One command for the whole picture — the `eng` axis is the meta-dashboard of the **Engineering Health Family** (a collection of zero-dependency code-checkup tools), aggregating the scattered axes into one scorecard and one total score:

```console
$ node cli.js eng . --tools-dir ./packages

========================================
 Engineering Health Family · Unified Report (enghealth)
========================================
Overview health : 97/100 (enghealth's own zero-dep scan)
Sibling tools joined : 7/14
----------------------------------------
Dimension            Category   Score        Status
Repo hygiene         git   88      fair
Commit convention    git   100     good
Release consistency  git   88      fair
Config convention    config    88      fair
Security antipattern source    0        attention
Async perf           source    8        attention
----------------------------------------
Total : 59/100
CI gate: PASS
```

To investigate a specific class of problem, run that one axis on its own:

```console
$ node cli.js sec ./src        # security antipatterns: eval / exec concat / plaintext http / SQL concat / weak random
$ node cli.js debt doctor .    # tech-debt density: TODO / FIXME / HACK comment anchoring count
$ node cli.js gha .            # GitHub Actions: unpinned action / script injection / over-broad permissions
$ node cli.js chain impact src/core/parser.js   # changed parser, who is affected
```

## Who should use this

- You want a single, offline, zero-dependency toolkit that health-checks many code dimensions behind one command.
- You need CI gates whose third state is "inconclusive" rather than a misleading green light.

## Who should NOT use this

- You need deep, language-specific analyzers with rich rule configs (e.g. ESLint/SonarQube depth) — doctors favors zero-config breadth over per-axis depth.
- You must run it in a fully air-gapped CI without the ability to clone from GitHub — each axis is a local file, but first you need the clone.

## Features

- **🩺 21 axes, one entry point** — the eight cores `a11y / commit / dev / doc / pkg / rel / repo / type`, plus thirteen standalone axes `sec / cyc / dup / lit / debug / debt / await / chain / gha / lic / idiot / test / eng`; all dispatched through `cli.js`, arguments forwarded verbatim.
- **🚦 Three-state gate** — `pass(0) / fail(2) / inconclusive(3)`. No threshold configured, or empty scan input → `inconclusive`, **never falsely reports passed**; this is the project's most important invariant, nailed down line-by-line by `scripts/smoke-cli.js` on the exit-code contract.
- **📊 Anti-vanity-metric** — when 0 files are scanned, it does not hand out 100; the health score is `null` (unassessable). No "empty scan = full marks" to stop your thinking.
- **🔬 Evidence-anchored** — every conclusion lands on `file:line`; `--json` carries `basisComplete`, telling you explicitly "is this scan's baseline trustworthy".
- **🧬 Zero-dependency single file** — each axis is one `index.js`, only the Node standard library (`fs` / `path`); it changes none of your code, touches no network, executes none of your code.
- **🐕 Dogfood bootstrap** — CI runs all 21 axes against doctors itself: if new code introduces a smell its own rules reject, it is blocked on the spot (see the `dogfood` job in `.github/workflows/ci.yml`).
- **🧭 Meta dashboard** — the `eng` axis aggregates discovered sibling CLIs into one table; missing or failed ones are downgraded to "skipped", never misjudged as failed.

## Quick start

**Zero-dependency, zero-install.** Only Node.js >= 18:

```bash
git clone https://github.com/huanweide/doctors.git
cd doctors
node cli.js --help
```

One-line pull-and-run (needs the machine to reach GitHub directly):

```bash
npx -y github:huanweide/doctors repo .
```

### Check your own project

```bash
node cli.js repo .                    # repo layer: dangerous files / secrets / large files / LICENSE
node cli.js sec  ./src                # security layer: eval / exec / plaintext http / SQL concat
node cli.js type ./src --json         # type layer: any density
```

Wire into CI (block the commit below threshold):

```bash
node cli.js repo . --min-score 70
node cli.js sec  ./src --fail-on-high
node cli.js cyc  scan --root ./src --max-complexity 15
```

### Use a single axis on its own

Each package directory is an independent single-file CLI that runs standalone out of the monorepo (no `npm install`):

```bash
node packages/repodoctor/index.js .
node packages/secscan/index.js ./src --json
node packages/typedoctor/typedoctor.js ./lib --json
```

> **On commands like `npx repodoctor`**: each package is **not published to npm yet**, so `npx repodoctor` does not work currently — use `node packages/<name>/index.js` or `node cli.js <subcommand>`.

### Global command (optional)

```bash
npm link        # register doctors as a global command
doctors --help
doctors repo .
```

### Run all self-checks

```bash
node scripts/run-all-tests.js   # 21 packages' unit tests + CLI smoke (spawn-level exit-code contract)
npm test                        # same as above
```

Real output (all green locally):

```console
=== a11ydoctor ===
=== awaitscan ===
…
=== typedoctor ===
ALL DOCTORS PASSED (21/21 packages)
```

## Axis index

21 axes, grouped by governance layer. **The "command" column is the copy-paste-correct form** — axes are not called uniformly (some take positional args, some require a submode before `--root`); copying the wrong one fails silently.

### Source layer

| Axis | Package | Checks | Command | Severity | CI gate |
| --- | --- | --- | --- | --- | --- |
| `type` | typedoctor | Type discipline (explicit-any / any-cast / ts-ignore / double-cast) | `node cli.js type ./src` | high / medium / low | `--fail-on-high` `--max-issues` `--max-high` `--min-score` |
| `sec` | secscan | Security antipatterns (eval, exec concat, TLS disabled, plaintext http, SQL concat, weak random) | `node cli.js sec ./src` | high / medium / low | `--fail-on-high` `--max-high` `--max-medium` `--max-low` `--max-issues` |
| `cyc` | cycscan | Structural complexity (cyclomatic >10, function length >60 lines) | `node cli.js cyc scan --root ./src` | high / medium | `--max-complexity` `--max-lines` `--max-high` `--fail-on-high` `--max-issues` |
| `dup` | dupscan | Duplicate code blocks (line-by-line n-gram sliding window, default ≥5 lines) | `node cli.js dup ./src` | high / medium | `--max-issues` `--max-lines` `--fail-on-high` |
| `lit` | litdoctor | Hardcoded magic values / repeated literals | `node cli.js lit ./src` | medium / low (no high rule yet) | `--max-issues` `--max-medium` `--max-low` `--min-score` |
| `debug` | debugdoctor | Debug & log leftovers (debugger / console.* / print / fmt.Print*) | `node cli.js debug ./src` | high / medium | `--fail-on-high` `--max-high` `--max-medium` `--max-issues` `--min-score` |
| `debt` | debtlens | Tech-debt density (TODO / FIXME / HACK… comment-anchored, severity-weighted) | `node cli.js debt doctor --root .` | weighted density (not three-tier) | `--max-density` `--max-weighted` `--max-total` `--fail-on-tags` `--fail-on-issues` |
| `await` | awaitscan | Async performance antipatterns (serial await in loop, await in map, nested loop) | `node cli.js await scan --root ./src` | high / medium | `--max-high` `--max-medium` `--max-issues` `--fail-on-high` `--fail-on-issues` |
| `a11y` | a11ydoctor | Web accessibility (HTML / JSX / Vue / Svelte semantic antipatterns) | `node cli.js a11y ./src` | high / medium / low | `--fail-on high` (values `high`/`any`/`none`, different syntax from other axes) `--max <n>` |

### Dependency / architecture layer

| Axis | Package | Checks | Command | Severity | CI gate |
| --- | --- | --- | --- | --- | --- |
| `dev` | devdoctor | Four-dimensional project checkup (dependency fatness / license / dependency cycle / plaintext secret) | `node cli.js dev doctor .` | per submode | `--fail-on <mode>` `--max <n>` |
| `pkg` | pkgdoctor | package.json metadata & dependency-declaration hygiene | `node cli.js pkg .` | high / medium / low | `--fail-on-high` `--max-issues` `--max-high` `--min-score` |
| `lic` | licguard | Dependency license compliance (strong copyleft GPL/AGPL, weak copyleft LGPL/MPL, unknown) | `node cli.js lic .` | strong / weak / unknown / permissive | `--fail-on <mode>` `--max <n>` `--allow-missing` |
| `idiot` | idiot-index | Idiot index: redundant dependencies replaceable by native APIs + over-engineering | `node cli.js idiot .` | grades A–F (index 0–100) | `--max <n>` `--require-usage` |
| `chain` | chaineye | Dependency-chain blast radius (changed X → who affected; cycles / orphans / hubs) | `node cli.js chain .` | cycles / orphans | `--max-cycles` `--max-orphans` `--fail-on-cycle` |

### Git / CI layer

| Axis | Package | Checks | Command | Severity | CI gate |
| --- | --- | --- | --- | --- | --- |
| `repo` | repodoctor | Repo hygiene (dangerous files / secret leaks / large files / LICENSE / README / lockfile) | `node cli.js repo .` | high / medium / low | `--fail-on-high` `--min-score <s>` |
| `commit` | commitdoctor | Git commit-message convention smells | `node cli.js commit .` | high / medium / low | `--fail-on-high` `--max-issues` `--max-high` `--min-score` |
| `rel` | reldoctor | Release hygiene (version / git tag / CHANGELOG three-way consistency) | `node cli.js rel .` | high / medium / low | `--fail-on-high` `--max-issues` `--max-high` `--min-score` |
| `gha` | ghadoctor | GitHub Actions config hygiene (unpinned action / script injection / over-broad permissions / PR target checkout) | `node cli.js gha .` | high / medium | `--fail-on-high` `--max-high` `--max-medium` `--max-issues` `--min-score` |

### Docs / test layer · meta layer

| Axis | Package | Checks | Command | Severity | CI gate |
| --- | --- | --- | --- | --- | --- |
| `doc` | docdoctor | Markdown doc health (dead links / anchors / level skips / missing alt / bare URL) | `node cli.js doc ./docs` | high / medium / low | `--fail-on-high` `--max-issues` `--max-high` |
| `test` | testlite | Test hygiene (framework detection / test discovery / density estimate / zero-test warning / coverage config) | `node cli.js test doctor --root .` | check items + health score | `--min-tests` `--min-density` `--fail-on-issues` |
| `eng` | enghealth | Meta dashboard: aggregate family sibling CLIs, one command → one scorecard + total | `node cli.js eng . --tools-dir ./packages` | total + per-axis scores | `--fail-on-low <n>` `--min-overall <n>` |

> Git-dependent axes (`repo` / `commit` / `rel`) must run inside a Git repo; a non-git directory errors explicitly with a non-zero exit code, **never silently passing**.
> Each axis's full parameters are per its `--help` (e.g. `node cli.js sec --help`).

### Already-merged standalone repos

`secscan / cycscan / dupscan / litdoctor / ghadoctor / debugdoctor / debtlens / awaitscan / chaineye / enghealth / idiot-index / licguard / testlite` — thirteen former standalone repos were merged wholesale into this monorepo's `packages/`, byte-for-byte, keeping their zero-dependency single-file nature; the original repos are now archived (read-only), kept as historical reference, and all new changes go here.

## CLI cheat sheet

| Command | Purpose |
| --- | --- |
| `node cli.js --help` | Print all 21 subcommands (grouped by governance layer) |
| `node cli.js --version` | Print version |
| `node cli.js <axis> [target] [options]` | Run one axis, arguments forwarded verbatim to the package |
| `node cli.js <axis> --json` | Machine-readable output (for CI) |
| `node scripts/run-all-tests.js [pkg]` | Run all (or a named package's) self-checks: unit tests + CLI smoke |
| `node scripts/smoke-cli.js` | Only the entry-point smoke (21 subcommand startups + exit-code contract) |
| `npm test` | Equivalent to `node scripts/run-all-tests.js` |

## Architecture

**Narrative**: one dispatcher (`cli.js`) + 21 single-file CLIs that do not know each other. The axes are zero-coupled — delete any one and `cli.js` just loses a subcommand, the other 20 keep running. Uniformity appears in only three conventions: **entry shape** (`packages/<name>/index.js`), **output shape** (severity + health score + `--json`), and **gate shape** (three-state exit code).

### Core concepts

| Concept | Meaning |
| --- | --- |
| axis | One checkup dimension = one zero-dep single-file CLI = `packages/<name>/index.js` |
| severity | `high` / `medium` / `low` (some axes grade by their own semantics, e.g. licguard's strong/weak/unknown) |
| health score | Composite 0–100; **`null` when scan input is empty, never 100** |
| three-state gate | `pass` met / `fail` unmet / `inconclusive` cannot conclude (no threshold or empty input) |
| exit-code contract | `0` pass · `2` fail or argument error · `3` inconclusive (a few axes use `1` for internal error) |
| basisComplete | `--json` field: did this scan see enough input to trust the health score |
| dogfood | Run all 21 axes against doctors itself; CI forcibly blocks its own smells |

### Dispatch chain

```
node cli.js <axis> [args...]
        │
        ├─ look up SUBCOMMANDS table ──► packages/<pkg>/package.json (get bin entry)
        │                              │
        │                              └─► spawn node packages/<pkg>/index.js [args...]
        │                                        │
        │                                        ├─ read-only scan (fs / path, never writes files)
        │                                        ├─ severity grading ──► health score
        │                                        └─ gate decision ──► exit 0 / 2 / 3
        └─ unknown subcommand ──► exit 2 (never treated as passed)

Self-check chain: scripts/run-all-tests.js ──► each package's test.js (or test/unit.test.js) + smoke-cli.js
                                       (cwd set to the package dir, keeping relative paths stable)
```

### Core modules

| Module | File | Description |
| --- | --- | --- |
| Unified entry dispatcher | `cli.js` | 21 subcommands → package bin mapping, arg forwarding, layered help |
| Aggregated self-check | `scripts/run-all-tests.js` | Probe each package's `test.js` / `test/unit.test.js` + smoke, can target one package |
| Entry smoke | `scripts/smoke-cli.js` | Spawn-level verification: 21 subcommands start, exit-code contract does not regress |
| Axis implementation | `packages/<name>/index.js` | All logic for one axis (single-file, zero-dep, runnable standalone) |
| Axis self-check | `packages/<name>/test.js`, `test/unit.test.js`, `test` or `scripts/smoke-cli.js` | Unit tests + CLI exit-code contract |
| CI | `.github/workflows/ci.yml` | Node 18/20/22 matrix runs all self-checks + dogfood bootstrap |

## Add your own axis

Three things, five minutes — the new axis is automatically picked up by `cli.js` and `run-all-tests.js`:

1. Create the directory and entry (must be a **CommonJS `index.js`**, filename pointed to by `package.json`'s `bin`):

```
packages/mydoctor/
├── index.js      # all logic: read-only scan → severity → health score → three-state gate
├── test.js       # self-check (node:test or your own runner)
└── package.json  # { "name": "mydoctor", "bin": { "mydoctor": "index.js" } }
```

2. Add one line each to `cli.js`'s `SUBCOMMANDS` / `DESCRIPTIONS` / `GROUPS`:

```js
const SUBCOMMANDS = { /* … */ my: 'mydoctor' };
const DESCRIPTIONS = { /* … */ my: 'my custom checkup axis' };
```

3. Add `my` to `EXPECTED_SUBS` in `scripts/smoke-cli.js`; CI guards it from regressing.

Discipline: zero-dependency, read-only, invalid arguments always `exit 2`, no gate threshold always `exit 3` (inconclusive) — **never silently passing**.

## Roadmap

- [x] Eight-core doctors brought into the monorepo
- [x] Thirteen standalone axes merged wholesale (`sec / cyc / dup / lit / debug / debt / await / chain / gha / lic / idiot / test / eng`)
- [x] Layered help at the unified entry + 21-axis entry smoke
- [x] Three-state gate and the "empty input never gets 100" invariant
- [ ] Publish axes to npm (currently `npx <axis>` is unavailable; only `node packages/<name>/index.js` works)
- [ ] Unify gate parameter names (axes evolved independently, naming is inconsistent — see the axis index "CI gate" column)
- [ ] Persist cross-axis aggregate reports (HTML / Markdown checkup archive)
- [ ] Auto-sync the `eng` axis's sibling-discovery list as new axes are added (currently hardcoded to 14)

## Contributing

PRs welcome. Three hard gates:

1. A new axis must be zero-dependency, single-file, offline, and ship a self-check (`test.js` or `test/unit.test.js`).
2. `node scripts/run-all-tests.js` must be fully green; `node scripts/smoke-cli.js` must not regress.
3. Gate decisions must not "lie about passing": when a conclusion cannot be determined, output `inconclusive`, not `pass`.

## Security boundary

- **Read-only**: every axis uses only `fs` / `path` to read files, **never modifying, deleting, or writing your source**.
- **No network**: zero network requests; the `eng` axis calls sibling CLIs via local processes, sending no data outward.
- **Does not execute the code under test**: static analysis only, no `require` / `eval` of your source.
- **Does not read secrets**: axes only recognize patterns of "suspected plaintext secrets" and warn; they do not collect, transmit, or persist secret content.
- **False-positive-first**: rather over-report (with an exemption comment) than under-report — a security axis that under-reports is the same as lying about being clean.

## License

MIT · © huanweide — see [LICENSE](LICENSE).

---

## ⭐ Star

21 axes, zero-dependency, offline. If it ever blocked a bad commit for you, please [give it a Star](https://github.com/huanweide/doctors) — it is this project's only growth metric.

← [Back to the code-health family overview](https://github.com/huanweide/family-showcase)
