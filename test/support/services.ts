/**
 * Integration tests run against disposable containers (scripts/integration/start.sh) and skip
 * when the service is not configured. CI sets WORKBENCH_REQUIRE_INTEGRATION=1 so that a missing
 * service fails the run instead of silently skipping it.
 */
export function skipUnless(variable: string): string | false {
  if (process.env[variable]) return false;
  if (process.env.WORKBENCH_REQUIRE_INTEGRATION === '1') {
    throw new Error(`${variable} is required for integration tests (see scripts/integration/start.sh).`);
  }
  return `set ${variable} to run (scripts/integration/start.sh)`;
}
