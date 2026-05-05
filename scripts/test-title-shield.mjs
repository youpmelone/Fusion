const neutralTitle = process.env.FUSION_TEST_PROCESS_TITLE || "fusion-test-worker";

function resetTitle() {
  if (/vitest/i.test(process.title)) {
    process.title = neutralTitle;
  }
}

resetTitle();
const timer = setInterval(resetTitle, 100);
timer.unref?.();
