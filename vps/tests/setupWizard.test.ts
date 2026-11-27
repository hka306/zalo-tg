import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { writeEnvUpdates, SETUP_STEPS } from '../src/telegram/setupWizard.js';

function tempEnv(initial: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'setupwiz-'));
  const envPath = path.join(dir, '.env');
  if (initial !== '') writeFileSync(envPath, initial, 'utf8');
  return envPath;
}

function cleanup(envPath: string): void {
  rmSync(path.dirname(envPath), { recursive: true, force: true });
}

test('writeEnvUpdates creates .env with quoted values when needed', () => {
  const envPath = tempEnv('');
  try {
    const updated = writeEnvUpdates(
      { ZALO_MUTE_SILENT: '0', ZALO_SKIP_MUTED_GROUPS: '1', DATA_DIR: 'my dir' },
      envPath,
    );
    assert.deepEqual(updated, ['ZALO_MUTE_SILENT', 'ZALO_SKIP_MUTED_GROUPS', 'DATA_DIR']);
    assert.equal(
      readFileSync(envPath, 'utf8'),
      'ZALO_MUTE_SILENT=0\nZALO_SKIP_MUTED_GROUPS=1\nDATA_DIR="my dir"\n',
    );
  } finally {
    cleanup(envPath);
  }
});

test('writeEnvUpdates preserves comments, order and unrelated lines', () => {
  const envPath = tempEnv(
    [
      '# Bridge config',
      'TG_TOKEN=123',
      '',
      'ZALO_MUTE_SILENT=1',
      'ZALO_EXCLUDE_THREADS=1:5',
    ].join('\n'),
  );
  try {
    writeEnvUpdates({ ZALO_MUTE_SILENT: '0', NEW_FLAG: '1' }, envPath);
    assert.equal(
      readFileSync(envPath, 'utf8'),
      [
        '# Bridge config',
        'TG_TOKEN=123',
        '',
        'ZALO_MUTE_SILENT=0',
        'ZALO_EXCLUDE_THREADS=1:5',
        'NEW_FLAG=1',
      ].join('\n') + '\n',
    );
  } finally {
    cleanup(envPath);
  }
});

test('writeEnvUpdates replaces an existing value with the same key', () => {
  const envPath = tempEnv('ZALO_MUTE_SILENT=0\n');
  try {
    writeEnvUpdates({ ZALO_MUTE_SILENT: '1' }, envPath);
    assert.equal(readFileSync(envPath, 'utf8'), 'ZALO_MUTE_SILENT=1\n');
  } finally {
    cleanup(envPath);
  }
});

test('wizard steps cover the interactive env variables', () => {
  const keys = SETUP_STEPS.map(step => step.key);
  assert.deepEqual(keys, [
    'ZALO_SKIP_MUTED_GROUPS',
    'ZALO_MUTE_SILENT',
    'ZALO_DM_NATIVE_REACTION',
    'ZALO_EXCLUDE_THREADS',
  ]);
});
