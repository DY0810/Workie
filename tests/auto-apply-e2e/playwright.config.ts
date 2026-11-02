import { defineConfig } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Started by `node tests/auto-apply-e2e/stack.mjs test`, or by hand with E2E_STATE pointing at a running stack's state.json.
const statePath = process.env.E2E_STATE;
if (!statePath) throw new Error('Set E2E_STATE to the state.json printed by tests/auto-apply-e2e/stack.mjs.');
const state = JSON.parse(readFileSync(statePath, 'utf8'));

export default defineConfig({
  testDir: '.', testMatch: '*.pw.ts', outputDir: `${dirname(statePath)}/test-results`,
  reporter: [['list']], workers: 1, retries: 0, forbidOnly: true,
  // A full run tails, fills and parks a real application; a loaded Mac has broken Chrome launches before.
  timeout: 10 * 60_000, expect: { timeout: 30_000 },
  use: { baseURL: state.baseURL, browserName: 'chromium', viewport: { width: 1440, height: 1000 },
    actionTimeout: 30_000, navigationTimeout: 60_000, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
