import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { BrowserRunner } from '../lib/browser-runner.mjs';

test('BrowserRunner resolveTargetUrl resolves various shortcuts and full URLs', () => {
  const runner = new BrowserRunner({ baseUrl: 'https://elearning.vsu.edu.ph' });

  // Default / empty
  assert.equal(runner.resolveTargetUrl(''), 'https://elearning.vsu.edu.ph/my/');
  assert.equal(runner.resolveTargetUrl(null), 'https://elearning.vsu.edu.ph/my/');
  assert.equal(runner.resolveTargetUrl('my'), 'https://elearning.vsu.edu.ph/my/');
  assert.equal(runner.resolveTargetUrl('dashboard'), 'https://elearning.vsu.edu.ph/my/');

  // Full URLs
  assert.equal(
    runner.resolveTargetUrl('https://elearning.vsu.edu.ph/mod/quiz/view.php?id=123'),
    'https://elearning.vsu.edu.ph/mod/quiz/view.php?id=123'
  );

  // Relative paths
  assert.equal(
    runner.resolveTargetUrl('/calendar/view.php?view=upcoming'),
    'https://elearning.vsu.edu.ph/calendar/view.php?view=upcoming'
  );

  // Prefixed shortcuts
  assert.equal(runner.resolveTargetUrl('course 1610'), 'https://elearning.vsu.edu.ph/course/view.php?id=1610');
  assert.equal(runner.resolveTargetUrl('course/1610'), 'https://elearning.vsu.edu.ph/course/view.php?id=1610');
  assert.equal(runner.resolveTargetUrl('assign 248286'), 'https://elearning.vsu.edu.ph/mod/assign/view.php?id=248286');
  assert.equal(runner.resolveTargetUrl('quiz 262926'), 'https://elearning.vsu.edu.ph/mod/quiz/view.php?id=262926');
  assert.equal(runner.resolveTargetUrl('page 107176'), 'https://elearning.vsu.edu.ph/mod/page/view.php?id=107176');
  assert.equal(runner.resolveTargetUrl('forum 19518'), 'https://elearning.vsu.edu.ph/mod/forum/view.php?id=19518');

  // Forum discussion shortcut
  assert.equal(runner.resolveTargetUrl('discuss 19518'), 'https://elearning.vsu.edu.ph/mod/forum/discuss.php?d=19518');
  assert.equal(runner.resolveTargetUrl('discussion/19518'), 'https://elearning.vsu.edu.ph/mod/forum/discuss.php?d=19518');

  // Course section shortcut
  assert.equal(runner.resolveTargetUrl('course 1610', { section: 2 }), 'https://elearning.vsu.edu.ph/course/view.php?id=1610&section=2');

  // Pure numeric ID with type options
  assert.equal(runner.resolveTargetUrl('1610'), 'https://elearning.vsu.edu.ph/course/view.php?id=1610');
  assert.equal(runner.resolveTargetUrl('248286', { type: 'assign' }), 'https://elearning.vsu.edu.ph/mod/assign/view.php?id=248286');
  assert.equal(runner.resolveTargetUrl('262926', { type: 'quiz' }), 'https://elearning.vsu.edu.ph/mod/quiz/view.php?id=262926');
  assert.equal(runner.resolveTargetUrl('107176', { type: 'page' }), 'https://elearning.vsu.edu.ph/mod/page/view.php?id=107176');
  assert.equal(runner.resolveTargetUrl('19518', { type: 'discuss' }), 'https://elearning.vsu.edu.ph/mod/forum/discuss.php?d=19518');
});

test('BrowserRunner captureScreenshot takes screenshots with selector, section, or full page', async (t) => {
  const runner = new BrowserRunner();
  let hasPlaywright = false;
  try {
    const chromium = await runner.getPlaywright();
    hasPlaywright = existsSync(chromium.executablePath());
  } catch {
    hasPlaywright = false;
  }

  if (!hasPlaywright) {
    t.skip('Playwright or its Chromium executable is unavailable; skipping browser screenshot test');
    return;
  }

  const tmpOut = path.join(os.tmpdir(), `test_pw_shot_${Date.now()}.png`);

  try {
    const htmlContent = `
      <html>
        <head><style>body { margin: 0; background: #f0f0f0; } .box { width: 300px; height: 200px; background: #007bff; color: white; padding: 20px; }</style></head>
        <body>
          <div id="target-box" class="box">VSUEE Unit Test Box</div>
          <div id="section-1" class="box">Section 1 Content</div>
        </body>
      </html>
    `;
    const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}`;

    // Full page screenshot
    const resFull = await runner.captureScreenshot(dataUrl, tmpOut, { fullPage: true });
    assert.equal(resFull.isElement, false);
    assert.equal(resFull.fullPage, true);
    assert.ok(resFull.size > 0);

    // Element screenshot using CSS selector
    const resElem = await runner.captureScreenshot(dataUrl, tmpOut, { selector: '#target-box' });
    assert.equal(resElem.isElement, true);
    assert.equal(resElem.selector, '#target-box');
    assert.ok(resElem.size > 0);

    // Section screenshot using section option
    const resSec = await runner.captureScreenshot(dataUrl, tmpOut, { section: 1 });
    assert.equal(resSec.isElement, true);
    assert.equal(resSec.selector, '#section-1');
    assert.ok(resSec.size > 0);

    // Nonexistent selector should fail with clear, descriptive error
    await assert.rejects(
      async () => {
        await runner.captureScreenshot(dataUrl, tmpOut, { selector: '#nonexistent-id', selectorTimeout: 500 });
      },
      /Element matching selector "#nonexistent-id" was not found/
    );
  } finally {
    try { await fs.unlink(tmpOut); } catch {}
  }
});

// Offline lifecycle doubles: no Playwright process, portal, or real session is used.
function interactiveSessionFixture(failAt, { closeFails = false, sessionCookie = null } = {}) {
  const setupError = new Error(`synthetic ${failAt} failure`);
  let closeCount = 0;
  const calls = [];
  const step = async (name, result) => {
    calls.push(name);
    if (failAt === name) throw setupError;
    return result;
  };
  const page = { goto: async (...args) => step('goto', args) };
  const context = {
    addCookies: async () => step('addCookies'),
    newPage: async () => step('newPage', page),
  };
  const browser = {
    newContext: async () => step('newContext', context),
    close: async () => {
      closeCount++;
      if (closeFails) throw new Error('synthetic cleanup failure');
    },
  };
  const runner = new BrowserRunner({ sessionCookie });
  runner.getPlaywright = async () => ({ launch: async () => step('launch', browser) });
  return { runner, browser, context, page, setupError, calls, closeCount: () => closeCount };
}

for (const stage of ['newContext', 'addCookies', 'newPage', 'goto']) {
  test(`openInteractiveSession closes browser after ${stage} failure`, async () => {
    const fixture = interactiveSessionFixture(stage, { sessionCookie: 'synthetic-test-cookie' });
    await assert.rejects(fixture.runner.openInteractiveSession(), (err) => err === fixture.setupError);
    assert.equal(fixture.closeCount(), 1);
    assert.equal(fixture.calls.at(-1), stage, 'setup must stop at the failing stage');
  });
}

test('openInteractiveSession preserves setup error when cleanup also fails', async () => {
  const fixture = interactiveSessionFixture('goto', { closeFails: true });
  await assert.rejects(fixture.runner.openInteractiveSession(), (err) => err === fixture.setupError);
  assert.equal(fixture.closeCount(), 1);
});

test('openInteractiveSession leaves successful browser open for its caller', async () => {
  const fixture = interactiveSessionFixture(null);
  assert.deepEqual(await fixture.runner.openInteractiveSession(), {
    browser: fixture.browser, context: fixture.context, page: fixture.page,
  });
  assert.equal(fixture.closeCount(), 0);
  assert.deepEqual(fixture.calls, ['launch', 'newContext', 'newPage', 'goto']);
  await fixture.browser.close();
  assert.equal(fixture.closeCount(), 1);
});

test('openInteractiveSession preserves launch failure without closing a nonexistent browser', async () => {
  const fixture = interactiveSessionFixture('launch');
  await assert.rejects(fixture.runner.openInteractiveSession(), (err) => err === fixture.setupError);
  assert.equal(fixture.closeCount(), 0);
});
