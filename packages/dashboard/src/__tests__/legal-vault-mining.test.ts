import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { TaskStore } from "@fusion/core";
import type { ResearchRun, ResearchSource, Task, TaskDocument } from "@fusion/core";
import {
  assertAllowedLegalMcpTool,
  isAllowedLegalMcpTool,
  loadLegalMcpConfig,
  redactMcpServerConfig,
  resolveLegalMcpServer,
  StdioLegalMcpClient,
  type LegalMcpClient,
  type LegalMcpTool,
} from "../legal-mcp-client.js";
import {
  VAULT_MINING_RECEIPTS_DOCUMENT_KEY,
  VAULT_MINING_STATUS_DOCUMENT_KEY,
  buildVaultMiningQueries,
  deriveVaultMiningStatusForRun,
  mineCounterLawsuitVaultSources,
  normalizeVaultMiningProviderPayload,
  validateVaultMiningOverrides,
} from "../legal-vault-mining.js";

function makeTask(id: string, stage: string, runId = "CLW-1"): Task {
  return {
    id,
    title: stage,
    description: stage,
    priority: "high",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-05-05T00:00:00.000Z",
    updatedAt: "2026-05-05T00:00:00.000Z",
    sourceMetadata: {
      workflowKind: "counter-lawsuit-prototype",
      workflowRunId: runId,
      workflowStage: stage,
      workflowStageIndex: stage === "research-memo" ? 0 : 1,
    },
  };
}

class FakeResearchStore {
  runs: ResearchRun[] = [];

  createRun(input: any): ResearchRun {
    const run = {
      id: `RR-${this.runs.length + 1}`,
      query: input.query,
      topic: input.topic,
      status: "queued",
      trigger: input.trigger,
      sources: input.sources ?? [],
      events: [],
      tags: input.tags ?? [],
      metadata: input.metadata,
      lifecycle: input.lifecycle,
      createdAt: "2026-05-05T00:00:00.000Z",
      updatedAt: "2026-05-05T00:00:00.000Z",
    } as ResearchRun;
    this.runs.push(run);
    return run;
  }

  updateStatus(id: string, status: ResearchRun["status"], extra?: Partial<ResearchRun>): void {
    const run = this.runs.find((candidate) => candidate.id === id);
    if (!run) throw new Error("missing run");
    Object.assign(run, extra ?? {}, { status });
  }
}

class FakeTaskStore {
  tasks = [makeTask("FN-1", "research-memo"), makeTask("FN-2", "evidence-ledger")];
  documents = new Map<string, TaskDocument>();
  researchStore = new FakeResearchStore();

  constructor(private readonly rootDir = process.cwd()) {
    this.documents.set("FN-1:counter-lawsuit-stage", {
      id: "DOC-1",
      taskId: "FN-1",
      key: "counter-lawsuit-stage",
      content: "# Stage\n",
      revision: 1,
      author: "fusion",
      createdAt: "now",
      updatedAt: "now",
    });
  }

  getRootDir(): string {
    return this.rootDir;
  }

  async listTasks(): Promise<Task[]> {
    return this.tasks;
  }

  async upsertTaskDocument(taskId: string, input: { key: string; content: string; author?: string; metadata?: Record<string, unknown> }): Promise<TaskDocument> {
    const document = {
      id: `${taskId}:${input.key}`,
      taskId,
      key: input.key,
      content: input.content,
      revision: 1,
      author: input.author ?? "fusion",
      metadata: input.metadata,
      createdAt: "now",
      updatedAt: "now",
    } as TaskDocument;
    this.documents.set(`${taskId}:${input.key}`, document);
    return document;
  }

  async getTaskDocument(taskId: string, key: string): Promise<TaskDocument | null> {
    return this.documents.get(`${taskId}:${key}`) ?? null;
  }

  getResearchStore(): FakeResearchStore {
    return this.researchStore;
  }
}

class FakeMcpClient implements LegalMcpClient {
  closed = false;
  calls: Array<{ name: string; input: Record<string, unknown> }> = [];

  constructor(
    readonly serverName: string,
    private readonly tools: LegalMcpTool[],
    private readonly result: unknown,
    private readonly failCall = false,
  ) {}

  async listTools(): Promise<LegalMcpTool[]> {
    return this.tools;
  }

  async callTool(name: string, input: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ name, input });
    if (this.failCall) throw new Error("provider timed out");
    return this.result;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

describe("legal MCP client configuration and allowlist", () => {
  it("loads .mcp.json, resolves QMD/Obsidian aliases, and redacts env diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-mcp-"));
    try {
      await writeFile(join(root, ".mcp.json"), JSON.stringify({
        mcpServers: {
          "qmd-mcp": { command: "qmd", args: ["mcp", "--token", "qmd-token-secret-value"], env: { QMD_TOKEN: "secret-token-value" } },
          "obsidian-vault": { command: "obsidian-mcp", env: { OBSIDIAN_API_KEY: "secret" } },
        },
      }));
      const config = await loadLegalMcpConfig(root);
      const qmd = resolveLegalMcpServer(config, "qmd");
      const obsidian = resolveLegalMcpServer(config, "obsidian");
      expect(qmd?.name).toBe("qmd-mcp");
      expect(obsidian?.name).toBe("obsidian-vault");
      expect(qmd?.redactedConfig.env?.QMD_TOKEN).toBe("[REDACTED]");
      expect(qmd?.redactedConfig.args).toEqual(["mcp", "--token", "[REDACTED]"]);
      expect(JSON.stringify(qmd?.redactedConfig)).not.toContain("secret-token-value");
      expect(JSON.stringify(qmd?.redactedConfig)).not.toContain("qmd-token-secret-value");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows only read/search tools and denies mutating verbs", () => {
    expect(isAllowedLegalMcpTool("qmd", "qmd.search")).toBe(true);
    expect(isAllowedLegalMcpTool("obsidian", "obsidian.get_file_contents")).toBe(true);
    expect(isAllowedLegalMcpTool("obsidian", "write")).toBe(false);
    expect(isAllowedLegalMcpTool("qmd", "qmd.update")).toBe(false);
    expect(() => assertAllowedLegalMcpTool("obsidian", "delete_note")).toThrow(/read-only/);
  });

  it("enforces the read-only allowlist inside the stdio MCP wrapper", async () => {
    const client = new StdioLegalMcpClient("qmd", { command: "missing-command" }, process.cwd(), "qmd");
    await expect(client.callTool("qmd.update", { query: "Acme" })).rejects.toThrow(/read-only/);
  });

  it("redacts every configured env value in diagnostics", () => {
    const redacted = redactMcpServerConfig({
      command: "cmd",
      args: ["--header", "Authorization: Bearer obsidian-token-secret-value"],
      env: { SAFE: "value", TOKEN: "secret" },
    });
    expect(redacted.env).toEqual({
      SAFE: "[REDACTED]",
      TOKEN: "[REDACTED]",
    });
    expect(redacted.args).toEqual(["--header", "[REDACTED]"]);
  });

  it("times out and closes stdio transports that do not answer MCP initialization", async () => {
    const client = new StdioLegalMcpClient("qmd", { command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] }, process.cwd(), "qmd");
    await expect(client.listTools(20)).rejects.toThrow(/timed out/);
    await expect(client.close()).resolves.toBeUndefined();
  });
});

describe("vault mining receipt normalization", () => {
  it("normalizes provider hits into persisted-safe unverified receipts with source paths", () => {
    const normalized = normalizeVaultMiningProviderPayload({
      providerName: "qmd",
      sourceSystem: "qmd-mcp",
      mcpServerName: "qmd-mcp",
      toolName: "search",
      query: "Acme",
      retrievedAt: "2026-05-05T00:00:00.000Z",
      rawResult: {
        results: [
          { path: "client/acme/timeline.md", lineStart: 10, lineEnd: 12, title: "Timeline", content: "Retaliatory filing note with Authorization: Bearer abcdefghijklmnop and token: qrstuvwxyz123456" },
        ],
      },
    });

    expect(normalized.rejectedHits).toEqual([]);
    expect(normalized.receipts).toHaveLength(1);
    expect(normalized.receipts[0]).toMatchObject({
      sourceSystem: "qmd-mcp",
      providerName: "qmd",
      mcpServerName: "qmd-mcp",
      toolName: "search",
      query: "Acme",
      sourcePath: "client/acme/timeline.md",
      lineStart: 10,
      lineEnd: 12,
      verified: false,
    });
    expect(normalized.receipts[0].excerpt).not.toContain("Authorization: Bearer abcdefghijklmnop");
    expect(normalized.receipts[0].excerpt).not.toContain("token: qrstuvwxyz123456");
    expect(normalized.receipts[0].hash).toMatch(/^[a-f0-9]{64}$/);
    expect(normalized.receipts[0].receiptId).toMatch(/^LVR-/);
  });

  it("normalizes standard MCP CallToolResult text JSON payloads", () => {
    const normalized = normalizeVaultMiningProviderPayload({
      providerName: "obsidian",
      sourceSystem: "obsidian-mcp",
      mcpServerName: "obsidian-vault",
      toolName: "search",
      query: "Acme",
      rawResult: {
        content: [
          { type: "text", text: JSON.stringify({ results: [{ path: "Vault/Timeline.md", snippet: "MCP JSON excerpt" }] }) },
        ],
      },
    });

    expect(normalized.rejectedHits).toEqual([]);
    expect(normalized.receipts[0]).toMatchObject({ sourcePath: "Vault/Timeline.md", excerpt: "MCP JSON excerpt", verified: false });
  });

  it("quarantines hits without usable source paths and deduplicates matching receipts", () => {
    const normalized = normalizeVaultMiningProviderPayload({
      providerName: "obsidian",
      sourceSystem: "obsidian-mcp",
      mcpServerName: "obsidian",
      toolName: "search",
      query: "Acme",
      rawResult: [
        { title: "No path", excerpt: "missing path Authorization: Bearer abcdefghijklmnop" },
        { path: "note.md", excerpt: "same" },
        { path: "note.md", excerpt: "same" },
      ],
    });
    expect(normalized.receipts).toHaveLength(1);
    expect(normalized.rejectedHits).toHaveLength(1);
    expect(normalized.rejectedHits[0].reason).toBe("missing sourcePath");
    expect(JSON.stringify(normalized.rejectedHits)).not.toContain("Authorization: Bearer abcdefghijklmnop");
  });

  it("bounds query and max-result inputs", () => {
    expect(buildVaultMiningQueries({ runId: "CLW-1", matterName: " Acme ", queries: ["Acme", "Retaliation"], maxQueries: 2 })).toEqual(["Acme", "Retaliation"]);
    expect(() => buildVaultMiningQueries({ runId: "CLW-1", queries: "bad" as never })).toThrow(/queries/);
    expect(() => buildVaultMiningQueries({ runId: "CLW-1", queries: ["valid", ""] })).toThrow(/non-empty/);
    expect(() => validateVaultMiningOverrides({ qmd: { searchToolName: "update" } })).toThrow(/read-only/);
  });
});

describe("mineCounterLawsuitVaultSources", () => {
  it("persists accepted receipts to ResearchStore and research-memo task documents", async () => {
    const taskStore = new FakeTaskStore();
    const qmdClient = new FakeMcpClient("qmd-mcp", [{ name: "qmd.search" }], [{ sourcePath: "vault/qmd.md", excerpt: "qmd excerpt Authorization: Bearer abcdefghijklmnop" }]);
    const obsidianClient = new FakeMcpClient("obsidian-vault", [{ name: "obsidian.search" }], [{ path: "vault/obsidian.md", content: "obsidian excerpt" }]);
    const result = await mineCounterLawsuitVaultSources({
      taskStore: taskStore as never,
      runId: "CLW-1",
      launchInput: { matterName: "Acme", safeguards: { citationSourceVerification: true, opposingCounselRedTeam: true, preserveLineage: true } },
      mcpClientFactory: async ({ provider }) => provider === "qmd"
        ? { client: qmdClient, mcpServerName: "qmd-mcp", redactedConfig: { command: "qmd", env: { TOKEN: "[REDACTED]" } } }
        : { client: obsidianClient, mcpServerName: "obsidian-vault", redactedConfig: { command: "obsidian", env: { TOKEN: "[REDACTED]" } } },
      now: () => new Date("2026-05-05T00:00:00.000Z"),
    });

    expect(result.receiptCount).toBe(2);
    expect(result.receipts.every((receipt) => receipt.verified === false)).toBe(true);
    expect(qmdClient.closed).toBe(true);
    expect(obsidianClient.closed).toBe(true);
    expect(taskStore.researchStore.runs).toHaveLength(1);
    const sources = taskStore.researchStore.runs[0].sources as ResearchSource[];
    expect(sources.map((source) => source.reference)).toEqual(["vault/qmd.md", "vault/obsidian.md"]);
    expect(JSON.stringify(sources)).not.toContain("Authorization: Bearer abcdefghijklmnop");
    expect(JSON.stringify(sources)).not.toContain("token: qrstuvwxyz123456");

    const receiptsDoc = await taskStore.getTaskDocument("FN-1", VAULT_MINING_RECEIPTS_DOCUMENT_KEY);
    const statusDoc = await taskStore.getTaskDocument("FN-1", VAULT_MINING_STATUS_DOCUMENT_KEY);
    expect(receiptsDoc?.content).toContain("not legally verified");
    expect(receiptsDoc?.content).toContain("vault/qmd.md");
    expect(receiptsDoc?.metadata?.researchRunId).toBe("RR-1");
    expect(receiptsDoc?.content).not.toContain("Authorization: Bearer abcdefghijklmnop");
    expect(JSON.stringify(receiptsDoc?.metadata)).not.toContain("Authorization: Bearer abcdefghijklmnop");
    expect(statusDoc?.content).toContain("Vault mining status");
    expect((await taskStore.getTaskDocument("FN-1", "counter-lawsuit-stage"))?.content).toContain("vault-mining-receipts");
  });

  it("persists through the real SQLite-backed ResearchStore lifecycle", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-vault-real-store-"));
    const store = new TaskStore(root, join(root, ".fusion-global-settings"), { inMemoryDb: true });
    try {
      await store.init();
      await store.createTask({
        title: "Research memo",
        description: "research",
        column: "todo",
        source: {
          sourceType: "dashboard_ui",
          sourceRunId: "CLW-real",
          sourceMetadata: {
            workflowKind: "counter-lawsuit-prototype",
            workflowRunId: "CLW-real",
            workflowStage: "research-memo",
            workflowStageIndex: 0,
          },
        },
      });
      const result = await mineCounterLawsuitVaultSources({
        taskStore: store,
        runId: "CLW-real",
        request: { queries: ["Acme"], maxResultsPerProvider: 2 },
        mcpClientFactory: async () => null,
        searchProjectMemoryFn: async () => [{ path: ".fusion/memory/MEMORY.md", lineStart: 1, lineEnd: 1, snippet: "real store excerpt", score: 1, backend: "qmd" }],
      });

      expect(result.researchRunId).toBeTruthy();
      const run = store.getResearchStore().getRun(result.researchRunId!);
      expect(run?.status).toBe("completed");
      expect(run?.sources[0].reference).toBe(".fusion/memory/MEMORY.md");
    } finally {
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses QMD project-memory fallback only when QMD MCP is unavailable", async () => {
    const taskStore = new FakeTaskStore();
    const obsidianClient = new FakeMcpClient("obsidian-vault", [{ name: "search" }], []);
    const searchProjectMemoryFn = vi.fn(async () => [{
      path: ".fusion/memory/MEMORY.md",
      lineStart: 1,
      lineEnd: 2,
      snippet: "memory excerpt",
      score: 1,
      backend: "qmd",
    }]);

    const result = await mineCounterLawsuitVaultSources({
      taskStore: taskStore as never,
      runId: "CLW-1",
      request: { queries: ["Acme"], maxResultsPerProvider: 2 },
      mcpClientFactory: async ({ provider }) => provider === "qmd"
        ? null
        : { client: obsidianClient, mcpServerName: "obsidian-vault" },
      searchProjectMemoryFn: searchProjectMemoryFn as never,
    });

    expect(searchProjectMemoryFn).toHaveBeenCalledTimes(1);
    expect(result.receipts.some((receipt) => receipt.sourceSystem === "qmd-memory-fallback")).toBe(true);
    expect(result.providerDiagnostics.map((diagnostic) => diagnostic.providerName)).toContain("qmd-memory-fallback");
  });

  it("records unavailable providers and closes transports when tool calls fail", async () => {
    const taskStore = new FakeTaskStore();
    const failingClient = new FakeMcpClient("qmd-mcp", [{ name: "search" }], [], true);
    const result = await mineCounterLawsuitVaultSources({
      taskStore: taskStore as never,
      runId: "CLW-1",
      request: { queries: ["Acme"] },
      mcpClientFactory: async ({ provider }) => provider === "qmd"
        ? { client: failingClient, mcpServerName: "qmd-mcp" }
        : null,
      searchProjectMemoryFn: async () => [],
    });

    expect(failingClient.closed).toBe(true);
    expect(result.status).toBe("unavailable");
    expect(result.providerDiagnostics.some((diagnostic) => diagnostic.status === "error")).toBe(true);
    expect(result.providerDiagnostics.some((diagnostic) => diagnostic.status === "unavailable")).toBe(true);
  });

  it("redacts token-like values from persisted provider error diagnostics", async () => {
    class SecretFailingClient extends FakeMcpClient {
      override async callTool(): Promise<unknown> {
        throw new Error("provider failed with Authorization: Bearer abcdefghijklmnop and token: qrstuvwxyz123456");
      }
    }
    const taskStore = new FakeTaskStore();
    const result = await mineCounterLawsuitVaultSources({
      taskStore: taskStore as never,
      runId: "CLW-1",
      request: { queries: ["Acme"] },
      mcpClientFactory: async ({ provider }) => provider === "qmd"
        ? { client: new SecretFailingClient("qmd-mcp", [{ name: "search" }], []), mcpServerName: "qmd-mcp" }
        : null,
      searchProjectMemoryFn: async () => [],
    });

    expect(JSON.stringify(result.providerDiagnostics)).not.toContain("Authorization: Bearer abcdefghijklmnop");
    expect(JSON.stringify(result.providerDiagnostics)).not.toContain("token: qrstuvwxyz123456");
    expect(JSON.stringify(taskStore.researchStore.runs[0].metadata)).not.toContain("Authorization: Bearer abcdefghijklmnop");
  });

  it("derives persisted vault-mining status from deterministic task documents", async () => {
    const taskStore = new FakeTaskStore();
    await mineCounterLawsuitVaultSources({
      taskStore: taskStore as never,
      runId: "CLW-1",
      request: { queries: ["Acme"] },
      mcpClientFactory: async () => null,
      searchProjectMemoryFn: async () => [],
    });

    const status = await deriveVaultMiningStatusForRun({ taskStore: taskStore as never, runId: "CLW-1" });
    expect(status.receiptsDocumentKey).toBe("vault-mining-receipts");
    expect(status.statusDocumentKey).toBe("vault-mining-status");
    expect(status.receiptCount).toBe(0);
    expect(status.providerDiagnostics.length).toBeGreaterThan(0);
  });
});
