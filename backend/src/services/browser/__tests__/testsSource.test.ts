import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { localTestsSourceWarning } from '../testsSource.js';

describe('localTestsSourceWarning', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('returns null when the local tests folder exists', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tests-source-'));
    expect(localTestsSourceWarning(dir)).toBeNull();
  });

  it('names the path and both variables when the folder is missing', () => {
    const missing = path.join(os.tmpdir(), 'definitely-missing-tests-source-7f3a');
    const warning = localTestsSourceWarning(missing);

    expect(warning).toContain(missing);
    expect(warning).toContain('TESTS_REPO_URL');
    expect(warning).toContain('TESTS_SOURCE_PATH');
  });
});
