import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const legacyName = ["Agent", "Weave"].join("");
const legacyLower = legacyName.toLowerCase();
const legacyUpper = legacyName.toUpperCase();
const inventoryPath = "docs/reference/product-name-inventory.json";
const untrackedOwnerArtifacts = new Set([
  `${legacyName}.zip`,
  "scripts/compress.sh",
]);
const cacheDirectories = new Set([
  ".cache",
  ".git",
  ".next",
  ".pnpm-store",
  ".turbo",
  "coverage",
  "node_modules",
  "target",
]);
const binaryExtensions = new Set([
  ".7z",
  ".avif",
  ".class",
  ".gif",
  ".gz",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".pdf",
  ".png",
  ".tar",
  ".webp",
  ".woff",
  ".woff2",
  ".zip",
]);

const headerNames = [
  `X-${legacyName}-Key-Id`,
  `X-${legacyName}-Timestamp`,
  `X-${legacyName}-Delivery-Id`,
  `X-${legacyName}-Signature`,
];
const kafkaIdentifiers = Object.freeze([
  `${legacyLower}-dev`,
  `${legacyLower}-orchestrator`,
  `${legacyLower}-orchestrator-group`,
  `${legacyLower}-reviewer-group`,
  `${legacyLower}-observability-group`,
  `${legacyLower}-runner-group`,
  `${legacyLower}.agent.code-reviewer.task`,
  `${legacyLower}.agent.code-reviewer.result`,
  `${legacyLower}.agent.observability.task`,
  `${legacyLower}.agent.observability.result`,
  `${legacyLower}.analytics.token_usage`,
  `${legacyLower}.orchestrator.execution`,
  `${legacyLower}.orchestrator.cancel`,
  `${legacyLower}.agent.<agent>.task`,
  `${legacyLower}.agent.<agent>.result`,
  `${legacyLower}.agent.<agent-name>.task`,
  `${legacyLower}.agent.<agent-name>.result`,
  `${legacyLower}.agent.\${payload.target.agent}.task`,
  `${legacyLower}.agent.\${agent}.result`,
]);
const javaPackageRoot = `services/agent-runner/src/main/java/com/${legacyLower}/runner`;
const dockerIdentifiers = new Set(
  [
    "postgres",
    "redis",
    "zookeeper",
    "kafka",
    "kafka-ui",
    "gateway",
    "orchestrator",
    "agent-runner",
    "agent-code-reviewer",
    "agent-observability",
    "frontend",
  ]
    .map((name) => `${legacyLower}-${name}`)
    .concat(`${legacyLower}-net`),
);
const workerApiNames = [
  `create${legacyName}Worker`,
  `${legacyName}Worker`,
  `${legacyName}WorkerConfig`,
  `${legacyName}WorkerRuntime`,
  `${legacyName}StructuredSuccess`,
];
const environmentNames = [
  `${legacyUpper}_WORKER_TOKEN`,
  `${legacyUpper}_BEARER_TOKEN`,
  `${legacyUpper}_CALLBACK_KEY_ID`,
  `${legacyUpper}_CALLBACK_SECRET`,
  `${legacyUpper}_CALLBACK_ORIGIN`,
  `${legacyUpper}_ALLOW_INSECURE_HTTP`,
  `${legacyUpper}_WORKER_HOST`,
  `${legacyUpper}_WORKER_PORT`,
];
const packageNames = [
  `@${legacyLower}/contracts`,
  `@${legacyLower}/worker`,
  `@${legacyLower}/example-typescript-http-worker`,
];
const userAgents = [
  `${legacyName}-Worker/0.1.0`,
  `${legacyName}-Orchestrator/0.1.0`,
];
const historicalPaths = new Set([
  "docs/archive/decisions/2026-07-27-product-identity-evaluation.md",
  `docs/archive/migrations/2026-07-28-${legacyLower}-to-tenvyr.md`,
  "docs/archive/plans/2026-07-26-typescript-worker-sdk.md",
  "docs/archive/specs/2026-07-26-typescript-worker-sdk-design.md",
]);
const historicalReferenceLines = [
  [
    "docs/archive/README.md",
    `- [${legacyName} to Tenvyr migration](migrations/2026-07-28-${legacyLower}-to-tenvyr.md)`,
    legacyName,
  ],
  [
    "docs/archive/README.md",
    `- [${legacyName} to Tenvyr migration](migrations/2026-07-28-${legacyLower}-to-tenvyr.md)`,
    `${legacyLower}-to-tenvyr.md`,
  ],
  [
    "docs/product/identity.md",
    `branding. Protocol v1 still uses the four exact \`X-${legacyName}-*\` HMAC headers;`,
    legacyName,
  ],
  [
    "docs/product/identity.md",
    `and [rename migration record](../archive/migrations/2026-07-28-${legacyLower}-to-tenvyr.md).`,
    `${legacyLower}-to-tenvyr.md`,
  ],
];
const documentedJavaSourceValues = new Set(
  [
    `${legacyLower}/runner/controller/RunnerController.java`,
    `${legacyLower}/runner/service/LlmService.java`,
    `${legacyLower}/runner/controller/RunnerControllerTest.java`,
    `${legacyLower}/runner/service/LlmServiceTest.java`,
  ].map((value) => value.toLowerCase()),
);
const documentedJavaSourcePaths = new Set([
  "docs/architecture/agents-and-runners.md",
  "docs/operations/configuration.md",
]);
const documentedDeploymentReferenceLines = [
  [
    "docs/architecture/agents-and-runners.md",
    `namespace \`com.${legacyLower}\`.`,
    `com.${legacyLower}`,
  ],
  [
    "docs/operations/configuration.md",
    `| \`POSTGRES_DB\`                        | Optional; legacy compatibility default \`${legacyLower}\`.                                               |`,
    legacyLower,
  ],
  [
    "docs/operations/configuration.md",
    `Kafka topic, consumer-group, client-ID, database, Docker network, and Java package values retaining \`${legacyLower}\` are protocol or deployment compatibility identifiers. Do not rename them as branding cleanup.`,
    legacyLower,
  ],
  [
    "docs/product/identity.md",
    `Java namespace \`com.${legacyLower}\` also remain unchanged pending separately approved`,
    `com.${legacyLower}`,
  ],
  [
    "services/orchestrator/src/database/postgres.integration.spec.ts",
    `const configured = process.env.POSTGRES_DB || "${legacyLower}";`,
    legacyLower,
  ],
  [
    "services/orchestrator/src/database/postgres.integration.spec.ts",
    `(process.env.POSTGRES_DB || "${legacyLower}").toLowerCase() ===`,
    legacyLower,
  ],
];
const compatibilityValues = new Set([
  ...dockerIdentifiers,
  ...kafkaIdentifiers,
  ...headerNames.map((header) => header.toLowerCase()),
  `com.${legacyLower}`,
  `${legacyLower}/runner/controller/RunnerController.java`,
]);
const wireProtocolPaths = new Set([
  "docs/architecture/transports/http-agent-adapter-v1.md",
  "docs/architecture/workers/typescript-worker-sdk.md",
  "packages/worker/src/callback/callback-delivery.ts",
  "packages/worker/test/hardening.spec.ts",
  "packages/worker/test/worker-http.spec.ts",
  "packages/worker/README.md",
  "packages/worker/test/events.spec.ts",
  "packages/worker/dist/callback/callback-delivery.js",
  "services/orchestrator/src/agent-adapters/http-agent-callback.controller.spec.ts",
  "services/orchestrator/src/agent-adapters/http-agent-callback.controller.ts",
  "services/orchestrator/src/agent-adapters/http-agent.integration.spec.ts",
  "services/orchestrator/src/agent-adapters/http-python-worker.integration.spec.ts",
  "services/orchestrator/src/agent-adapters/http-worker.integration.spec.ts",
  "packages/worker/test/callback.spec.ts",
  "services/local-executor-host/integration/local-executor-host.integration.spec.ts",
  "services/local-executor-host-rs/src/protocol.rs",
  "sdks/python-worker/src/tenvyr_worker/_callback/delivery.py",
  "sdks/python-worker/README.md",
  "sdks/python-worker/CONFORMANCE.md",
  "sdks/python-worker/tests/test_events.py",
]);
const kafkaPathRules = new Map([
  [`${legacyLower}-dev`, new Set([".env.example"])],
  [
    `${legacyLower}-orchestrator`,
    new Set([
      "docs/operations/configuration.md",
      "services/orchestrator/src/services/kafka.service.ts",
    ]),
  ],
  [
    `${legacyLower}-orchestrator-group`,
    new Set(["services/orchestrator/src/services/kafka.service.ts"]),
  ],
  [
    `${legacyLower}-reviewer-group`,
    new Set([
      "docs/architecture/agents-and-runners.md",
      "docs/architecture/transports/kafka-runtime-v1.md",
      "services/agent-code-reviewer/src/kafka.service.ts",
    ]),
  ],
  [
    `${legacyLower}-observability-group`,
    new Set([
      "docs/architecture/agents-and-runners.md",
      "docs/architecture/transports/kafka-runtime-v1.md",
      "services/agent-observability/src/kafka.service.ts",
    ]),
  ],
  [
    `${legacyLower}-runner-group`,
    new Set(["services/agent-runner/src/main/resources/application.yml"]),
  ],
  [
    `${legacyLower}.agent.\${payload.target.agent}.task`,
    new Set([
      "services/orchestrator/src/agent-adapters/kafka-agent.adapter.ts",
    ]),
  ],
  [
    `${legacyLower}.agent.\${agent}.result`,
    new Set([
      "services/orchestrator/src/agent-adapters/kafka-agent.adapter.ts",
    ]),
  ],
  [
    `${legacyLower}.agent.code-reviewer.task`,
    new Set([
      "CLAUDE.md",
      "docs/architecture/agents-and-runners.md",
      "services/agent-code-reviewer/src/kafka.service.ts",
      "services/orchestrator/src/agent-adapters/kafka-agent.adapter.spec.ts",
      "services/orchestrator/src/services/kafka.service.spec.ts",
    ]),
  ],
  [
    `${legacyLower}.agent.code-reviewer.result`,
    new Set([
      "CLAUDE.md",
      "docs/architecture/agents-and-runners.md",
      "services/agent-code-reviewer/src/kafka.service.ts",
      "services/orchestrator/src/agent-adapters/kafka-agent.adapter.spec.ts",
    ]),
  ],
  [
    `${legacyLower}.agent.observability.task`,
    new Set([
      "docs/architecture/agents-and-runners.md",
      "services/agent-observability/src/kafka.service.ts",
      "frontend/src/app/page.tsx",
    ]),
  ],
  [
    `${legacyLower}.agent.observability.result`,
    new Set([
      "docs/architecture/agents-and-runners.md",
      "services/agent-observability/src/kafka.service.spec.ts",
      "services/agent-observability/src/kafka.service.ts",
      "services/orchestrator/src/agent-adapters/kafka-agent.adapter.spec.ts",
    ]),
  ],
  [
    `${legacyLower}.analytics.token_usage`,
    new Set([
      "CLAUDE.md",
      "docs/architecture/agents-and-runners.md",
      `${javaPackageRoot}/controller/RunnerController.java`,
    ]),
  ],
  [`${legacyLower}.orchestrator.execution`, new Set(["CLAUDE.md"])],
  [`${legacyLower}.orchestrator.cancel`, new Set(["CLAUDE.md"])],
  [
    `${legacyLower}.agent.<agent>.task`,
    new Set([
      "docs/architecture/transports/adapter-model.md",
      "docs/architecture/transports/kafka-runtime-v1.md",
      "docs/development/agent-rules.md",
    ]),
  ],
  [
    `${legacyLower}.agent.<agent>.result`,
    new Set([
      "docs/architecture/transports/adapter-model.md",
      "docs/architecture/transports/kafka-runtime-v1.md",
      "docs/development/agent-rules.md",
    ]),
  ],
  [
    `${legacyLower}.agent.<agent-name>.task`,
    new Set(["CLAUDE.md", "README.md"]),
  ],
  [
    `${legacyLower}.agent.<agent-name>.result`,
    new Set(["CLAUDE.md", "README.md"]),
  ],
  [
    `${legacyLower}.agent.<agent>.event`,
    new Set([
      "docs/architecture/transports/adapter-model.md",
      "docs/architecture/transports/kafka-runtime-v1.md",
      "services/orchestrator/src/agent-adapters/kafka-agent.adapter.ts",
    ]),
  ],
  [
    `${legacyLower}.agent.\${agent}.event`,
    new Set([
      "services/orchestrator/src/agent-adapters/kafka-agent.adapter.ts",
    ]),
  ],
  [
    `${legacyLower}.agent.code-reviewer.event`,
    new Set([
      "services/orchestrator/src/agent-adapters/kafka-agent.adapter.spec.ts",
    ]),
  ],
  [
    `${legacyLower}.agent.observability.event`,
    new Set([
      "services/orchestrator/src/agent-adapters/kafka-agent.adapter.spec.ts",
    ]),
  ],
  [
    `${legacyLower}.agent.reader.event`,
    new Set([
      "services/orchestrator/src/database/postgres.integration.spec.ts",
      "services/orchestrator/src/domain/transport-identity.spec.ts",
    ]),
  ],
  [
    // Exact forbidden-regex match produced by long-topic test strings (the
    // topic prefix followed by an interpolated run) at the durable
    // transport-identity tests. Not a wildcard: only the literal match
    // `<legacy-name>.agent.` on these exact paths is allowed, so a longer or
    // differently-shaped topic string still fails.
    `${legacyLower}.agent.`,
    new Set([
      "services/orchestrator/src/database/postgres.integration.spec.ts",
      "services/orchestrator/src/domain/transport-identity.spec.ts",
    ]),
  ],
]);

const forbiddenPattern = new RegExp(
  [
    `@${escapeRegExp(legacyLower)}/[A-Za-z0-9._-]+`,
    `${legacyUpper}_[A-Z0-9_]+`,
    `X-${legacyName}-[A-Za-z0-9-]+`,
    `x-${legacyLower}-[a-z0-9-]+`,
    `${legacyName}-(?:Worker|Orchestrator)/[0-9]+(?:\\.[0-9]+)*`,
    `${legacyLower}\\.agent\\.\\$\\{[A-Za-z0-9_.]+\\}\\.(?:task|result|event)(?![A-Za-z0-9_.])`,
    `[A-Za-z0-9_]*${legacyName}[A-Za-z0-9_]*`,
    `com\\.${legacyLower}(?:\\.[A-Za-z0-9_.*-]+)*`,
    `${legacyLower}(?:[./-][A-Za-z0-9_.*<>-]+)*`,
    legacyName,
  ].join("|"),
  "g",
);

export const allowedCategories = Object.freeze([
  "wire-protocol-v1",
  "kafka-runtime-v1",
  "persistent-deployment",
  "historical",
  "negative-test",
  "compatibility-test",
  "identity-inventory",
  "owner-artifact",
]);

export const requiredLegacyIdentifiers = Object.freeze([
  ...headerNames.flatMap((header, index) => {
    const workerValues = [
      "input.keyId",
      "timestamp",
      "deliveryId",
      "signature",
    ];
    const controllerValues = ["keyId", "timestamp", "deliveryId", "signature"];
    return [
      requiredQuotedKeyProperty(
        `worker-sends-${header}`,
        "packages/worker/src/callback/callback-delivery.ts",
        header,
        workerValues[index],
      ),
      requiredHeaderParameter(
        `orchestrator-accepts-${header}`,
        "services/orchestrator/src/agent-adapters/http-agent-callback.controller.ts",
        header.toLowerCase(),
        controllerValues[index],
      ),
      requiredPattern(
        `python-worker-sends-${header}`,
        "sdks/python-worker/src/tenvyr_worker/_callback/delivery.py",
        new RegExp(
          `^[\\t ]*HEADER_${["KEY_ID", "TIMESTAMP", "DELIVERY_ID", "SIGNATURE"][index]}[\\t ]*=[\\t ]*(["'])${escapeRegExp(header)}\\1[\\t ]*$`,
          "m",
        ),
        `HEADER_${["KEY_ID", "TIMESTAMP", "DELIVERY_ID", "SIGNATURE"][index]} = "${header}"`,
      ),
      requiredPattern(
        `rust-host-sends-${header}`,
        "services/local-executor-host-rs/src/protocol.rs",
        new RegExp(
          `^[\\t ]*pub const HEADER_${["KEY_ID", "TIMESTAMP", "DELIVERY_ID", "SIGNATURE"][index]}:[\\t ]*&str[\\t ]*=[\\t ]*(["'])${escapeRegExp(header)}\\1;[\\t ]*$`,
          "m",
        ),
        `pub const HEADER_${["KEY_ID", "TIMESTAMP", "DELIVERY_ID", "SIGNATURE"][index]}: &str = "${header}";`,
      ),
    ];
  }),
  requiredLine(
    "orchestrator-task-topic-template",
    "services/orchestrator/src/agent-adapters/kafka-agent.adapter.ts",
    `const topic = \`${legacyLower}.agent.\${payload.target.agent}.task\`;`,
  ),
  requiredPattern(
    "orchestrator-result-topic-template",
    "services/orchestrator/src/agent-adapters/kafka-agent.adapter.ts",
    new RegExp(
      `^[\\t ]*return\\s+Array\\.from\\(\\s*new\\s+Set\\(\\s*\\[\\s*\\.\\.\\.this\\.agentNames\\(\\)\\.map\\(\\s*\\(agent\\)\\s*=>\\s*\`${escapeRegExp(legacyLower)}\\.agent\\.\\$\\{agent\\}\\.result\`\\s*\\)\\s*,\\s*\\.\\.\\.explicitTopics\\s*,?\\s*\\]\\s*\\)\\s*,?\\s*\\)\\s*;[\\t ]*$`,
      "m",
    ),
    `return Array.from(\n  new Set([\n    ...this.agentNames().map((agent) => \`${legacyLower}.agent.\${agent}.result\`),\n    ...explicitTopics,\n  ]),\n);`,
  ),
  requiredPattern(
    "orchestrator-event-topic-template",
    "services/orchestrator/src/agent-adapters/kafka-agent.adapter.ts",
    new RegExp(
      `^[\\t ]*return\\s*\\[\\s*\\.\\.\\.this\\.agentNames\\(\\)\\.map\\(\\s*\\(agent\\)\\s*=>\\s*\`${escapeRegExp(legacyLower)}\\.agent\\.\\$\\{agent\\}\\.event\`\\s*\\)\\s*,\\s*\\.\\.\\.configured\\s*,?\\s*\\]\\s*;[\\t ]*$`,
      "m",
    ),
    `return [\n  ...this.agentNames().map((agent) => \`${legacyLower}.agent.\${agent}.event\`),\n  ...configured,\n];`,
  ),
  requiredQuotedConst(
    "reviewer-task-topic",
    "services/agent-code-reviewer/src/kafka.service.ts",
    "topic",
    `${legacyLower}.agent.code-reviewer.task`,
  ),
  requiredQuotedProperty(
    "reviewer-result-topic",
    "services/agent-code-reviewer/src/kafka.service.ts",
    "topic",
    `${legacyLower}.agent.code-reviewer.result`,
  ),
  requiredQuotedConst(
    "observability-task-topic",
    "services/agent-observability/src/kafka.service.ts",
    "topic",
    `${legacyLower}.agent.observability.task`,
  ),
  requiredQuotedProperty(
    "observability-result-topic",
    "services/agent-observability/src/kafka.service.ts",
    "topic",
    `${legacyLower}.agent.observability.result`,
  ),
  requiredLine(
    "analytics-topic",
    `${javaPackageRoot}/controller/RunnerController.java`,
    `kafkaTemplate.send("${legacyLower}.analytics.token_usage", json);`,
  ),
  requiredQuotedProperty(
    "orchestrator-consumer-group",
    "services/orchestrator/src/services/kafka.service.ts",
    "groupId",
    `${legacyLower}-orchestrator-group`,
  ),
  requiredQuotedProperty(
    "reviewer-consumer-group",
    "services/agent-code-reviewer/src/kafka.service.ts",
    "groupId",
    `${legacyLower}-reviewer-group`,
  ),
  requiredQuotedProperty(
    "observability-consumer-group",
    "services/agent-observability/src/kafka.service.ts",
    "groupId",
    `${legacyLower}-observability-group`,
  ),
  requiredLine(
    "runner-consumer-group",
    "services/agent-runner/src/main/resources/application.yml",
    `group-id: ${legacyLower}-runner-group`,
  ),
  requiredPattern(
    "orchestrator-client-id",
    "services/orchestrator/src/services/kafka.service.ts",
    quotedStatementPattern(
      "const clientId = process.env.KAFKA_CLIENT_ID || ",
      `${legacyLower}-orchestrator`,
      ";",
    ),
    `const clientId = process.env.KAFKA_CLIENT_ID || "${legacyLower}-orchestrator";`,
  ),
  requiredLine(
    "development-client-id",
    ".env.example",
    `KAFKA_CLIENT_ID=${legacyLower}-dev`,
  ),
  requiredQuotedProperty(
    "reviewer-client-id",
    "services/agent-code-reviewer/src/kafka.service.ts",
    "clientId",
    "agent-code-reviewer",
  ),
  requiredQuotedProperty(
    "observability-client-id",
    "services/agent-observability/src/kafka.service.ts",
    "clientId",
    "agent-observability",
  ),
  requiredLine(
    "orchestrator-message-key",
    "services/orchestrator/src/agent-adapters/kafka-agent.adapter.ts",
    "key: payload.executionId,",
  ),
  requiredLine(
    "reviewer-message-key",
    "services/agent-code-reviewer/src/kafka.service.ts",
    "messages: [{ key: result.executionId, value: JSON.stringify(result) }],",
  ),
  requiredLine(
    "observability-message-key",
    "services/agent-observability/src/kafka.service.ts",
    "messages: [{ key: result.executionId, value: JSON.stringify(result) }],",
  ),
  requiredPattern(
    "compose-database",
    "docker-compose.yml",
    new RegExp(
      `^  postgres:\\s*\\n(?:(?: {4,}|\\t).*\\n)*?      POSTGRES_DB: ${escapeRegExp(legacyLower)}\\s*$`,
      "m",
    ),
    `  postgres:\n    environment:\n      POSTGRES_DB: ${legacyLower}`,
  ),
  requiredLine(
    "example-database",
    ".env.example",
    `POSTGRES_DB=${legacyLower}`,
  ),
  requiredComposeLine(
    "compose-gateway-database",
    "gateway",
    `      - POSTGRES_DB=${legacyLower}`,
  ),
  requiredComposeLine(
    "compose-orchestrator-database",
    "orchestrator",
    `      - POSTGRES_DB=${legacyLower}`,
  ),
  requiredPattern(
    "orchestrator-database-fallback",
    "services/orchestrator/src/database/database.provider.ts",
    quotedStatementPattern(
      "database: process.env.POSTGRES_DB || ",
      legacyLower,
      ",",
    ),
    `database: process.env.POSTGRES_DB || "${legacyLower}",`,
  ),
  ...[
    "postgres",
    "redis",
    "zookeeper",
    "kafka",
    "kafka-ui",
    "gateway",
    "orchestrator",
    "agent-runner",
    "agent-code-reviewer",
    "agent-observability",
    "frontend",
  ].map((name) =>
    requiredPattern(
      `docker-container-${name}`,
      "docker-compose.yml",
      new RegExp(
        `^  ${escapeRegExp(name)}:\\s*\\n(?:(?: {4,}|\\t).*\\n)*?    container_name: ${escapeRegExp(legacyLower)}-${escapeRegExp(name)}\\s*$`,
        "m",
      ),
      `  ${name}:\n    container_name: ${legacyLower}-${name}`,
    ),
  ),
  ...[
    "postgres",
    "redis",
    "zookeeper",
    "kafka",
    "kafka-ui",
    "gateway",
    "orchestrator",
    "agent-runner",
    "agent-code-reviewer",
    "agent-observability",
    "frontend",
  ].map((name) =>
    requiredComposeLine(
      `docker-network-attachment-${name}`,
      name,
      `      - ${legacyLower}-net`,
    ),
  ),
  requiredPattern(
    "docker-network",
    "docker-compose.yml",
    new RegExp(
      `^networks:\\s*\\n  ${escapeRegExp(legacyLower)}-net:\\s*\\n    name: ${escapeRegExp(legacyLower)}-net\\s*$`,
      "m",
    ),
    `networks:\n  ${legacyLower}-net:\n    name: ${legacyLower}-net`,
  ),
  requiredPattern(
    "docker-postgres-volume",
    "docker-compose.yml",
    /^volumes:\s*\n  postgres_data:\s*$/m,
    "volumes:\n  postgres_data:",
  ),
  requiredPattern(
    "docker-redis-volume",
    "docker-compose.yml",
    /^volumes:\s*\n(?:  postgres_data:\s*\n)?  redis_data:\s*$/m,
    "volumes:\n  redis_data:",
  ),
  requiredComposeLine(
    "docker-postgres-volume-mount",
    "postgres",
    "      - postgres_data:/var/lib/postgresql/data",
  ),
  requiredComposeLine(
    "docker-redis-volume-mount",
    "redis",
    "      - redis_data:/data",
  ),
  requiredLine(
    "java-maven-group",
    "services/agent-runner/pom.xml",
    `<groupId>com.${legacyLower}</groupId>`,
  ),
  requiredLine(
    "java-package-namespace",
    `${javaPackageRoot}/AgentRunnerApplication.java`,
    `package com.${legacyLower}.runner;`,
  ),
]);

export function auditEntries(
  entries,
  requiredRules = requiredLegacyIdentifiers,
) {
  const normalizedEntries = [...entries]
    .map((entry) => ({
      path: normalizePath(entry.path),
      text: entry.text,
      filename: entry.filename,
    }))
    .sort((left, right) => compareCodePoints(left.path, right.path));
  const findings = [];

  for (const entry of normalizedEntries) {
    if (entry.filename) {
      for (const match of forbiddenMatches(entry.filename)) {
        findings.push({
          path: entry.path,
          line: 1,
          match,
          location: "filename",
          category: null,
        });
      }
    }
    const lines = entry.text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      for (const match of forbiddenMatches(lines[index])) {
        findings.push({
          path: entry.path,
          line: index + 1,
          match,
          category: classifyMatch({
            path: entry.path,
            line: lines[index],
            match,
          }),
        });
      }
    }
  }

  const textsByPath = new Map(
    normalizedEntries.map((entry) => [entry.path, entry.text]),
  );
  const missing = requiredRules
    .filter((rule) => {
      const text = textsByPath.get(rule.path);
      return !text || !hasRequiredSyntax(text, rule);
    })
    .map((rule) => rule.id)
    .sort(compareCodePoints);

  return { findings, missing };
}

export function classifyMatch({ path, line, match }) {
  const normalizedPath = normalizePath(path);
  const normalizedMatch = match.toLowerCase();

  if (normalizedPath === inventoryPath) return "identity-inventory";
  if (
    normalizedPath === ".gitignore" &&
    line.trim() === `/${legacyName}.zip` &&
    match === legacyName
  ) {
    return "owner-artifact";
  }
  if (isHistoricalReference(normalizedPath, line, match)) {
    return "historical";
  }
  if (isCompatibilityAssertion(normalizedPath, line, match)) {
    return "compatibility-test";
  }
  if (isApprovedWireHeader(normalizedPath, line, match)) {
    return "wire-protocol-v1";
  }
  if (
    normalizedPath === "scripts/verify-package-packs.mjs" &&
    headerNames.includes(match) &&
    line.trim() === `"${match}",`
  ) {
    return "wire-protocol-v1";
  }
  if (kafkaPathRules.get(normalizedMatch)?.has(normalizedPath)) {
    return "kafka-runtime-v1";
  }
  if (isPersistentIdentifier(normalizedPath, line, normalizedMatch)) {
    return "persistent-deployment";
  }
  if (isApprovedNegativeAssertion(normalizedPath, line, match)) {
    return "negative-test";
  }
  return null;
}

export function collectRepositoryEntries(root) {
  const tracked = new Set(
    execFileSync("git", ["ls-files", "-z", "--cached"], {
      cwd: root,
      encoding: "utf8",
    })
      .split("\0")
      .filter(Boolean)
      .map(normalizePath),
  );
  const untracked = execFileSync(
    "git",
    ["ls-files", "-z", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean)
    .map(normalizePath);
  const packageDistFiles = existingPackageDistFiles(root);
  const paths = [...new Set([...tracked, ...untracked, ...packageDistFiles])]
    .map(normalizePath)
    .sort(compareCodePoints);
  const entries = [];

  for (const path of paths) {
    if (isExcludedPath(path, { tracked: tracked.has(path) })) continue;
    const absolutePath = join(root, ...path.split("/"));
    if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) continue;
    const buffer = readFileSync(absolutePath);
    if (isBinary(path, buffer)) {
      if (tracked.has(path)) {
        entries.push({ path, text: "", filename: path });
      }
      continue;
    }
    entries.push({ path, text: buffer.toString("utf8") });
  }
  return entries;
}

export function isExcludedPath(path, { tracked = false } = {}) {
  const normalizedPath = normalizePath(path);
  if (!tracked && untrackedOwnerArtifacts.has(normalizedPath)) return true;
  return normalizedPath
    .split("/")
    .some((component) => cacheDirectories.has(component));
}

export function formatAudit({ findings, missing }) {
  const lines = findings.map(
    (finding) =>
      `${finding.path}:${finding.line} match=${JSON.stringify(finding.match)} ${
        finding.location === "filename" ? "location=filename " : ""
      }${finding.category ? `allowed:${finding.category}` : "VIOLATION"}`,
  );
  lines.push(
    ...missing.map((id) => `MISSING required:${id}`),
    `identity verification: ${findings.filter((finding) => !finding.category).length} violation(s), ${missing.length} required identifier(s) missing`,
  );
  return lines.join("\n");
}

export function verifyRepository(root) {
  return auditEntries(collectRepositoryEntries(root));
}

function existingPackageDistFiles(root) {
  const packagesRoot = join(root, "packages");
  if (!existsSync(packagesRoot)) return [];
  return readdirSync(packagesRoot, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) return [];
    const dist = join(packagesRoot, entry.name, "dist");
    return existsSync(dist) ? walkFiles(dist, root) : [];
  });
}

function walkFiles(directory, root) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? walkFiles(path, root)
      : [normalizePath(relative(root, path))];
  });
}

function isBinary(path, buffer) {
  const lowerPath = path.toLowerCase();
  if (
    [...binaryExtensions].some((extension) => lowerPath.endsWith(extension))
  ) {
    return true;
  }
  return buffer.subarray(0, 8_192).includes(0);
}

function forbiddenMatches(value) {
  forbiddenPattern.lastIndex = 0;
  return [...value.matchAll(forbiddenPattern)].map((match) => match[0]);
}

function isCompatibilityAssertion(path, line, match) {
  if (path !== "services/orchestrator/src/compatibility-identifiers.spec.ts") {
    return false;
  }
  const trimmed = line.trim();
  if (match === legacyName) {
    return (
      trimmed ===
      `it("accepts only the four ${legacyName} HMAC v1 callback headers", () => {`
    );
  }
  if (match === legacyLower) {
    const escapedJavaNamespace = `^com\\.${legacyLower}`;
    if (
      !line.includes(`POSTGRES_DB=${legacyLower}`) &&
      !line.includes(`POSTGRES_DB || '${legacyLower}'`) &&
      !line.includes(`POSTGRES_DB: "${legacyLower}"`) &&
      !line.includes(escapedJavaNamespace)
    ) {
      return false;
    }
  } else if (
    !compatibilityValues.has(match) &&
    !match.startsWith(`com.${legacyLower}`)
  ) {
    return false;
  }
  return (
    /^[\t ]*["']/.test(line) ||
    /^[\t ]*(?:"[^"]+"|[A-Za-z][A-Za-z0-9_-]*):[\t ]*["']/.test(line) ||
    /\.(?:includes|toBe|toContain|toEqual|toMatch)\(/.test(line) ||
    line.includes(`expect(expectedPackage).toMatch(/^com\\.${legacyLower}`)
  );
}

function isApprovedWireHeader(path, line, match) {
  if (
    !wireProtocolPaths.has(path) ||
    !headerNames.some((header) => header.toLowerCase() === match.toLowerCase())
  ) {
    return false;
  }
  if (path !== "sdks/python-worker/src/tenvyr_worker/_callback/delivery.py") {
    return true;
  }
  const names = new Map([
    [headerNames[0], "KEY_ID"],
    [headerNames[1], "TIMESTAMP"],
    [headerNames[2], "DELIVERY_ID"],
    [headerNames[3], "SIGNATURE"],
  ]);
  return line.trim() === `HEADER_${names.get(match)} = "${match}"`;
}

function isApprovedNegativeAssertion(path, line, match) {
  if (path === "scripts/verify-docs.mjs") {
    const approvedLines = [
      [
        `/@${legacyLower}\\/(?:contracts|worker|example-typescript-http-worker)\\b/gi,`,
        legacyLower,
      ],
      [`/\\bcreate${legacyName}Worker\\b/g,`, `bcreate${legacyName}Worker`],
      [
        `/\\b${legacyName}(?:Worker|WorkerConfig|WorkerRuntime|StructuredSuccess)\\b/g,`,
        `b${legacyName}`,
      ],
    ];
    return approvedLines.some(
      ([approvedLine, approvedMatch]) =>
        approvedLine === line.trim() && approvedMatch === match,
    );
  }
  if (path === "packages/worker/test/public-api.spec.ts") {
    const approvedLines = [
      [
        `expect(compiledPackage.create${legacyName}Worker).toBeUndefined();`,
        `create${legacyName}Worker`,
      ],
      [`"create${legacyName}Worker",`, `create${legacyName}Worker`],
      [`"${legacyName}Worker",`, `${legacyName}Worker`],
      [`"${legacyName}WorkerConfig",`, `${legacyName}WorkerConfig`],
      [`"${legacyName}WorkerRuntime",`, `${legacyName}WorkerRuntime`],
    ];
    return approvedLines.some(
      ([approvedLine, approvedMatch]) =>
        approvedLine === line.trim() && approvedMatch === match,
    );
  }
  if (path === "scripts/verify-package-packs.mjs") {
    const approvedLines = [
      [
        `!("@${legacyLower}/contracts" in workerManifest.dependencies),`,
        `@${legacyLower}/contracts`,
      ],
      [
        `\`import { create${legacyName}Worker } from "@tenvyr/worker";`,
        `create${legacyName}Worker`,
      ],
      [`void create${legacyName}Worker;`, `create${legacyName}Worker`],
      [
        `\`import { create${legacyName}Worker } from "@${legacyLower}/worker";`,
        `create${legacyName}Worker`,
      ],
      [
        `\`import { create${legacyName}Worker } from "@${legacyLower}/worker";`,
        `@${legacyLower}/worker`,
      ],
      [`["old npm scope", /@${legacyLower}\\//i],`, legacyLower],
      [
        `["old Worker factory", /\\bcreate${legacyName}Worker\\b/],`,
        `bcreate${legacyName}Worker`,
      ],
      [
        `["old Worker type", /\\b${legacyName}Worker(?:Config|Runtime)?\\b/],`,
        `b${legacyName}Worker`,
      ],
      [
        `["old Worker User-Agent", /\\b${legacyName}-Worker\\/[0-9]/i],`,
        `b${legacyName}`,
      ],
      [
        `for (const match of content.matchAll(/X-${legacyName}-[A-Za-z-]+/g)) {`,
        legacyName,
      ],
    ];
    return approvedLines.some(
      ([approvedLine, approvedMatch]) =>
        approvedLine === line.trim() && approvedMatch === match,
    );
  }
  if (path === "scripts/verify-docs.test.mjs") {
    const approvedLines = [
      [`historical_product_name: ${legacyName}`, legacyName],
      [
        `"See the [numeric policy](json-interoperability.md). The legacy \`X-${legacyName}-Signature\` header remains wire-compatible.",`,
        `X-${legacyName}-Signature`,
      ],
      [
        `historical("Completed plan", "${legacyName} was the historical product name."),`,
        legacyName,
      ],
      [
        `"Install \`@${legacyLower}/worker\` with \`create${legacyName}Worker\`.",`,
        `@${legacyLower}/worker`,
      ],
      [
        `"Install \`@${legacyLower}/worker\` with \`create${legacyName}Worker\`.",`,
        `create${legacyName}Worker`,
      ],
    ];
    return approvedLines.some(
      ([approvedLine, approvedMatch]) =>
        approvedLine === line.trim() && approvedMatch === match,
    );
  }
  return (
    /schema-identity\.(?:spec|test)\.[cm]?[jt]s$/.test(path) &&
    match.startsWith(`${legacyLower}.dev`) &&
    /\.not\.toContain\(/.test(line)
  );
}

function isHistoricalReference(path, line, match) {
  if (historicalPaths.has(path)) return true;
  if (
    historicalReferenceLines.some(
      ([approvedPath, approvedLine, approvedMatch]) =>
        path === approvedPath &&
        line.trim() === approvedLine &&
        match === approvedMatch,
    )
  ) {
    return true;
  }
  return false;
}

function isPersistentIdentifier(path, line, match) {
  if (
    documentedJavaSourcePaths.has(path) &&
    documentedJavaSourceValues.has(match)
  ) {
    return true;
  }
  if (
    documentedDeploymentReferenceLines.some(
      ([approvedPath, approvedLine, approvedMatch]) =>
        path === approvedPath &&
        line.trim() === approvedLine &&
        match === approvedMatch,
    )
  ) {
    return true;
  }
  if (
    (path === "services/agent-runner/pom.xml" ||
      path.startsWith(`${javaPackageRoot}/`) ||
      path.startsWith(
        `services/agent-runner/src/test/java/com/${legacyLower}/runner/`,
      )) &&
    match.startsWith(`com.${legacyLower}`)
  ) {
    return true;
  }
  if (path === "docker-compose.yml") {
    const trimmed = line.trim();
    if (match === legacyLower) {
      return (
        trimmed === `POSTGRES_DB: ${legacyLower}` ||
        trimmed === `- POSTGRES_DB=${legacyLower}`
      );
    }
    if (match === `${legacyLower}-net`) {
      return (
        trimmed === `${legacyLower}-net:` ||
        trimmed === `- ${legacyLower}-net` ||
        trimmed === `name: ${legacyLower}-net`
      );
    }
    return (
      dockerIdentifiers.has(match) && trimmed === `container_name: ${match}`
    );
  }
  if (path === ".github/workflows/release-ci.yml") {
    // The preserved legacy deployment container name (same rationale as the
    // docker-compose.yml container_name allowance): the hosted-CI postgres
    // service container must keep the legacy name so the real M11
    // backup/restore round-trip test can docker exec it.
    const trimmed = line.trim();
    return dockerIdentifiers.has(match) && trimmed === `--name ${match}`;
  }
  if (
    path === "docker-compose.showcase.yml" &&
    match === `${legacyLower}-net`
  ) {
    return line.trim() === `- ${legacyLower}-net`;
  }
  if (match === legacyLower) {
    if (path === ".env.example") {
      return line.trim() === `POSTGRES_DB=${legacyLower}`;
    }
    if (path.endsWith("/database.provider.ts")) {
      return new RegExp(
        `^database:\\s*process\\.env\\.POSTGRES_DB\\s*\\|\\|\\s*(["'])${escapeRegExp(legacyLower)}\\1,$`,
      ).test(line.trim());
    }
  }
  return false;
}

function requiredLine(id, path, line) {
  return requiredPattern(
    id,
    path,
    new RegExp(`^[\\t ]*${escapeRegExp(line)}[\\t ]*$`, "m"),
    line,
  );
}

function requiredQuotedConst(id, path, name, value) {
  return requiredPattern(
    id,
    path,
    quotedStatementPattern(`const ${name} = `, value, ";"),
    `const ${name} = "${value}";`,
  );
}

function requiredQuotedProperty(id, path, name, value) {
  return requiredPattern(
    id,
    path,
    quotedStatementPattern(`${name}: `, value, ","),
    `${name}: "${value}",`,
  );
}

function requiredQuotedKeyProperty(id, path, name, value) {
  return requiredPattern(
    id,
    path,
    new RegExp(
      `^[\\t ]*(["'])${escapeRegExp(name)}\\1\\s*:\\s*${escapeRegExp(value)}\\s*,[\\t ]*$`,
      "m",
    ),
    `"${name}": ${value},`,
  );
}

function requiredHeaderParameter(id, path, header, parameter) {
  return requiredPattern(
    id,
    path,
    new RegExp(
      `^[\\t ]*@Headers\\(\\s*(["'])${escapeRegExp(header)}\\1\\s*\\)\\s*${escapeRegExp(parameter)}\\s*:\\s*string\\s*\\|\\s*undefined\\s*,[\\t ]*$`,
      "m",
    ),
    `@Headers("${header}") ${parameter}: string | undefined,`,
  );
}

function quotedStatementPattern(prefix, value, suffix) {
  const prefixPattern = prefix
    .trim()
    .split(/\s+/)
    .map(escapeRegExp)
    .join("\\s+");
  return new RegExp(
    `^[\\t ]*${prefixPattern}\\s*(["'])${escapeRegExp(value)}\\1${escapeRegExp(suffix)}[\\t ]*$`,
    "m",
  );
}

function requiredComposeLine(id, service, line) {
  return requiredPattern(
    id,
    "docker-compose.yml",
    new RegExp(
      `^  ${escapeRegExp(service)}:\\s*\\n(?:(?: {4,}|\\t).*\\n)*?${escapeRegExp(line)}\\s*$`,
      "m",
    ),
    `  ${service}:\n${line}`,
  );
}

function requiredPattern(id, path, pattern, fixture) {
  return Object.freeze({ id, path, pattern, fixture });
}

function hasRequiredSyntax(text, rule) {
  if (!/\.(?:[cm]?[jt]sx?)$/.test(rule.path)) {
    rule.pattern.lastIndex = 0;
    return rule.pattern.test(stripComments(text, rule.path));
  }

  const lexicalKinds = javascriptLexicalKinds(text);
  const flags = rule.pattern.flags.includes("g")
    ? rule.pattern.flags
    : `${rule.pattern.flags}g`;
  const pattern = new RegExp(rule.pattern.source, flags);
  for (const match of text.matchAll(pattern)) {
    const firstSyntax = match[0].search(/\S/);
    if (
      firstSyntax !== -1 &&
      lexicalKinds[match.index + firstSyntax] === "code"
    ) {
      return true;
    }
  }
  return false;
}

function javascriptLexicalKinds(text) {
  const kinds = Array(text.length).fill("code");
  let state = "code";

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];

    if (state === "line-comment") {
      kinds[index] = "inert";
      if (character === "\n") state = "code";
      continue;
    }
    if (state === "block-comment") {
      kinds[index] = "inert";
      if (character === "*" && next === "/") {
        kinds[index + 1] = "inert";
        index += 1;
        state = "code";
      }
      continue;
    }
    if (state !== "code") {
      kinds[index] = "inert";
      if (character === "\\") {
        if (index + 1 < text.length) {
          kinds[index + 1] = "inert";
          index += 1;
        }
      } else if (character === state) {
        state = "code";
      }
      continue;
    }

    if (character === "/" && next === "/") {
      kinds[index] = "inert";
      kinds[index + 1] = "inert";
      index += 1;
      state = "line-comment";
    } else if (character === "/" && next === "*") {
      kinds[index] = "inert";
      kinds[index + 1] = "inert";
      index += 1;
      state = "block-comment";
    } else if (character === '"' || character === "'" || character === "`") {
      state = character;
    }
  }

  return kinds;
}

function stripComments(text, path) {
  let stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  if (/\.(?:[cm]?[jt]sx?|java)$/.test(path)) {
    stripped = stripped.replace(/^[\t ]*\/\/.*$/gm, "");
  }
  if (path.endsWith(".py")) {
    stripped = stripped.replace(/^[\t ]*#.*$/gm, "");
  }
  if (/\.(?:ya?ml|env|example)$/.test(path) || path === ".env.example") {
    stripped = stripped.replace(/^[\t ]*#.*$/gm, "");
  }
  return stripped;
}

function normalizePath(path) {
  return path.split(sep).join("/");
}

function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const rootFlag = process.argv.indexOf("--root");
  const root =
    rootFlag === -1
      ? resolve(dirname(scriptPath), "..")
      : resolve(process.argv[rootFlag + 1] ?? "");
  if (rootFlag !== -1 && !process.argv[rootFlag + 1]) {
    throw new Error("--root requires a repository path");
  }
  const audit = verifyRepository(root);
  console.log(formatAudit(audit));
  if (
    audit.missing.length > 0 ||
    audit.findings.some((finding) => !finding.category)
  ) {
    process.exitCode = 1;
  }
}
