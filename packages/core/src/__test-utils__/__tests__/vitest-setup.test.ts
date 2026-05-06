import { describe, expect, it, vi } from "vitest";
import {
  __testOnlyAssertListenerCapableProcess,
  __testOnlyRemoveProcessListener,
} from "../vitest-setup.js";

describe("vitest subprocess guard helpers", () => {
  it("reports a clear guard error for child_process mocks without EventEmitter methods", () => {
    const failures: string[] = [];
    const isValid = __testOnlyAssertListenerCapableProcess({ pid: 1234 }, "mocked-cli --run", failures);

    expect(isValid).toBe(false);
    expect(failures).toEqual([
      expect.stringContaining("Subprocess tracker expected an EventEmitter-compatible ChildProcess for mocked-cli --run"),
    ]);
    expect(failures[0]).not.toContain("removeListener is not a function");
  });

  it("does not throw when cleanup sees a process double without removeListener", () => {
    const listener = vi.fn();

    expect(() => {
      __testOnlyRemoveProcessListener({ once: vi.fn() }, "close", listener);
    }).not.toThrow();
  });

  it("uses removeListener when the process double provides it", () => {
    const listener = vi.fn();
    const removeListener = vi.fn();

    __testOnlyRemoveProcessListener({ removeListener }, "close", listener);

    expect(removeListener).toHaveBeenCalledWith("close", listener);
  });
});
