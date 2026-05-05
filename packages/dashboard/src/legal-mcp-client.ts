import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type LegalMcpProviderName = "qmd" | "obsidian";

export interface LegalMcpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface LegalMcpConfigFile {
  mcpServers?: Record<string, LegalMcpServerConfig>;
}

export interface LegalMcpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface LegalMcpClient {
  readonly serverName: string;
  listTools(timeoutMs?: number): Promise<LegalMcpTool[]>;
  callTool(name: string, input: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  close(): Promise<void>;
}

export interface LegalMcpResolvedServer {
  name: string;
  config: LegalMcpServerConfig;
  redactedConfig: LegalMcpServerConfig;
}

export const QMD_MCP_SERVER_ALIASES = ["qmd", "qmd-mcp", "quantized-memory"] as const;
export const OBSIDIAN_MCP_SERVER_ALIASES = ["obsidian", "obsidian-mcp", "obsidian-vault"] as const;

export const QMD_READ_TOOL_ALLOWLIST = [
  "search",
  "qmd_search",
  "qmd.search",
  "query",
  "qmd_query",
  "qmd.query",
] as const;

export const OBSIDIAN_READ_TOOL_ALLOWLIST = [
  "search",
  "obsidian_search",
  "obsidian.search",
  "simple_search",
  "obsidian_simple_search",
  "obsidian.get_file_contents",
  "get_file_contents",
  "read",
  "read_note",
] as const;

const MUTATING_TOOL_RE = /(?:^|[._-])(write|create|update|delete|move|rename|append|patch)(?:$|[._-])/i;
const SECRET_KEY_RE = /(?:token|secret|key|password|credential|auth)/i;
const DEFAULT_MCP_TIMEOUT_MS = 8_000;

function aliasesForProvider(provider: LegalMcpProviderName): readonly string[] {
  return provider === "qmd" ? QMD_MCP_SERVER_ALIASES : OBSIDIAN_MCP_SERVER_ALIASES;
}

function allowlistForProvider(provider: LegalMcpProviderName): readonly string[] {
  return provider === "qmd" ? QMD_READ_TOOL_ALLOWLIST : OBSIDIAN_READ_TOOL_ALLOWLIST;
}

export function isAllowedLegalMcpTool(provider: LegalMcpProviderName, toolName: string): boolean {
  const trimmed = toolName.trim();
  if (!trimmed || MUTATING_TOOL_RE.test(trimmed)) return false;
  return allowlistForProvider(provider).includes(trimmed as never);
}

export function assertAllowedLegalMcpTool(provider: LegalMcpProviderName, toolName: string): void {
  if (!isAllowedLegalMcpTool(provider, toolName)) {
    throw new Error(`${provider} MCP tool '${toolName}' is not on the read-only legal vault mining allowlist`);
  }
}

export function redactMcpServerConfig(config: LegalMcpServerConfig): LegalMcpServerConfig {
  const env = config.env
    ? Object.fromEntries(Object.entries(config.env).map(([key, value]) => [key, SECRET_KEY_RE.test(key) || value ? "[REDACTED]" : value]))
    : undefined;
  return {
    command: config.command,
    ...(config.args ? { args: [...config.args] } : {}),
    ...(env ? { env } : {}),
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function normalizeServerConfig(value: unknown): LegalMcpServerConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.command !== "string" || !record.command.trim()) return null;
  const args = record.args === undefined ? undefined : record.args;
  if (args !== undefined && !isStringArray(args)) return null;
  const envValue = record.env;
  let env: Record<string, string> | undefined;
  if (envValue !== undefined) {
    if (!envValue || typeof envValue !== "object" || Array.isArray(envValue)) return null;
    env = {};
    for (const [key, value] of Object.entries(envValue as Record<string, unknown>)) {
      if (typeof value === "string") env[key] = value;
    }
  }
  return {
    command: record.command.trim(),
    ...(args ? { args: [...args] } : {}),
    ...(env ? { env } : {}),
  };
}

export async function loadLegalMcpConfig(rootDir: string): Promise<LegalMcpConfigFile | null> {
  try {
    const content = await readFile(join(rootDir, ".mcp.json"), "utf8");
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const mcpServers = (parsed as Record<string, unknown>).mcpServers;
    if (!mcpServers || typeof mcpServers !== "object" || Array.isArray(mcpServers)) return null;
    const normalized: Record<string, LegalMcpServerConfig> = {};
    for (const [name, value] of Object.entries(mcpServers)) {
      const config = normalizeServerConfig(value);
      if (config) normalized[name] = config;
    }
    return { mcpServers: normalized };
  } catch {
    return null;
  }
}

export function resolveLegalMcpServer(
  config: LegalMcpConfigFile | null | undefined,
  provider: LegalMcpProviderName,
  overrideName?: string,
): LegalMcpResolvedServer | null {
  const servers = config?.mcpServers ?? {};
  const names = Object.keys(servers);
  const selectedName = overrideName?.trim()
    ? names.find((name) => name === overrideName.trim())
    : aliasesForProvider(provider).find((alias) => servers[alias]);
  if (!selectedName) return null;
  const serverConfig = servers[selectedName];
  if (!serverConfig) return null;
  return {
    name: selectedName,
    config: serverConfig,
    redactedConfig: redactMcpServerConfig(serverConfig),
  };
}

function encodeJsonRpcMessage(payload: unknown): string {
  const json = JSON.stringify(payload);
  return `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
}

class JsonRpcStdioConnection {
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private closed = false;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    child.on("error", (error) => this.rejectAll(error instanceof Error ? error : new Error(String(error))));
    child.on("exit", (code, signal) => {
      this.closed = true;
      this.rejectAll(new Error(`MCP server exited (${code ?? signal ?? "unknown"})`));
    });
  }

  request(method: string, params: Record<string, unknown> | undefined, timeoutMs: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("MCP server is closed"));
    const id = this.nextId;
    this.nextId += 1;
    const payload = { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.child.stdin.write(encodeJsonRpcMessage(payload), (error) => {
        if (error) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    if (this.closed) return;
    this.child.stdin.write(encodeJsonRpcMessage({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }));
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = this.buffer.slice(0, headerEnd).toString("utf8");
      const lengthMatch = header.match(/content-length:\s*(\d+)/i);
      if (!lengthMatch) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const length = Number(lengthMatch[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (this.buffer.length < bodyEnd) return;
      const body = this.buffer.slice(bodyStart, bodyEnd).toString("utf8");
      this.buffer = this.buffer.slice(bodyEnd);
      this.handleMessage(body);
    }
  }

  private handleMessage(body: string): void {
    let message: unknown;
    try {
      message = JSON.parse(body) as unknown;
    } catch {
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) return;
    const record = message as Record<string, unknown>;
    if (typeof record.id !== "number") return;
    const pending = this.pending.get(record.id);
    if (!pending) return;
    this.pending.delete(record.id);
    if (record.error) {
      const errorMessage = typeof (record.error as Record<string, unknown>)?.message === "string"
        ? String((record.error as Record<string, unknown>).message)
        : "MCP JSON-RPC error";
      pending.reject(new Error(errorMessage));
      return;
    }
    pending.resolve(record.result);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(new Error("MCP connection closed"));
    this.child.kill();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 500);
      this.child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export class StdioLegalMcpClient implements LegalMcpClient {
  private connection?: JsonRpcStdioConnection;
  private initialized = false;

  constructor(
    readonly serverName: string,
    private readonly config: LegalMcpServerConfig,
    private readonly cwd: string,
  ) {}

  private async ensureConnection(timeoutMs: number): Promise<JsonRpcStdioConnection> {
    if (!this.connection) {
      const child = spawn(this.config.command, this.config.args ?? [], {
        cwd: this.cwd,
        env: { ...process.env, ...(this.config.env ?? {}) },
        shell: false,
        stdio: "pipe",
      });
      this.connection = new JsonRpcStdioConnection(child);
    }
    if (!this.initialized) {
      await this.connection.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "fusion-legal-vault-mining", version: "1.0.0" },
      }, timeoutMs);
      this.connection.notify("notifications/initialized");
      this.initialized = true;
    }
    return this.connection;
  }

  async listTools(timeoutMs = DEFAULT_MCP_TIMEOUT_MS): Promise<LegalMcpTool[]> {
    const connection = await this.ensureConnection(timeoutMs);
    const result = await connection.request("tools/list", undefined, timeoutMs);
    const tools = (result as { tools?: unknown })?.tools;
    if (!Array.isArray(tools)) return [];
    return tools
      .filter((tool): tool is Record<string, unknown> => Boolean(tool) && typeof tool === "object" && !Array.isArray(tool) && typeof (tool as Record<string, unknown>).name === "string")
      .map((tool) => ({
        name: String(tool.name),
        ...(typeof tool.description === "string" ? { description: tool.description } : {}),
        ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
      }));
  }

  async callTool(name: string, input: Record<string, unknown>, timeoutMs = DEFAULT_MCP_TIMEOUT_MS): Promise<unknown> {
    const connection = await this.ensureConnection(timeoutMs);
    return connection.request("tools/call", { name, arguments: input }, timeoutMs);
  }

  async close(): Promise<void> {
    await this.connection?.close();
  }
}

export async function createLegalMcpClientFromProjectConfig(params: {
  rootDir: string;
  provider: LegalMcpProviderName;
  serverName?: string;
}): Promise<{ client: LegalMcpClient; server: LegalMcpResolvedServer } | null> {
  const config = await loadLegalMcpConfig(params.rootDir);
  const server = resolveLegalMcpServer(config, params.provider, params.serverName);
  if (!server) return null;
  return {
    client: new StdioLegalMcpClient(server.name, server.config, params.rootDir),
    server,
  };
}
