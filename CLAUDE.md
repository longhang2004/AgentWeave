# Tenvyr Project Reference

Tenvyr is a framework-neutral execution control plane with Kafka and HTTP
transports. Start with [the documentation index](docs/README.md); do not copy the
architecture into agent-specific instruction files.

## Sources of truth

Use this order when sources disagree:

1. executable contracts and schemas;
2. production code;
3. executable tests and conformance fixtures;
4. current architecture and operations documentation;
5. product decisions, roadmap, then historical records.

Historical plans and specifications explain prior decisions but are never the
current API reference.

## Documentation lifecycle

- An implementation change includes current documentation and
  `docs/reference/implementation-status.json` updates.
- Accepted and active plans belong in `docs/plans/active/`; completed plans move
  to `docs/archive/` with historical metadata and a current `superseded_by` path.
- Scratch notes and prompt drafts belong in ignored `docs/_scratch/`.
- Inspect every cited source/test before setting `last_verified`.
- Run the documentation, identity, formatting, and diff verifiers configured for
  the task; never report an unavailable command as passed.

See [developer agent rules](docs/development/agent-rules.md) for the complete
repository mechanics.

## Common commands

```bash
pnpm test:all
pnpm build:all
pnpm --filter @tenvyr/worker test
python -m pytest sdks/python-worker/tests
python scripts/verify-python-worker-package.py
pnpm verify:package-packs
pnpm test:identity
pnpm verify:identity
pnpm test:executor-host-rs
```

Optional local CodeGraph, skills, persistent-memory, and output-compression tools
are documented under `docs/development/tooling/`. They are not Tenvyr runtime
features.

## Installed agent customizations

### i-have-adhd

@./skills/i-have-adhd/SKILL.md

### ponytail

@./skills/ponytail/SKILL.md
