# MiniMax, MiMo and Kimi provider presets

Scope: native execution profiles, not classifiers or endpoint switching. Prepare 1.19.0; do not tag, push or publish. Live synthetic experiments have an operator-approved $5 total ceiling. The scripts enforce per-invocation ceilings; the supervisor tracks the aggregate manually. Credentials stay outside artifacts. Chezmoi source remains the owner of local configs.

### Task 1: Establish provider contracts and evidence

- [x] Verify current model IDs, prices, context, image support and Anthropic-compatible effort controls against primary sources.
- [x] Run bounded synthetic compatibility and activity experiments; record request settings, objective checks, usage, latency, costs and limits without secrets.

### Task 2: Implement and test defaults

- [x] Add minimal MiniMax, MiMo and Kimi presets with routes, activities, subagents and conservative cache accounting.
- [x] Cover config loading, modes, activities, model constraints, file isolation, reset and native tool continuations in regression tests.

### Task 3: Configure managed launchers

- [x] Add the three chezmoi-managed provider profiles, align ce model slots where evidence requires it, and test isolated launches and managed files.
- [x] Preview and apply only the affected non-secret targets.

### Task 4: Document and prepare release

- [x] Document supported models, every mode/activity decision, evidence and unverified claims; prepare 1.19.0 metadata and changelog.
- [x] Run project checks, native provider acceptance, docs/release checks, package dry run and relevant chezmoi tests; review final diffs.

## Verification and review

- Router: Biome, TypeScript, 787 Node tests, plugin/marketplace validation, six native engine tests, ten loopback provider scenarios and package dry run passed. Validator retains the existing missing-icon warning.
- Chezmoi: 424 tests plus 78 subtests passed. The unrelated agterm naming check failed during the first concurrent run, then passed alone and in the final full suite. Ruff lint passed; the ce script's existing formatting drift was confirmed at HEAD and left unchanged. The new test file passes formatting.
- All changed-doc relative links pass. No diagrams changed. Prose lint is advisory (89 findings over the four checked pages). The generic release checker does not recognize this project's dated headings; the exact section extracted using the release workflow's rule passed its notes check (242 words).
- Independent read-only review found no routing defects. Its future-date finding was rejected against the observed runtime UTC date, 2026-10-31. Accepted suggestions added a reproducible spend record and explicit manual aggregate-budget accounting. Total API-list estimate: $0.062463681 against $5 authorized.
- Only the five affected non-secret chezmoi targets were applied; their diff/status is empty. No global plugin installation, push, PR, tag or publication was performed. Near-limit context, native images and compaction remain explicitly untested.
