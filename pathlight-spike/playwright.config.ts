import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout:  30000,
  retries:  0,
  workers:  1, // Single worker mandatory for the spike
  reporter: [
    ['list'],
    [
      './spike/reporter.js',
      {
        serverUrl: 'http://localhost:4242',
        runId:     'run_001'
      }
    ]
  ],
  use: {
    baseURL: 'http://localhost:3000'
  }
});
