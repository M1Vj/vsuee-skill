import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  MoodleClient,
  encryptCredential,
  decryptCredential,
  getMachineKey,
} from '../lib/moodle-client.mjs';

function createTestClient(options = {}) {
  const sessionFile = path.join(
    os.tmpdir(),
    `vsuee-test-session-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  );
  return new MoodleClient({ sessionFile, ...options });
}

test('encryptCredential and decryptCredential round-trip with AES-256-GCM', () => {
  const secret = 'test-secret-password-123';
  const ciphertext = encryptCredential(secret);

  assert.ok(ciphertext, 'Ciphertext should not be null');
  assert.equal(typeof ciphertext, 'string');
  const parts = ciphertext.split(':');
  assert.equal(parts.length, 3, 'Ciphertext should be formatted as iv:authTag:encrypted');

  // Verify non-deterministic IV (two encryptions differ)
  const ciphertext2 = encryptCredential(secret);
  assert.notEqual(ciphertext, ciphertext2);

  // Round-trip decryption
  const decrypted = decryptCredential(ciphertext);
  assert.equal(decrypted, secret);
  assert.equal(decryptCredential(ciphertext2), secret);
});

test('encryptCredential and decryptCredential edge cases', () => {
  assert.equal(encryptCredential(null), null);
  assert.equal(encryptCredential(''), null);
  assert.equal(encryptCredential(undefined), null);
  assert.equal(encryptCredential(12345), null);

  assert.equal(decryptCredential(null), null);
  assert.equal(decryptCredential(''), null);
  assert.equal(decryptCredential('invalid'), null);
  assert.equal(decryptCredential('a:b:c'), null);
  assert.equal(decryptCredential('00:11:22'), null);

  // Tampered ciphertext fails authentication check and returns null
  const valid = encryptCredential('testPassword123');
  const parts = valid.split(':');
  const tamperedTag = `${parts[0]}:00000000000000000000000000000000:${parts[2]}`;
  assert.equal(decryptCredential(tamperedTag), null);

  const replacementByte = parts[2].startsWith('ff') ? '00' : 'ff';
  const tamperedData = `${parts[0]}:${parts[1]}:${replacementByte}${parts[2].slice(2)}`;
  assert.equal(decryptCredential(tamperedData), null);
});

test('getMachineKey generates deterministic machine-bound 32-byte key', () => {
  const key1 = getMachineKey();
  const key2 = getMachineKey();
  assert.equal(key1.length, 32);
  assert.deepEqual(key1, key2);
});

test('MoodleClient canAutoRelogin checks all necessary conditions', () => {
  const client = createTestClient();
  assert.equal(client.canAutoRelogin(), false);

  client.auth = { username: 'testuser' };
  assert.equal(client.canAutoRelogin(), false);

  client.auth = { username: 'testuser', secret: encryptCredential('secret123') };
  client.autoRelogin = true;
  assert.equal(client.canAutoRelogin(), true);

  client.autoRelogin = false;
  assert.equal(client.canAutoRelogin(), false);

  client.autoRelogin = true;
  client.auth.username = '';
  assert.equal(client.canAutoRelogin(), false);
});

test('MoodleClient saveCredentials encrypts password and sets 0600 file mode', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vsuee-auth-test-'));
  const sessionFile = path.join(tmpDir, 'session.json');

  try {
    const client = new MoodleClient({ sessionFile });
    await client.saveCredentials('student_test', 'Pass#12345');

    assert.equal(client.auth.username, 'student_test');
    assert.ok(client.auth.secret);
    assert.equal(decryptCredential(client.auth.secret), 'Pass#12345');
    assert.equal(client.autoRelogin, true);

    // Verify file content and permissions
    const raw = await fs.readFile(sessionFile, 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.auth.username, 'student_test');
    assert.equal(decryptCredential(parsed.auth.secret), 'Pass#12345');
    assert.equal(parsed.autoRelogin, true);

    const st = await fs.stat(sessionFile);
    if (process.platform !== 'win32') {
      assert.equal(st.mode & 0o777, 0o600);
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('MoodleClient autoLogin decrypts stored secret and performs login', async () => {
  const client = createTestClient();
  client.auth = {
    username: 'auto_user',
    secret: encryptCredential('correct_password'),
  };
  client.autoRelogin = true;

  let loginCalledWith = null;
  client.login = async (u, p, opts) => {
    loginCalledWith = { u, p, opts };
    client.sessionCookie = 'reauthenticated_cookie';
    client.sesskey = 'newsesskey123';
    client.user = { fullname: 'Auto User', id: '9999' };
    return { success: true, user: client.user, sesskey: client.sesskey };
  };

  const result = await client.autoLogin();
  assert.equal(result.success, true);
  assert.equal(loginCalledWith.u, 'auto_user');
  assert.equal(loginCalledWith.p, 'correct_password');
  assert.equal(loginCalledWith.opts.saveCredentials, false);
});

test('MoodleClient checkStatus auto-relogs when session is missing and credentials are saved', async () => {
  const client = createTestClient();
  client.sessionCookie = null;
  client.auth = {
    username: 'student_user',
    secret: encryptCredential('student_pass'),
  };
  client.autoRelogin = true;

  client.login = async () => {
    client.sessionCookie = 'fresh_session_cookie';
    client.sesskey = 'newkey';
    client.user = { fullname: 'Student User', id: '12345' };
    return { success: true, user: client.user, sesskey: client.sesskey };
  };

  const status = await client.checkStatus({ allowAutoRelogin: true });
  assert.equal(status.authenticated, true);
  assert.equal(status.autoRelogged, true);
  assert.equal(status.user.id, '12345');
});

test('MoodleClient checkStatus auto-relogs when server redirects to login', async () => {
  const client = createTestClient();
  client.sessionCookie = 'expired_cookie';
  client.auth = {
    username: 'student_user',
    secret: encryptCredential('student_pass'),
  };
  client.autoRelogin = true;

  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      if (url.includes('/my/')) {
        return {
          status: 303,
          ok: false,
          headers: new Headers({
            location: 'https://elearning.vsu.edu.ph/login/index.php',
          }),
        };
      }
      return { status: 200, ok: true, text: async () => '' };
    };

    client.login = async () => {
      client.sessionCookie = 'restored_cookie';
      client.sesskey = 'restored_sesskey';
      client.user = { fullname: 'Student Restored', id: '12345' };
      return { success: true, user: client.user, sesskey: client.sesskey };
    };

    const status = await client.checkStatus({ allowAutoRelogin: true });
    assert.equal(status.authenticated, true);
    assert.equal(status.autoRelogged, true);
    assert.equal(client.sessionCookie, 'restored_cookie');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('MoodleClient checkStatus auto-relogs when server returns HTTP 500 on corrupted session', async () => {
  const client = createTestClient();
  client.sessionCookie = 'corrupted_session_cookie';
  client.auth = {
    username: 'student_user',
    secret: encryptCredential('student_pass'),
  };
  client.autoRelogin = true;

  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      if (url.includes('/my/')) {
        return {
          status: 500,
          ok: false,
          headers: new Headers(),
          text: async () => 'Internal Server Error',
        };
      }
      return { status: 200, ok: true, text: async () => '' };
    };

    client.login = async () => {
      client.sessionCookie = 'recovered_500_cookie';
      client.sesskey = 'recovered_sesskey';
      client.user = { fullname: 'Student 500 Recovery', id: '12345' };
      return { success: true, user: client.user, sesskey: client.sesskey };
    };

    const status = await client.checkStatus({ allowAutoRelogin: true });
    assert.equal(status.authenticated, true);
    assert.equal(status.autoRelogged, true);
    assert.equal(client.sessionCookie, 'recovered_500_cookie');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('MoodleClient fetchWithAuth auto-relogs and retries on 302 or 200 login response', async () => {
  const client = createTestClient();
  client.sessionCookie = 'stale_session';
  client.auth = {
    username: 'student_user',
    secret: encryptCredential('student_pass'),
  };
  client.autoRelogin = true;

  let requestCount = 0;
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      requestCount++;
      if (requestCount === 1) {
        const loginHtml = '<html><body>You are not logged in. <a href="https://elearning.vsu.edu.ph/login/index.php">Login</a><input name="logintoken" value="123" /></body></html>';
        return {
          status: 200,
          ok: true,
          headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
          clone: () => ({
            text: async () => loginHtml,
          }),
          text: async () => loginHtml,
        };
      }
      return {
        status: 200,
        ok: true,
        headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
        clone: () => ({
          text: async () => '<html><body><h1>Course Content</h1></body></html>',
        }),
        text: async () => '<html><body><h1>Course Content</h1></body></html>',
      };
    };

    client.login = async () => {
      client.sessionCookie = 'newly_logged_in_cookie';
      client.sesskey = 'new_key';
      client.user = { fullname: 'Student', id: '12345' };
      return { success: true };
    };

    const res = await client.fetchWithAuth('https://elearning.vsu.edu.ph/course/view.php?id=1610');
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /Course Content/);
    assert.equal(requestCount, 2, 'Should have retried the request once after auto-login');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('MoodleClient fetchWithAuth updates sessionCookie on Set-Cookie header', async () => {
  const client = createTestClient();
  client.sessionCookie = 'old_cookie';

  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({
      status: 200,
      ok: true,
      headers: {
        getSetCookie: () => ['MoodleSession=updated_cookie_999; path=/; HttpOnly'],
        get: (h) => (h === 'content-type' ? 'text/plain' : null),
      },
    });

    await client.fetchWithAuth('https://elearning.vsu.edu.ph/my/');
    assert.equal(client.sessionCookie, 'updated_cookie_999');
  } finally {
    globalThis.fetch = origFetch;
  }
});
