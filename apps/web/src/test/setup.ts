import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";
import { setTokenForTesting } from "../api";

beforeEach(() => {
  // Default to no local auth token so existing tests don't trigger /api/local-token fetches.
  setTokenForTesting(null);
});

afterEach(() => {
  cleanup();
});
