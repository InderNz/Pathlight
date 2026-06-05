export function redactOutput(value: string) {
  return value
    .replace(/(authorization:\s*bearer\s+)\S+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|token|secret|password)\s*[=:]\s*)\S+/gi, "$1[REDACTED]");
}
