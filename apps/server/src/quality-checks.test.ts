// @vitest-environment node
import { describe, expect, it } from "vitest";
import { checkTestQuality } from "./quality-checks.js";

const goodContent = `import { test, expect } from '@playwright/test';

test('[E2E-007] SMS gateway times out', async ({ page }) => {
  await page.goto('/review');
  expect(page).toBeTruthy();
});
`;

describe("checkTestQuality", () => {
  it("passes a well-formed test", () => {
    const result = checkTestQuality(goodContent, "E2E-007");
    expect(result.hasJourneyId).toBe(true);
    expect(result.hasExpect).toBe(true);
    expect(result.hasPlaywrightImport).toBe(true);
    expect(result.noForbiddenImports).toBe(true);
    expect(result.passed).toBe(true);
  });

  it("fails when journey ID bracket is missing", () => {
    const content = goodContent.replace("[E2E-007]", "no-bracket");
    const result = checkTestQuality(content, "E2E-007");
    expect(result.hasJourneyId).toBe(false);
    expect(result.passed).toBe(false);
  });

  it("fails when expect() is missing", () => {
    const content = goodContent.replace(/expect\(page\)\.toBeTruthy\(\);/, "// no assertion");
    const result = checkTestQuality(content, "E2E-007");
    expect(result.hasExpect).toBe(false);
    expect(result.passed).toBe(false);
  });

  it("fails when @playwright/test import is missing", () => {
    const content = goodContent.replace(
      "import { test, expect } from '@playwright/test';",
      "// no playwright import",
    );
    const result = checkTestQuality(content, "E2E-007");
    expect(result.hasPlaywrightImport).toBe(false);
    expect(result.passed).toBe(false);
  });

  it("fails when a forbidden third-party import is present", () => {
    const content = goodContent + "\nimport axios from 'axios';\n";
    const result = checkTestQuality(content, "E2E-007");
    expect(result.noForbiddenImports).toBe(false);
    expect(result.passed).toBe(false);
  });

  it("allows relative imports alongside playwright import", () => {
    const content = goodContent + "\nimport { helper } from './helpers';\n";
    const result = checkTestQuality(content, "E2E-007");
    expect(result.noForbiddenImports).toBe(true);
  });

  it("allows node: built-in imports", () => {
    const content = goodContent + "\nimport { join } from 'node:path';\n";
    const result = checkTestQuality(content, "E2E-007");
    expect(result.noForbiddenImports).toBe(true);
  });

  it("returns all fields even for completely empty content", () => {
    const result = checkTestQuality("", "E2E-007");
    expect(result).toHaveProperty("hasJourneyId");
    expect(result).toHaveProperty("hasExpect");
    expect(result).toHaveProperty("hasPlaywrightImport");
    expect(result).toHaveProperty("noForbiddenImports");
    expect(result).toHaveProperty("passed");
    expect(result.passed).toBe(false);
  });
});
