import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const reporterUrl = new URL('../utils/crash-reporter.js', import.meta.url).href;
test('unhandled rejection is persisted and terminates the corrupted worker', () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'beyound-crash-reporter-'));
    try {
        const source = `
      const { installCrashHandlers } = await import(${JSON.stringify(reporterUrl)});
      installCrashHandlers();
      Promise.reject(new Error('round2_unhandled_rejection_probe'));
      setTimeout(() => process.exit(0), 1500);
    `;
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
            cwd,
            encoding: 'utf8',
            timeout: 5000,
        });
        assert.equal(result.status, 1, `stderr=${result.stderr}`);
        const log = readFileSync(path.join(cwd, 'data', 'crashes.log'), 'utf8');
        assert.match(log, /"kind":"unhandledRejection"/);
        assert.match(log, /round2_unhandled_rejection_probe/);
    }
    finally {
        rmSync(cwd, { recursive: true, force: true });
    }
});
