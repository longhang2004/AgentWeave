---
title: Testing and Verification
status: current
audience:
  - developer
last_verified: 2026-09-10
sources:
  - package.json
  - packages/worker/package.json
  - services/orchestrator/package.json
  - services/agent-runner/pom.xml
  - sdks/python-worker/pyproject.toml
  - .github/workflows/release-ci.yml
  - scripts/verify-product-identity.mjs
  - scripts/verify-package-packs.mjs
  - scripts/verify-python-worker-package.py
  - services/local-executor-host-rs/Cargo.toml
---

# Testing and verification

Run gates separately and report the result of each command. A passing aggregate command does not prove an environment-specific gate that was not run.

Start release verification with the non-mutating prerequisite report:

```bash
pnpm setup:check
```

## Workspace checks

```bash
pnpm test:all
pnpm build:all
```

`test:all` runs each pnpm workspace package's own test script. `build:all` recursively builds the workspace. The Python SDK and Java Agent Runner are outside the pnpm workspace and require their own commands.

For the TypeScript Worker, run its normal suite and a leak-focused Jest pass:

```bash
pnpm --filter @tenvyr/worker test
pnpm --filter @tenvyr/worker exec jest --runInBand --detectOpenHandles
pnpm --filter @tenvyr/example-typescript-http-worker test
```

## Python Worker

Install the development extra into the selected Python 3.11+ environment, then keep the marker groups distinct:

```bash
python -m pytest sdks/python-worker/tests -m conformance
python -m pytest sdks/python-worker/tests -m 'not conformance and not stress and not lifecycle'
python -m pytest sdks/python-worker/tests -m stress
python -m pytest sdks/python-worker/tests -m lifecycle
python -m pytest examples/python-http-worker/tests
```

Static checks use the same paths as the Python Worker workflow:

```bash
python -m ruff check sdks/python-worker/src sdks/python-worker/tests examples/python-http-worker scripts/sync-python-worker-schemas.py scripts/verify-python-worker-package.py
python -m ruff format --check sdks/python-worker/src sdks/python-worker/tests examples/python-http-worker scripts/sync-python-worker-schemas.py scripts/verify-python-worker-package.py
(cd sdks/python-worker && python -m mypy)
```

The repository workflow declares Python 3.11, 3.12, 3.13, and 3.14 jobs. Do not claim a version passed until its job or a local run on that interpreter actually succeeds.

## Cross-language and repository guards

```bash
TENVYR_PYTHON_EXECUTABLE=/absolute/path/to/python pnpm --filter orchestrator test:python-worker-loopback
pnpm test:identity
pnpm verify:identity
pnpm test:docs
pnpm verify:docs
pnpm verify:package-packs
python scripts/verify-python-worker-package.py
python scripts/sync-python-worker-schemas.py check
pnpm test:executor-host-rs
```

The Python loopback intentionally fails when `TENVYR_PYTHON_EXECUTABLE` is absent. Identity and documentation tests exercise their verifiers with adversarial fixtures; the verifier commands audit the real repository.

Run Java assertions separately:

```bash
cd services/agent-runner
mvn test
```

The supported release path uses JDK 17. Java tests mock provider HTTP and cover
mock/OpenAI/Anthropic/Ollama selection, required configuration, explicit
`fail|mock` behavior, metadata, and safe logging; they do not call live models.
The checked-in Mockito subclass mock maker avoids inline-mock self-attachment
and keeps this JDK 17 path deterministic.

## Frontend and showcase

Frontend checks are non-interactive:

```bash
pnpm --filter frontend lint
pnpm --filter frontend typecheck
pnpm --filter frontend test:safe-preview
pnpm --filter frontend build
```

Validate both Compose layers, then run the actual offline showcase where Docker
is available:

```bash
docker compose -p tenvyr-showcase -f docker-compose.yml -f docker-compose.showcase.yml config
pnpm showcase:up
pnpm showcase:smoke
pnpm showcase:down
```

Static Compose output alone does not prove the golden path. On failure, capture
the named project's service logs before shutdown. The smoke verifies health,
idempotent seed, success, retry-once, expected Python and Java-backed steps,
attempt counts, and dashboard/API URLs.

## Docker and formatting

Static Compose validation does not require starting the stack, but it does require a compatible Docker Compose CLI:

```bash
docker compose config
docker compose -f docker-compose.yml -f docker-compose.no-host-ports.yml config
node --test scripts/setup-check.test.mjs
pnpm exec prettier --check <touched-non-python-files>
git diff --check
```

The static setup test verifies that every Node service image which builds
`@tenvyr/contracts` copies `scripts/copy-contract-schemas.mjs` into its shared
base stage before either development or production compilation inherits it.
The Orchestrator production TypeScript build excludes test-only `*.spec.ts`
imports; Jest still compiles those files in the test gate.

The pinned Confluent 7.3 Zookeeper and Kafka images receive
`KAFKA_OPTS=-XX:-UseContainerSupport`. Both images launch through
`kafka-run-class`; this image-supported generic JVM option avoids the bundled
JDK's cgroup v2 startup failure without replacing its heap or GC defaults.

Known environment blockers include an unavailable Docker daemon or CLI, occupied
loopback ports, restricted socket binding, missing external package caches, or
an unsupported JVM. Do not report an unavailable gate as passed.
