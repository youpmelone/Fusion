import { beforeEach, describe, expect, it, vi } from "vitest";

const { isGhAvailableMock, isGhAuthenticatedMock } = vi.hoisted(() => ({
  isGhAvailableMock: vi.fn(),
  isGhAuthenticatedMock: vi.fn(),
}));

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  return {
    ...actual,
    isGhAvailable: isGhAvailableMock,
    isGhAuthenticated: isGhAuthenticatedMock,
  };
});

import { ResearchProviderRegistry } from "../provider-registry.js";

describe("ResearchProviderRegistry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isGhAvailableMock.mockReturnValue(false);
    isGhAuthenticatedMock.mockReturnValue(false);
  });

  it("instantiates providers with defaults", () => {
    const registry = new ResearchProviderRegistry({}, process.cwd());
    expect(registry.getProvider("web-search")).toBeDefined();
    expect(registry.getProvider("page-fetch")).toBeDefined();
    expect(registry.isProviderAvailable("local-docs")).toBe(true);
    expect(registry.isProviderAvailable("github")).toBe(false);
  });

  it("detects search backend from credentials", () => {
    const tavily = new ResearchProviderRegistry({ researchGlobalTavilyApiKey: "key" }, process.cwd());
    expect(tavily.isProviderAvailable("web-search")).toBe(true);

    const searx = new ResearchProviderRegistry({ researchGlobalSearxngUrl: "https://sx.local" }, process.cwd());
    expect(searx.isProviderAvailable("web-search")).toBe(true);
  });

  it("returns configured providers with GitHub available when the CLI is authenticated", () => {
    isGhAvailableMock.mockReturnValue(true);
    isGhAuthenticatedMock.mockReturnValue(true);

    const registry = new ResearchProviderRegistry(
      {
        researchGlobalWebSearchProvider: "brave",
        researchGlobalBraveApiKey: "token",
        researchGlobalGitHubEnabled: true,
      },
      process.cwd(),
    );

    const available = registry.getAvailableProviders();
    expect(available).toEqual(
      expect.arrayContaining(["web-search", "github", "local-docs", "page-fetch", "llm-synthesis"]),
    );
    expect(isGhAvailableMock).toHaveBeenCalled();
    expect(isGhAuthenticatedMock).toHaveBeenCalled();
  });

  it("keeps GitHub unavailable when enabled but the CLI or auth check is unavailable", () => {
    isGhAvailableMock.mockReturnValue(false);
    isGhAuthenticatedMock.mockReturnValue(true);

    const registry = new ResearchProviderRegistry({ researchGlobalGitHubEnabled: true }, process.cwd());

    expect(registry.getAvailableProviders()).not.toContain("github");
    expect(registry.isProviderAvailable("github")).toBe(false);
  });

  it("does not probe GitHub CLI state while refreshing providers", () => {
    new ResearchProviderRegistry({ researchGlobalGitHubEnabled: true }, process.cwd());

    expect(isGhAvailableMock).not.toHaveBeenCalled();
    expect(isGhAuthenticatedMock).not.toHaveBeenCalled();
  });

  it("refreshes providers after settings changes", () => {
    const registry = new ResearchProviderRegistry({ researchGlobalWebSearchProvider: "none" }, process.cwd());
    expect(registry.isProviderAvailable("web-search")).toBe(false);

    registry.refreshSettings({ researchGlobalWebSearchProvider: "tavily", researchGlobalTavilyApiKey: "key" });
    expect(registry.isProviderAvailable("web-search")).toBe(true);
  });

  it("gracefully degrades disabled providers", () => {
    const registry = new ResearchProviderRegistry({ researchGlobalGitHubEnabled: false, researchGlobalLocalDocsEnabled: false }, process.cwd());
    expect(registry.isProviderAvailable("github")).toBe(false);
    expect(registry.isProviderAvailable("local-docs")).toBe(false);
  });
});
