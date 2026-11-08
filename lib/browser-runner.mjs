import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { createRequire } from 'node:module';

import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class BrowserRunner {
  constructor(options = {}) {
    this.sessionCookie = options.sessionCookie || null;
    this.baseUrl = options.baseUrl || 'https://elearning.vsu.edu.ph';
  }

  async getPlaywright() {
    const searchPaths = [
      'playwright',
      path.resolve(__dirname, '..', 'node_modules', 'playwright'),
      '/opt/homebrew/lib/node_modules/playwright',
      '/usr/local/lib/node_modules/playwright',
    ];

    for (const p of searchPaths) {
      try {
        const pw = require(p);
        if (pw && pw.chromium) return pw.chromium;
      } catch {
        // continue
      }
    }

    try {
      const cwdRequire = createRequire(path.join(process.cwd(), 'package.json'));
      const pw = cwdRequire('playwright');
      if (pw && pw.chromium) return pw.chromium;
    } catch {
      // continue
    }

    throw new Error('Playwright is required for browser mode. Run "npm install playwright" or install it in your environment.');
  }

  /**
   * Resolve various target shortcuts to full Moodle portal URLs
   */
  resolveTargetUrl(target, options = {}) {
    if (!target) {
      if (options.course) {
        const sec = options.section !== undefined && options.section !== null ? `&section=${options.section}` : '';
        return `${this.baseUrl}/course/view.php?id=${options.course}${sec}`;
      }
      if (options.assign) return `${this.baseUrl}/mod/assign/view.php?id=${options.assign}`;
      if (options.quiz) return `${this.baseUrl}/mod/quiz/view.php?id=${options.quiz}`;
      if (options.page) return `${this.baseUrl}/mod/page/view.php?id=${options.page}`;
      if (options.forum) return `${this.baseUrl}/mod/forum/view.php?id=${options.forum}`;
      if (options.discuss) return `${this.baseUrl}/mod/forum/discuss.php?d=${options.discuss}`;
      return `${this.baseUrl}/my/`;
    }

    const t = String(target).trim();
    if (t.startsWith('http://') || t.startsWith('https://') || t.startsWith('data:') || t.startsWith('file://')) {
      return t;
    }
    if (t.startsWith('/')) {
      return `${this.baseUrl}${t}`;
    }
    if (t === 'my' || t === 'dashboard') {
      return `${this.baseUrl}/my/`;
    }

    // Pattern matches: "course 1610", "course:1610", "c/1610", "c:1610"
    const courseMatch = t.match(/^(?:course|c)[:\/\s]+(\d+)$/i);
    if (courseMatch) {
      const sec = options.section !== undefined && options.section !== null ? `&section=${options.section}` : '';
      return `${this.baseUrl}/course/view.php?id=${courseMatch[1]}${sec}`;
    }

    const assignMatch = t.match(/^(?:assign|assignment|a)[:\/\s]+(\d+)$/i);
    if (assignMatch) return `${this.baseUrl}/mod/assign/view.php?id=${assignMatch[1]}`;

    const quizMatch = t.match(/^(?:quiz|q)[:\/\s]+(\d+)$/i);
    if (quizMatch) return `${this.baseUrl}/mod/quiz/view.php?id=${quizMatch[1]}`;

    const pageMatch = t.match(/^(?:page|p)[:\/\s]+(\d+)$/i);
    if (pageMatch) return `${this.baseUrl}/mod/page/view.php?id=${pageMatch[1]}`;

    const forumMatch = t.match(/^(?:forum|f)[:\/\s]+(\d+)$/i);
    if (forumMatch) return `${this.baseUrl}/mod/forum/view.php?id=${forumMatch[1]}`;

    const discussMatch = t.match(/^(?:discuss|discussion|d)[:\/\s]+(\d+)$/i);
    if (discussMatch) return `${this.baseUrl}/mod/forum/discuss.php?d=${discussMatch[1]}`;

    // Pure numeric ID: check type hints or default to course view
    if (/^\d+$/.test(t)) {
      if (options.type === 'assign' || options.assign) return `${this.baseUrl}/mod/assign/view.php?id=${t}`;
      if (options.type === 'quiz' || options.quiz) return `${this.baseUrl}/mod/quiz/view.php?id=${t}`;
      if (options.type === 'page' || options.page) return `${this.baseUrl}/mod/page/view.php?id=${t}`;
      if (options.type === 'forum' || options.forum) return `${this.baseUrl}/mod/forum/view.php?id=${t}`;
      if (options.type === 'discuss' || options.discuss) return `${this.baseUrl}/mod/forum/discuss.php?d=${t}`;
      const sec = options.section !== undefined && options.section !== null ? `&section=${options.section}` : '';
      return `${this.baseUrl}/course/view.php?id=${t}${sec}`;
    }

    return `${this.baseUrl}/${t}`;
  }

  async openInteractiveSession({ url = null, headed = true } = {}) {
    const chromium = await this.getPlaywright();
    const targetUrl = this.resolveTargetUrl(url);

    const browser = await chromium.launch({
      headless: !headed,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    try {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      });

      if (this.sessionCookie) {
        await context.addCookies([
          {
            name: 'MoodleSession',
            value: this.sessionCookie,
            domain: 'elearning.vsu.edu.ph',
            path: '/',
            httpOnly: false,
            secure: true,
            sameSite: 'Lax',
          },
        ]);
      }

      const page = await context.newPage();
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });

      return { browser, context, page };
    } catch (error) {
      // Setup never handed the browser to the caller, so release it here.
      // Preserve the original setup failure if closing also fails.
      try { await browser.close(); } catch {}
      throw error;
    }
  }

  /**
   * Helper to perform browser login interactively and capture the session cookie
   */
  async interactiveLogin() {
    const chromium = await this.getPlaywright();
    const browser = await chromium.launch({
      headless: false,
      args: ['--no-sandbox'],
    });

    const context = await browser.newContext({
      viewport: { width: 1100, height: 750 },
    });
    const page = await context.newPage();
    await page.goto(`${this.baseUrl}/login/index.php`);

    console.log('\n[VSUEE Browser Login]');
    console.log('An interactive browser window has been opened.');
    console.log('Please complete your login in the browser window.');
    console.log('The tool will automatically detect your successful login and save your session...\n');

    let capturedCookie = null;

    // Wait up to 5 minutes for user to login
    const startTime = Date.now();
    while (Date.now() - startTime < 300000) {
      try {
        const url = page.url();
        const cookies = await context.cookies();
        const mCookie = cookies.find(c => c.name === 'MoodleSession');

        // If URL moved to /my/ or home, or if MoodleSession cookie exists and page is not login error
        if (url.includes('/my/') || (!url.includes('/login/') && mCookie)) {
          capturedCookie = mCookie ? mCookie.value : null;
          break;
        }

        // Also check if page has user menu / logged in indicators
        const isLoggedIn = await page.evaluate(() => {
          return Boolean(document.querySelector('.usermenu .usertext') || document.querySelector('#action-menu-toggle-1'));
        }).catch(() => false);

        if (isLoggedIn && mCookie) {
          capturedCookie = mCookie.value;
          break;
        }
      } catch (err) {
        // If user closed the browser window manually, break and check whatever cookies we have
        if (err.message && err.message.includes('Target page, context or browser has been closed')) {
          break;
        }
      }

      await new Promise(r => setTimeout(r, 1000));
    }

    try {
      await browser.close();
    } catch {
      // ignore
    }

    if (!capturedCookie) {
      throw new Error('Login was not completed or no active session cookie was captured before the window closed.');
    }

    return capturedCookie;
  }

  /**
   * Capture a full page or specific element screenshot
   * Supports CSS selector, custom viewport dimensions, and target shortcuts
   */
  async captureScreenshot(targetUrlOrShortcut, outputPath, options = {}) {
    const finalUrl = this.resolveTargetUrl(targetUrlOrShortcut, options);
    const resolvedOut = path.resolve(process.cwd(), outputPath);
    const outDir = path.dirname(resolvedOut);
    if (!fsSync.existsSync(outDir)) {
      await fs.mkdir(outDir, { recursive: true });
    }

    const chromium = await this.getPlaywright();
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    try {
      const width = options.width ? parseInt(options.width, 10) : 1440;
      const height = options.height ? parseInt(options.height, 10) : 900;

      const context = await browser.newContext({
        viewport: { width, height },
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      });

      if (this.sessionCookie) {
        await context.addCookies([
          {
            name: 'MoodleSession',
            value: this.sessionCookie,
            domain: 'elearning.vsu.edu.ph',
            path: '/',
            httpOnly: false,
            secure: true,
            sameSite: 'Lax',
          },
        ]);
      }

      const page = await context.newPage();
      const navTimeout = options.timeout || 30000;

      await page.goto(finalUrl, { waitUntil: 'domcontentloaded', timeout: navTimeout });
      try {
        await page.waitForLoadState('networkidle', { timeout: 3000 });
      } catch {
        // networkidle is best effort, domcontentloaded already succeeded
      }

      let isElement = false;
      let selectorUsed = null;

      let effectiveSelector = options.selector ? options.selector.trim() : null;
      if (!effectiveSelector && options.section !== undefined && options.section !== null) {
        effectiveSelector = `#section-${options.section}`;
      }

      if (effectiveSelector) {
        selectorUsed = effectiveSelector;
        const locator = page.locator(effectiveSelector).first();
        const selTimeout = options.selectorTimeout || (options.timeout ? Math.min(options.timeout, 10000) : 10000);
        try {
          await locator.waitFor({ state: 'visible', timeout: selTimeout });
          await locator.screenshot({ path: resolvedOut });
          isElement = true;
        } catch (selectorErr) {
          const count = await page.locator(effectiveSelector).count().catch(() => 0);
          if (count > 0) {
            try {
              await locator.scrollIntoViewIfNeeded({ timeout: 2000 });
              await locator.screenshot({ path: resolvedOut, timeout: 3000 });
              isElement = true;
            } catch {
              throw new Error(`Element matching selector "${effectiveSelector}" is present in DOM (${count} found) but not visible/renderable on ${finalUrl} within ${selTimeout}ms: ${selectorErr.message}`);
            }
          } else {
            throw new Error(`Element matching selector "${effectiveSelector}" was not found on ${finalUrl} within ${selTimeout}ms: ${selectorErr.message}`);
          }
        }
      } else {
        const fullPage = options.fullPage !== false;
        await page.screenshot({ path: resolvedOut, fullPage });
      }

      const fileStat = await fs.stat(resolvedOut);

      return {
        url: finalUrl,
        outputPath: resolvedOut,
        size: fileStat.size,
        isElement,
        selector: selectorUsed,
        fullPage: !isElement && (options.fullPage !== false),
      };
    } finally {
      await browser.close();
    }
  }
}

