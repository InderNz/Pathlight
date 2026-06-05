const ALLOWED_IMPORT_PATTERN = /^(?:@playwright\/test|node:.+|\.\.?\/)/;

export function checkTestQuality(content: string, journeyId: string) {
  const hasJourneyId = content.includes(`[${journeyId}]`);
  const hasExpect = /\bexpect\s*\(/.test(content);
  const hasPlaywrightImport =
    /from\s+['"]@playwright\/test['"]/.test(content) ||
    /require\s*\(\s*['"]@playwright\/test['"]\s*\)/.test(content);

  const importLines = [...content.matchAll(/^import\s+.+\s+from\s+['"]([^'"]+)['"]/gm)].map(
    (m) => m[1],
  );
  const noForbiddenImports = importLines.every((src) => ALLOWED_IMPORT_PATTERN.test(src));

  return {
    hasJourneyId,
    hasExpect,
    hasPlaywrightImport,
    noForbiddenImports,
    passed: hasJourneyId && hasExpect && hasPlaywrightImport && noForbiddenImports,
  };
}
