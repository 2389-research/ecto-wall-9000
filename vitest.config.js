// ABOUTME: Scopes vitest to the unit tests so it never swallows the Playwright e2e specs,
// ABOUTME: which live under test/e2e and are run by their own runner.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.js'],
  },
});
