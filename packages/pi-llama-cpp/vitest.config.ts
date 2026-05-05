import { defineConfig } from "vitest/config";
import { computeMaxWorkers } from "../core/src/__test-utils__/vitest-workers";

const maxWorkers = computeMaxWorkers();

export default defineConfig({
  test: {
    globals: true,
    pool: "forks",
    maxWorkers,
    poolOptions: { forks: { minForks: 1, maxForks: maxWorkers } },
  },
});
