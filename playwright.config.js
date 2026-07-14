// ABOUTME: Playwright config for the e2e suite — serves the site on the wall's port and
// ABOUTME: points Chromium's fake camera and mic at generated blob.y4m / beats.wav fixtures.
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const CAM_FIXTURE = fileURLToPath(new URL('./test/e2e/fixtures/blob.y4m', import.meta.url));
const MIC_FIXTURE = fileURLToPath(new URL('./test/e2e/fixtures/beats.wav', import.meta.url));

export default defineConfig({
  testDir: 'test/e2e',
  timeout: 120_000,
  workers: 1, // one browser at a time: shared GPU + camera fixture
  globalSetup: './test/e2e/global-setup.mjs',
  webServer: {
    // The real server, not a stand-in: its cache headers are part of what we test.
    command: './serve.sh 127.0.0.1',
    port: 44678,
    reuseExistingServer: true,
  },
  use: {
    baseURL: 'http://127.0.0.1:44678',
    permissions: ['camera', 'microphone'],
    viewport: { width: 960, height: 540 },
    launchOptions: {
      args: [
        '--use-fake-device-for-media-stream',
        `--use-file-for-fake-video-capture=${CAM_FIXTURE}`,
        `--use-file-for-fake-audio-capture=${MIC_FIXTURE}`,
        '--use-fake-ui-for-media-stream',
      ],
    },
  },
});
