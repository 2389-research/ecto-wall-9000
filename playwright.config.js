// ABOUTME: Playwright config for the e2e suite — serves the site on the wall's port and
// ABOUTME: points Chromium's fake camera at a generated y4m moving-blob fixture.
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const FIXTURE = fileURLToPath(new URL('./test/e2e/fixtures/blob.y4m', import.meta.url));

export default defineConfig({
  testDir: 'test/e2e',
  timeout: 120_000,
  workers: 1, // one browser at a time: shared GPU + camera fixture
  globalSetup: './test/e2e/global-setup.mjs',
  webServer: {
    command: 'python3 -m http.server 44678 --bind 127.0.0.1',
    port: 44678,
    reuseExistingServer: true,
  },
  use: {
    baseURL: 'http://127.0.0.1:44678',
    permissions: ['camera'],
    viewport: { width: 960, height: 540 },
    launchOptions: {
      args: [
        '--use-fake-device-for-media-stream',
        `--use-file-for-fake-video-capture=${FIXTURE}`,
        '--use-fake-ui-for-media-stream',
      ],
    },
  },
});
