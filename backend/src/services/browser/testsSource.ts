import * as fs from 'fs';

/**
 * Startup warning for the git-sync opt-out (TESTS_REPO_URL set to an empty
 * string) when the local fallback folder doesn't exist. Without it the Browser
 * module just shows an empty upstream library with no hint why.
 */
export function localTestsSourceWarning(testsSourcePath: string): string | null {
  if (fs.existsSync(testsSourcePath)) return null;
  return (
    `⚠ Git sync is off (TESTS_REPO_URL is empty) and TESTS_SOURCE_PATH does not exist: ${testsSourcePath}\n` +
    '  The upstream test library will be empty. Unset TESTS_REPO_URL to use the default f0_library,\n' +
    '  or point TESTS_SOURCE_PATH at a tests_source folder.'
  );
}
