import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export default async function globalSetup() {
  const projectRoot = resolve(".tmp/e2e-project");
  const targetProjectRoot = resolve(".tmp/e2e-target-project");
  await rm(projectRoot, { recursive: true, force: true });
  await rm(targetProjectRoot, { recursive: true, force: true });
  await mkdir(projectRoot, { recursive: true });
  await mkdir(targetProjectRoot, { recursive: true });
  await writeFile(join(targetProjectRoot, "playwright.config.ts"), "export default {};\n");
}
