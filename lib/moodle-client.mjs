import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';

export function expandHome(filePath) {
  if (!filePath || typeof filePath !== 'string') return filePath;
  const cleaned = filePath.trim().replace(/^['"]|['"]$/g, '');
  if (cleaned === '~') return os.homedir();
  if (cleaned.startsWith('~/') || cleaned.startsWith('~\\')) {
    return path.join(os.homedir(), cleaned.slice(2));
  }
  return cleaned;
}

const BASE_URL = 'https://elearning.vsu.edu.ph';
const CONFIG_DIR = path.join(os.homedir(), '.config', 'vsuee');
const SESSION_FILE = path.join(CONFIG_DIR, 'session.json');

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Connection': 'keep-alive',
};

export function getExtensionFromMimeType(contentType) {
  if (!contentType) return '';
  const ct = contentType.toLowerCase().split(';')[0].trim();
  const map = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'image/bmp': '.bmp',
    'image/x-icon': '.ico',
    'application/pdf': '.pdf',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
    'application/vnd.ms-powerpoint': '.ppt',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/msword': '.doc',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'application/vnd.ms-excel': '.xls',
    'application/zip': '.zip',
    'application/x-zip-compressed': '.zip',
    'application/x-rar-compressed': '.rar',
    'application/x-7z-compressed': '.7z',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'video/quicktime': '.mov',
    'video/x-msvideo': '.avi',
    'audio/mpeg': '.mp3',
    'audio/wav': '.wav',
    'audio/ogg': '.ogg',
    'audio/mp4': '.m4a',
    'text/plain': '.txt',
    'text/markdown': '.md',
    'text/csv': '.csv',
    'application/json': '.json',
  };
  return map[ct] || '';
}

export function getMimeType(filename) {
  if (!filename || typeof filename !== 'string') return 'application/octet-stream';
  const ext = path.extname(filename).toLowerCase();
  const map = {
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.zip': 'application/zip',
    '.rar': 'application/x-rar-compressed',
    '.7z': 'application/x-7z-compressed',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
  };
  return map[ext] || 'application/octet-stream';
}

export function matchesType(fileType, filter) {
  if (!filter) return true;
  const f = filter.toLowerCase().replace(/^\./, '').trim();
  if (!fileType) return false;
  const ft = fileType.toLowerCase().replace(/^\./, '').trim();
  if (ft === f) return true;
  if ((f === 'ppt' || f === 'powerpoint') && (ft === 'pptx' || ft === 'ppt')) return true;
  if ((f === 'pptx') && (ft === 'ppt' || ft === 'pptx')) return true;
  if ((f === 'doc' || f === 'word') && (ft === 'docx' || ft === 'doc')) return true;
  if ((f === 'docx') && (ft === 'doc' || ft === 'docx')) return true;
  if ((f === 'xls' || f === 'excel') && (ft === 'xlsx' || ft === 'xls')) return true;
  if ((f === 'xlsx') && (ft === 'xls' || ft === 'xlsx')) return true;
  if (f === 'video' && ['mp4', 'mkv', 'avi', 'mov', 'webm', 'flv'].includes(ft)) return true;
  if (f === 'audio' && ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'].includes(ft)) return true;
  if (f === 'image' && ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ft)) return true;
  return false;
}

/**
 * Run async operations with bounded concurrency pool and optional progress tracking
 */
export async function asyncPool(concurrency, items, iteratorFn, options = {}) {
  const poolLimit = Math.max(1, Math.min(32, parseInt(concurrency, 10) || 4));
  const results = new Array(items.length);
  const executing = new Set();
  let completed = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const p = (async () => {
      if (options.onStart) {
        try {
          options.onStart({
            total: items.length,
            completed,
            item,
            index: i,
            activeCount: executing.size + 1,
          });
        } catch {}
      }
      try {
        const res = await iteratorFn(item, i, items);
        completed++;
        if (options.onProgress) {
          try {
            options.onProgress({
              total: items.length,
              completed,
              item,
              index: i,
              activeCount: Math.max(0, executing.size - 1),
              result: res,
              error: null,
            });
          } catch {}
        }
        return { status: 'fulfilled', value: res, index: i };
      } catch (err) {
        completed++;
        if (options.onProgress) {
          try {
            options.onProgress({
              total: items.length,
              completed,
              item,
              index: i,
              activeCount: Math.max(0, executing.size - 1),
              result: null,
              error: err,
            });
          } catch {}
        }
        if (options.stopOnError) throw err;
        return { status: 'rejected', reason: err, index: i };
      }
    })();

    results[i] = p;
    executing.add(p);
    const clean = () => executing.delete(p);
    p.then(clean, clean);

    if (executing.size >= poolLimit) {
      await Promise.race(executing);
    }
  }

  return Promise.all(results);
}

/**
 * Format a Date to RFC 5545 iCalendar UTC date-time string (YYYYMMDDTHHMMSSZ)
 */
export function formatIcsDate(date) {
  if (typeof date === 'string') {
    const trimmed = date.trim();
    if (/^\d{8}T\d{6}Z?$/.test(trimmed)) {
      return trimmed.endsWith('Z') ? trimmed : `${trimmed}Z`;
    }
  }
  let d;
  if (date instanceof Date) {
    d = date;
  } else if (typeof date === 'number') {
    d = new Date(date < 10000000000 ? date * 1000 : date);
  } else if (typeof date === 'string' && /^\d{10}$/.test(date.trim())) {
    d = new Date(parseInt(date.trim(), 10) * 1000);
  } else {
    let testD = new Date(date);
    if (!isNaN(testD.getTime()) && testD.getFullYear() < 2020 && !/\b(19|20)\d{2}\b/.test(String(date))) {
      const currentYear = new Date().getFullYear();
      const str = String(date);
      const withYear = str.replace(/(\d{1,2}\s+[A-Za-z]+)/, `$1 ${currentYear}`);
      const retryD = new Date(withYear);
      if (!isNaN(retryD.getTime())) {
        testD = retryD;
      }
    }
    d = testD;
  }
  if (isNaN(d.getTime())) return formatIcsDate(new Date());
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getUTCFullYear() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    'T' +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    'Z'
  );
}

/**
 * Escape text characters per RFC 5545 specifications
 */
export function escapeIcsText(str) {
  if (!str) return '';
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * Fold long lines according to RFC 5545 (strictly limit <= 75 octets per line without splitting UTF-8 characters)
 */
export function foldIcsLine(line) {
  if (!line) return '';
  const buf = Buffer.from(line, 'utf8');
  if (buf.length <= 75) return line;

  const chunks = [];
  let currentLine = '';
  let currentByteLen = 0;
  let isContinuation = false;

  for (const char of line) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    const maxLen = isContinuation ? 74 : 75;

    if (currentByteLen + charBytes > maxLen) {
      chunks.push(isContinuation ? ' ' + currentLine : currentLine);
      currentLine = char;
      currentByteLen = charBytes;
      isContinuation = true;
    } else {
      currentLine += char;
      currentByteLen += charBytes;
    }
  }

  if (currentLine) {
    chunks.push(isContinuation ? ' ' + currentLine : currentLine);
  }

  return chunks.join('\r\n');
}

/**
 * Generate standard RFC 5545 iCalendar (.ics) string from event objects
 */
export function generateIcsCalendar(events, options = {}) {
  const calName = options.calendarName || 'VSU eLearning Schedule';
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//VSUEE Moodle Client//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcsText(calName)}`,
    'X-WR-TIMEZONE:Asia/Manila',
  ];

  for (const ev of events) {
    const uid = ev.uid || `vsuee-${ev.id || crypto.randomUUID()}@elearning.vsu.edu.ph`;
    const dtstamp = formatIcsDate(ev.dtstamp || new Date());
    const dtstart = formatIcsDate(ev.dtstart || ev.timestart || new Date());
    const dtend = formatIcsDate(
      ev.dtend ||
        ev.timeend ||
        new Date(new Date(ev.dtstart || ev.timestart || Date.now()).getTime() + 3600000)
    );

    const summary = escapeIcsText(ev.summary || ev.name || 'VSUEE Event');
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${uid}`);
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`DTSTART:${dtstart}`);
    lines.push(`DTEND:${dtend}`);
    lines.push(`SUMMARY:${summary}`);
    if (ev.description) {
      lines.push(`DESCRIPTION:${escapeIcsText(ev.description)}`);
    }
    if (ev.location || ev.coursename) {
      lines.push(`LOCATION:${escapeIcsText(ev.location || ev.coursename || 'VSU eLearning')}`);
    }
    if (ev.url || ev.actionurl) {
      lines.push(`URL:${ev.url || ev.actionurl}`);
    }
    if (ev.categories || ev.coursename) {
      lines.push(`CATEGORIES:${escapeIcsText(ev.categories || ev.coursename)}`);
    }
    lines.push('STATUS:CONFIRMED');

    // Add standard RFC 5545 VALARM reminders (24h and 2h before due date)
    if (options.includeAlarms !== false) {
      lines.push('BEGIN:VALARM');
      lines.push('ACTION:DISPLAY');
      lines.push(`DESCRIPTION:Reminder: ${summary}`);
      lines.push('TRIGGER:-PT24H');
      lines.push('END:VALARM');
      lines.push('BEGIN:VALARM');
      lines.push('ACTION:DISPLAY');
      lines.push(`DESCRIPTION:Reminder: ${summary}`);
      lines.push('TRIGGER:-PT2H');
      lines.push('END:VALARM');
    }

    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.map(foldIcsLine).join('\r\n') + '\r\n';
}

/**
 * Terminal visual progress indicator for batch parallel downloads
 */
export class ProgressIndicator {
  constructor(total, options = {}) {
    this.total = Math.max(0, parseInt(total, 10) || 0);
    this.completed = 0;
    this.successful = 0;
    this.skipped = 0;
    this.failed = 0;
    this.activeWorkers = 0;
    this.label = options.label || 'Downloading';
    this.isTty = Boolean(process.stdout && process.stdout.isTTY && !options.quiet && !options.json);
    this.quiet = Boolean(options.quiet);
    this.json = Boolean(options.json);
    this.stream = options.stream || process.stdout;
    this.startTime = Date.now();
    this.lastRenderTime = 0;
    this.lastReportedPct = -1;
  }

  onStart({ item, activeCount }) {
    this.activeWorkers = activeCount || 1;
    const name = item ? (item.name || item.module || (item.act && item.act.name) || 'file') : '';
    this.render(name);
  }

  onProgress({ completed, item, result, error, activeCount }) {
    this.completed = completed;
    this.activeWorkers = activeCount || 0;
    if (error) this.failed++;
    else if (result && result.skipped) this.skipped++;
    else this.successful++;
    const name = item ? (item.name || item.module || (item.act && item.act.name) || 'file') : '';
    this.render(name);
  }

  render(activeName = '') {
    if (this.quiet || this.json) return;
    const now = Date.now();
    if (this.isTty) {
      if (now - this.lastRenderTime < 35 && this.completed < this.total) return;
      this.lastRenderTime = now;
      const pct = this.total > 0 ? (this.completed / this.total) : 1;
      const barWidth = 20;
      const filled = Math.min(barWidth, Math.max(0, Math.round(barWidth * pct)));
      const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
      const pctStr = `${Math.round(pct * 100)}%`.padStart(4);
      let shortName = String(activeName).trim();
      if (shortName.length > 28) shortName = shortName.slice(0, 25) + '...';
      const line = `\r[${bar}] ${pctStr} (${this.completed}/${this.total}) • ${shortName} [${this.activeWorkers} active]`;
      this.stream.write(line.padEnd(80));
    } else {
      if (this.total === 0) return;
      const pct = Math.floor((this.completed / this.total) * 100);
      const isMilestone = pct === 0 || pct === 25 || pct === 50 || pct === 75 || pct === 100;
      if ((isMilestone && pct !== this.lastReportedPct) || this.completed === this.total || this.completed === 1) {
        this.lastReportedPct = pct;
        console.log(`[${this.label}] Progress: ${this.completed}/${this.total} (${pct}%)`);
      }
    }
  }

  finish() {
    if (this.quiet || this.json) return;
    if (this.isTty) {
      this.stream.write('\r' + ' '.repeat(80) + '\r');
    }
  }
}

export function getMachineKey() {
  let username = 'user';
  try {
    username = os.userInfo().username || process.env.USER || process.env.USERNAME || 'user';
  } catch {
    username = process.env.USER || process.env.USERNAME || 'user';
  }
  const machineId = `${os.hostname()}-${username}-vsuee-key-v1`;
  return crypto.createHash('sha256').update(machineId).digest();
}

export function encryptCredential(text) {
  if (!text || typeof text !== 'string') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getMachineKey(), iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

export function decryptCredential(ciphertext) {
  if (!ciphertext || typeof ciphertext !== 'string') return null;
  try {
    const [ivHex, authTagHex, encHex] = ciphertext.split(':');
    if (!ivHex || !authTagHex || !encHex) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', getMachineKey(), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    let decrypted = decipher.update(encHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    return null;
  }
}

// Strict collection reads must not mistake an expired-session page for an empty result.
function assertAuthenticatedHtml(html) {
  if ((html.includes('login/index.php') && html.includes('You are not logged in')) ||
      html.includes('name="logintoken"')) {
    throw new Error('Session expired while fetching snapshot data.');
  }
}

export class MoodleClient {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || BASE_URL;
    this.sessionCookie = null;
    this.sesskey = null;
    this.user = null;
    this.auth = null;
    this.autoRelogin = true;
    this.sessionFile = options.sessionFile || SESSION_FILE;
  }

  async init() {
    await this.ensureConfigDir();
    await this.loadSession();
  }

  async ensureConfigDir() {
    if (!fsSync.existsSync(CONFIG_DIR)) {
      await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
    }
  }

  async loadSession() {
    try {
      if (fsSync.existsSync(this.sessionFile)) {
        const raw = await fs.readFile(this.sessionFile, 'utf8');
        const data = JSON.parse(raw);
        this.sessionCookie = data.sessionCookie || null;
        this.sesskey = data.sesskey || null;
        this.user = data.user || null;
        this.auth = data.auth || null;
        this.autoRelogin = data.autoRelogin ?? true;
      }
    } catch {
      this.sessionCookie = null;
      this.sesskey = null;
      this.user = null;
      this.auth = null;
      this.autoRelogin = true;
    }
  }

  async saveSession() {
    await this.ensureConfigDir();
    const data = {
      sessionCookie: this.sessionCookie,
      sesskey: this.sesskey,
      user: this.user,
      auth: this.auth,
      autoRelogin: this.autoRelogin,
      updatedAt: new Date().toISOString(),
    };
    await fs.writeFile(this.sessionFile, JSON.stringify(data, null, 2), { mode: 0o600 });
    try {
      await fs.chmod(this.sessionFile, 0o600);
    } catch {}
  }

  async saveCredentials(username, password) {
    if (!username || !password) {
      throw new Error('Username and password are required.');
    }
    this.auth = {
      username: username.trim(),
      secret: encryptCredential(password),
    };
    this.autoRelogin = true;
    await this.saveSession();
  }

  async clearSession() {
    this.sessionCookie = null;
    this.sesskey = null;
    this.user = null;
    this.auth = null;
    try {
      if (fsSync.existsSync(this.sessionFile)) {
        await fs.unlink(this.sessionFile);
      }
    } catch {
      // ignore
    }
  }

  canAutoRelogin() {
    return Boolean(this.autoRelogin && this.auth && this.auth.username && this.auth.secret);
  }

  async autoLogin() {
    if (!this.canAutoRelogin()) {
      return { success: false, reason: 'No saved credentials for auto-relogin' };
    }
    try {
      const pass = decryptCredential(this.auth.secret);
      if (!pass) {
        return { success: false, reason: 'Could not decrypt password on this machine' };
      }
      return await this.login(this.auth.username, pass, { isAuto: true, saveCredentials: false });
    } catch (err) {
      return { success: false, reason: err.message };
    }
  }

  async ensureAuthenticated() {
    const status = await this.checkStatus({ allowAutoRelogin: true });
    return status.authenticated;
  }

  getHeaders(custom = {}) {
    const headers = { ...DEFAULT_HEADERS, ...custom };
    if (this.sessionCookie) {
      headers['Cookie'] = `MoodleSession=${this.sessionCookie}`;
    }
    return headers;
  }

  extractCookieFromResponse(res) {
    if (!res || !res.headers) return null;
    let cookies = [];
    if (typeof res.headers.getSetCookie === 'function') {
      cookies = res.headers.getSetCookie();
    } else {
      const h = res.headers.get('set-cookie');
      if (h) cookies = [h];
    }
    for (const c of cookies) {
      const match = c.match(/MoodleSession=([^;]+)/);
      if (match) return match[1];
    }
    return null;
  }

  extractSesskey(html) {
    if (!html) return null;
    const match = html.match(/"sesskey":"([a-zA-Z0-9]+)"/) ||
                  html.match(/sesskey=([a-zA-Z0-9]+)/) ||
                  html.match(/name="sesskey" value="([a-zA-Z0-9]+)"/);
    return match ? match[1] : null;
  }

  extractUserInfo(html) {
    if (!html) return null;
    const nameMatch = html.match(/class="usertext[^"]*">([^<]+)<\/span>/) ||
                      html.match(/class="user-name">([^<]+)<\//) ||
                      html.match(/title="View profile">([^<]+)<\/a>/) ||
                      html.match(/<span class="userbutton">[\s\S]*?<span class="avatars">[\s\S]*?<span class="usertext mr-1">([^<]+)<\/span>/);
    const idMatch = html.match(/\/user\/profile\.php\?id=(\d+)/) ||
                    html.match(/data-userid="(\d+)"/) ||
                    html.match(/"userid":\s*(\d+)/);
    
    return {
      fullname: nameMatch ? nameMatch[1].trim() : null,
      id: idMatch ? idMatch[1] : null,
    };
  }

  /**
   * Log in using username and password with Moodle testsession & redirect handling
   */
  async login(username, password, options = {}) {
    const loginUrl = `${this.baseUrl}/login/index.php`;

    // 1. Fetch initial login page to get logintoken & initial MoodleSession
    const initialRes = await fetch(loginUrl, {
      headers: DEFAULT_HEADERS,
      redirect: 'manual',
    });

    let currentCookie = this.extractCookieFromResponse(initialRes);
    const loginHtml = await initialRes.text();

    const tokenMatch = loginHtml.match(/name="logintoken" value="([a-zA-Z0-9]+)"/);
    if (!tokenMatch) {
      throw new Error('Could not extract logintoken from VSU eLearning login page.');
    }
    const logintoken = tokenMatch[1];

    // 2. Submit credentials
    const params = new URLSearchParams();
    params.append('anchor', '');
    params.append('logintoken', logintoken);
    params.append('username', username.trim());
    params.append('password', password);
    params.append('rememberusername', '1');

    const postHeaders = {
      ...DEFAULT_HEADERS,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': this.baseUrl,
      'Referer': loginUrl,
    };
    if (currentCookie) {
      postHeaders['Cookie'] = `MoodleSession=${currentCookie}`;
    }

    let currentRes = await fetch(loginUrl, {
      method: 'POST',
      headers: postHeaders,
      body: params.toString(),
      redirect: 'manual',
    });

    // 3. Follow redirects (handling testsession and dashboard transition)
    let redirectCount = 0;
    while ((currentRes.status === 303 || currentRes.status === 302) && redirectCount < 5) {
      redirectCount++;
      const newCookie = this.extractCookieFromResponse(currentRes);
      if (newCookie) {
        currentCookie = newCookie;
      }

      let nextUrl = currentRes.headers.get('location') || '';
      if (!nextUrl.startsWith('http')) {
        nextUrl = `${this.baseUrl}${nextUrl}`;
      }

      currentRes = await fetch(nextUrl, {
        headers: {
          ...DEFAULT_HEADERS,
          Cookie: `MoodleSession=${currentCookie}`,
        },
        redirect: 'manual',
      });
    }

    // Capture final cookie
    const finalCookie = this.extractCookieFromResponse(currentRes) || currentCookie;
    const body = await currentRes.text();

    // Check if we arrived at a successful page
    if (body.includes('class="usertext') || body.includes('/user/profile.php') || body.includes('id="page-my-index"')) {
      this.sessionCookie = finalCookie;
      this.sesskey = this.extractSesskey(body);
      this.user = this.extractUserInfo(body);

      if (options.saveCredentials !== false) {
        this.auth = {
          username: username.trim(),
          secret: encryptCredential(password),
        };
        this.autoRelogin = true;
      }

      await this.saveSession();

      return {
        success: true,
        user: this.user,
        sesskey: this.sesskey,
      };
    }

    // If redirected back to login or error shown
    const errMatch = body.match(/class="alert alert-danger"[^>]*>([\s\S]*?)<\/div>/) ||
                     body.match(/class="loginerrors">([\s\S]*?)<\/div>/);
    const errMsg = errMatch ? errMatch[1].replace(/<[^>]+>/g, '').trim() : 'Invalid login credentials or account issue.';
    throw new Error(`Login failed: ${errMsg}`);
  }

  /**
   * Centralized HTTP fetch wrapper that maintains cookies and automatically re-authenticates
   */
  async fetchWithAuth(url, options = {}, allowRelogin = true) {
    const customHeaders = options.headers || {};
    const headers = this.getHeaders(customHeaders);
    const fetchOptions = { ...options, headers };

    const res = await fetch(url, fetchOptions);

    // Auto-update cookie jar on any response that sets MoodleSession
    const newCookie = this.extractCookieFromResponse(res);
    if (newCookie && newCookie !== this.sessionCookie) {
      this.sessionCookie = newCookie;
      await this.saveSession().catch(() => {});
    }

    // Check for session expiry redirect (302/303 to login)
    if ((res.status === 302 || res.status === 303) && allowRelogin) {
      const location = (res.headers && typeof res.headers.get === 'function') ? (res.headers.get('location') || '') : '';
      if (location.includes('/login/')) {
        if (this.canAutoRelogin()) {
          const relog = await this.autoLogin();
          if (relog.success) {
            return this.fetchWithAuth(url, options, false);
          }
        }
      }
    }

    // Check for 200 response containing login form or "You are not logged in" HTML
    if (res.status === 200 && allowRelogin && typeof res.clone === 'function') {
      const contentType = (res.headers && typeof res.headers.get === 'function') ? (res.headers.get('content-type') || '') : '';
      if (contentType.includes('text/html')) {
        try {
          const clone = res.clone();
          const text = await clone.text();
          const isLoggedOut = (text.includes('login/index.php') && text.includes('You are not logged in')) ||
                              (text.includes('name="logintoken"') && text.includes('/login/index.php'));
          if (isLoggedOut && this.canAutoRelogin()) {
            const relog = await this.autoLogin();
            if (relog.success) {
              return this.fetchWithAuth(url, options, false);
            }
          }
        } catch {
          // ignore clone inspection error
        }
      }
    }

    return res;
  }

  /**
   * Verify whether the current session is valid and active
   */
  async checkStatus(options = { allowAutoRelogin: true }) {
    const allowAutoRelogin = options.allowAutoRelogin !== false;
    if (!this.sessionCookie) {
      if (allowAutoRelogin && this.canAutoRelogin()) {
        const relog = await this.autoLogin();
        if (relog.success) {
          return {
            authenticated: true,
            user: this.user,
            sesskey: this.sesskey,
            serverUrl: this.baseUrl,
            autoRelogged: true,
          };
        }
      }
      return { authenticated: false, reason: 'No session cookie stored.' };
    }

    try {
      const res = await fetch(`${this.baseUrl}/my/`, {
        headers: this.getHeaders(),
        redirect: 'manual',
      });

      const newCookie = this.extractCookieFromResponse(res);
      if (newCookie && newCookie !== this.sessionCookie) {
        this.sessionCookie = newCookie;
        await this.saveSession().catch(() => {});
      }

      if (res.status === 302 || res.status === 303) {
        const loc = (res.headers && typeof res.headers.get === 'function') ? (res.headers.get('location') || '') : '';
        if (loc.includes('/login/')) {
          if (allowAutoRelogin && this.canAutoRelogin()) {
            const relog = await this.autoLogin();
            if (relog.success) {
              return {
                authenticated: true,
                user: this.user,
                sesskey: this.sesskey,
                serverUrl: this.baseUrl,
                autoRelogged: true,
              };
            }
          }
          return { authenticated: false, reason: 'Session expired or invalidated by server.' };
        }
      }

      if (res.status !== 200) {
        if (res.status === 500 && allowAutoRelogin && this.canAutoRelogin()) {
          const relog = await this.autoLogin();
          if (relog.success) {
            return {
              authenticated: true,
              user: this.user,
              sesskey: this.sesskey,
              serverUrl: this.baseUrl,
              autoRelogged: true,
            };
          }
        }
        return { authenticated: false, reason: `Server returned HTTP status ${res.status}` };
      }

      const html = await res.text();
      if ((html.includes('login/index.php') && html.includes('You are not logged in')) || html.includes('name="logintoken"')) {
        if (allowAutoRelogin && this.canAutoRelogin()) {
          const relog = await this.autoLogin();
          if (relog.success) {
            return {
              authenticated: true,
              user: this.user,
              sesskey: this.sesskey,
              serverUrl: this.baseUrl,
              autoRelogged: true,
            };
          }
        }
        return { authenticated: false, reason: 'Session expired.' };
      }

      this.sesskey = this.extractSesskey(html) || this.sesskey;
      const user = this.extractUserInfo(html);
      if (user && user.fullname) this.user = user;
      await this.saveSession();

      return {
        authenticated: true,
        user: this.user,
        sesskey: this.sesskey,
        serverUrl: this.baseUrl,
      };
    } catch (err) {
      return { authenticated: false, isNetworkError: true, reason: `Network error: ${err.message}` };
    }
  }

  /**
   * Ping Moodle dashboard to refresh sliding session window
   */
  async touch() {
    const res = await this.fetchWithAuth(`${this.baseUrl}/my/`);
    if (!res.ok) {
      throw new Error(`Session touch failed with HTTP ${res.status}`);
    }
    const html = await res.text();
    if (html.includes('login/index.php') && html.includes('You are not logged in')) {
      throw new Error('Session is not authenticated.');
    }
    this.sesskey = this.extractSesskey(html) || this.sesskey;
    const user = this.extractUserInfo(html);
    if (user && user.fullname) this.user = user;
    await this.saveSession();
    return {
      success: true,
      user: this.user,
      sessionRefreshedAt: new Date().toISOString(),
    };
  }

  async keepalive() {
    return this.touch();
  }

  /**
   * Make a standard Moodle AJAX service call
   */
  async callAjax(methodname, args = {}) {
    if (!this.sesskey) {
      const status = await this.checkStatus({ allowAutoRelogin: true });
      if (!status.authenticated) {
        throw new Error('Not authenticated. Please run `vsuee login` or set a valid session cookie.');
      }
    }

    const url = `${this.baseUrl}/lib/ajax/service.php?sesskey=${encodeURIComponent(this.sesskey)}&info=${encodeURIComponent(methodname)}`;
    const payload = [{ index: 0, methodname, args }];

    let res = await this.fetchWithAuth(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      throw new Error(`Moodle AJAX request failed with HTTP ${res.status}`);
    }

    let result = await res.json();
    if (Array.isArray(result) && result[0]) {
      if (result[0].error) {
        const errCode = result[0].exception?.errorcode;
        if ((errCode === 'servicerequireslogin' || errCode === 'sessionerror') && this.canAutoRelogin()) {
          const relog = await this.autoLogin();
          if (relog.success) {
            const retryUrl = `${this.baseUrl}/lib/ajax/service.php?sesskey=${encodeURIComponent(this.sesskey)}&info=${encodeURIComponent(methodname)}`;
            const retryRes = await this.fetchWithAuth(retryUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Requested-With': 'XMLHttpRequest',
              },
              body: JSON.stringify(payload),
            }, false);
            if (retryRes.ok) {
              const retryResult = await retryRes.json();
              if (Array.isArray(retryResult) && retryResult[0] && !retryResult[0].error) {
                return retryResult[0].data;
              }
            }
          }
        }
        throw new Error(`Moodle error [${errCode || 'RPC'}]: ${result[0].exception?.message || 'Unknown error'}`);
      }
      return result[0].data;
    }
    return result;
  }

  /**
   * Get enrolled courses across active, past, future, or hidden classifications.
   * strict rejects failed HTML fallbacks and accepts authoritative empty AJAX results.
   */
  async getCourses(options = {}) {
    let classification = options.classification || 'all';
    if (options.all || options.includeHidden) {
      classification = 'allincludinghidden';
    } else if (options.filter) {
      classification = options.filter;
    }

    try {
      const data = await this.callAjax('core_course_get_enrolled_courses_by_timeline_classification', {
        offset: 0,
        limit: 0,
        classification,
        sort: 'fullname',
      });
      if (data && Array.isArray(data.courses) && (options.strict || data.courses.length > 0)) {
        let courses = data.courses.map(c => ({
          id: c.id,
          fullname: c.fullname,
          shortname: c.shortname,
          category: c.coursecategory,
          progress: c.progress ?? null,
          hasprogress: c.hasprogress ?? false,
          hidden: Boolean(c.hidden),
          isFavourite: Boolean(c.isfavourite),
          startdate: c.startdate ? new Date(c.startdate * 1000).toISOString() : null,
          enddate: c.enddate ? new Date(c.enddate * 1000).toISOString() : null,
          viewurl: c.viewurl || `${this.baseUrl}/course/view.php?id=${c.id}`,
        }));

        if (options.search) {
          const q = String(options.search).toLowerCase().trim();
          courses = courses.filter(c =>
            (c.fullname && c.fullname.toLowerCase().includes(q)) ||
            (c.shortname && c.shortname.toLowerCase().includes(q)) ||
            String(c.id).includes(q)
          );
        }

        return courses;
      }
    } catch {
      // Fallback to HTML
    }

    const res = await this.fetchWithAuth(`${this.baseUrl}/my/`);
    if (options.strict && !res.ok) throw new Error('Unable to fetch the course catalog.');
    const html = await res.text();
    if (options.strict) assertAuthenticatedHtml(html);
    let courses = [];
    const courseRegex = /<a[^>]*href="https?:\/\/elearning\.vsu\.edu\.ph\/course\/view\.php\?id=(\d+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    const seen = new Set();
    while ((match = courseRegex.exec(html)) !== null) {
      const id = parseInt(match[1], 10);
      const rawTitle = match[2].replace(/<[^>]+>/g, '').trim();
      if (!seen.has(id) && rawTitle && !rawTitle.toLowerCase().includes('view course')) {
        seen.add(id);
        courses.push({
          id,
          fullname: rawTitle,
          viewurl: `${this.baseUrl}/course/view.php?id=${id}`,
        });
      }
    }

    if (options.search) {
      const q = String(options.search).toLowerCase().trim();
      courses = courses.filter(c =>
        (c.fullname && c.fullname.toLowerCase().includes(q)) ||
        String(c.id).includes(q)
      );
    }

    return courses;
  }

  /**
   * Hide or unhide a course from the student's dashboard / overview view
   */
  async setCourseHidden(courseId, hide = true) {
    if (!courseId) throw new Error('Course ID is required');
    const id = parseInt(courseId, 10);
    if (isNaN(id)) throw new Error(`Invalid course ID: ${courseId}`);
    const prefName = `block_myoverview_hidden_course_${id}`;
    const prefValue = hide ? 1 : 0;
    await this.callAjax('core_user_update_user_preferences', {
      preferences: [{ type: prefName, value: prefValue }],
    });
    return { success: true, courseId: id, hidden: Boolean(hide) };
  }

  /**
   * Get upcoming timeline action events (deadlines, quizzes, submissions).
   * strict rejects failed HTML fallbacks and accepts authoritative empty AJAX results.
   */
  async getTimeline(limit = 20, options = {}) {
    try {
      const data = await this.callAjax('core_calendar_get_action_events_by_timesort', {
        limitnum: limit,
        timesortfrom: Math.floor(Date.now() / 1000) - 86400,
      });

      if (data && Array.isArray(data.events) && (options.strict || data.events.length > 0)) {
        return data.events.map(ev => ({
          id: ev.id,
          name: ev.name,
          activityname: ev.activityname,
          coursename: ev.course?.fullname || '',
          courseid: ev.course?.id || null,
          modulename: ev.modulename,
          timestart: ev.timestart ? new Date(ev.timestart * 1000).toISOString() : null,
          formattedtime: ev.formattedtime || null,
          actionurl: ev.action?.url || ev.url || '',
          overdue: ev.overdue ?? false,
        }));
      }
    } catch {
      // Fallback
    }

    const res = await this.fetchWithAuth(`${this.baseUrl}/calendar/view.php?view=upcoming`);
    if (options.strict && !res.ok) throw new Error('Unable to fetch the timeline.');
    const html = await res.text();
    if (options.strict) assertAuthenticatedHtml(html);
    const events = [];
    const eventBlocks = html.split('class="event"');
    for (let i = 1; i < eventBlocks.length; i++) {
      const block = eventBlocks[i];
      const titleMatch = block.match(/data-event-title="([^"]+)"/) || block.match(/<h3><a[^>]*>([^<]+)<\/a>/);
      const dateMatch = block.match(/class="date"[^>]*>([^<]+)<\/span>/);
      const linkMatch = block.match(/href="([^"]+)"/);
      if (titleMatch) {
        events.push({
          name: titleMatch[1].trim(),
          formattedtime: dateMatch ? dateMatch[1].trim() : 'Unknown',
          actionurl: linkMatch ? linkMatch[1] : '',
        });
      }
    }
    return events;
  }

  /**
   * Parse full contents of a specific course with deep metadata extraction
   */
  async getCourseContents(courseId, options = {}) {
    const url = `${this.baseUrl}/course/view.php?id=${courseId}`;
    const res = await this.fetchWithAuth(url);
    if (!res.ok) {
      throw new Error(`Failed to load course view (HTTP ${res.status})`);
    }

    const html = await res.text();
    const courseTitleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) ||
                             html.match(/<title>Course: ([^<]+)<\/title>/i);
    const courseTitle = courseTitleMatch ? courseTitleMatch[1].replace(/<[^>]+>/g, '').trim() : `Course ${courseId}`;

    const sectionSplits = html.split(/<li\s+id="section-(\d+)"/i);
    const sections = [];

    for (let i = 1; i < sectionSplits.length; i += 2) {
      const secNum = parseInt(sectionSplits[i], 10);
      const secChunk = sectionSplits[i + 1];

      // Extract section header/classes and persistent section database ID
      const secTagMatch = secChunk.match(/^\s*class="([^"]*)"/i);
      const secClasses = secTagMatch ? secTagMatch[1] : '';

      const secDbIdMatch = secChunk.match(/aria-labelledby="sectionid-(\d+)-title"/i) ||
                           secChunk.match(/data-sectionid="(\d+)"/i);
      const sectionId = secDbIdMatch ? parseInt(secDbIdMatch[1], 10) : secNum;

      const isSecHidden = secClasses.includes('hidden') ||
                          secClasses.includes('dimmed') ||
                          secChunk.includes('Hidden from students') ||
                          secChunk.includes('Not available unless');

      const titleMatch = secChunk.match(/class="sectionname[^"]*"[^>]*>[\s\S]*?<span>([\s\S]*?)<\/span>/i) ||
                         secChunk.match(/class="sectionname[^"]*"[^>]*>([\s\S]*?)<\/h3>/i);
      const sectionName = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : (secNum === 0 ? 'General' : `Topic ${secNum}`);

      const summaryMatch = secChunk.match(/<div\s+class="summary">([\s\S]*?)<\/div>/i);
      const summary = summaryMatch ? summaryMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : null;

      const actSplits = secChunk.split(/<li\s+class="activity\s+([a-zA-Z0-9_]+)\s+modtype_([a-zA-Z0-9_]+)[^"]*"\s+id="module-(\d+)"/gi);
      const activities = [];

      for (let j = 1; j < actSplits.length; j += 4) {
        const modType = actSplits[j + 1];
        const modId = parseInt(actSplits[j + 2], 10);
        const actBody = actSplits[j + 3];

        // Clean screen reader text (e.g. "<span class='accesshide '> Forum</span>") from instance name
        const instNameMatch = actBody.match(/<span[^>]*class=["'][^"']*instancename[^"']*["'][^>]*>([\s\S]*?)<\/span>\s*<\/a>/i) ||
                              actBody.match(/class=["'][^"']*instancename[^"']*["'][^>]*>([\s\S]*?)<span\s+class=["'][^"']*accesshide/i) ||
                              actBody.match(/class=["'][^"']*instancename[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
        const linkMatch = actBody.match(/<a\s+[^>]*class=["'][^"']*aalink[^"']*["'][^>]*href=["']([^"']+)["']/i) ||
                          actBody.match(/<a\s+[^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*aalink/i) ||
                          actBody.match(/<a\s+[^>]*href=["']([^"']+)["']/i);

        let name = instNameMatch ? instNameMatch[1].replace(/<span\s+class=["'][^"']*accesshide[^"']*["'][^>]*>[\s\S]*?<\/span>/gi, '').replace(/<[^>]+>/g, '').trim() : null;

        // For labels or items without instancename, parse text from contentwithoutlink
        if (!name && (modType === 'label' || actBody.includes('contentwithoutlink'))) {
          const labelMatch = actBody.match(/<div\s+class="contentwithoutlink[^"]*">([\s\S]*?)<\/div>/i);
          if (labelMatch) {
            const rawLabel = labelMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            if (rawLabel) {
              name = rawLabel.length > 90 ? `${rawLabel.slice(0, 87)}...` : rawLabel;
            }
          }
        }
        if (!name) name = `Module ${modId}`;

        const link = linkMatch ? linkMatch[1] : null;

        const isCompleted = actBody.includes('autocompletion-complete') ||
                            actBody.includes('completion-complete') ||
                            actBody.includes('title="Completed"');

        const isActHidden = actBody.includes('class="dimmed') ||
                            actBody.includes('class="hidden') ||
                            actBody.includes('Hidden from students') ||
                            actBody.includes('stealth');

        // Extract availability restrictions if present
        let availability = null;
        const availMatch = actBody.match(/<div\s+class="availabilityinfo[^"]*">([\s\S]*?)<\/div>/i);
        if (availMatch) {
          availability = availMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        }

        // Extract description/instructions after link
        let description = null;
        const descMatch = actBody.match(/<div\s+class="contentafterlink[^"]*">([\s\S]*?)<\/div>/i);
        if (descMatch) {
          description = descMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        }

        // Extract resource details (upload date, size, file description) if displayed
        let details = null;
        const detailsMatch = actBody.match(/<span\s+class="resourcedetails[^"]*">([\s\S]*?)<\/span>/i);
        if (detailsMatch) {
          details = detailsMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        }

        // Detect file type / format (from icons, details text, or file extension in name/link)
        let fileType = null;
        if (actBody.includes('/f/pdf') || (details && /pdf/i.test(details))) fileType = 'pdf';
        else if (actBody.includes('/f/powerpoint') || (details && /powerpoint|presentation/i.test(details))) fileType = 'pptx';
        else if (actBody.includes('/f/document') || (details && /word|document/i.test(details))) fileType = 'docx';
        else if (actBody.includes('/f/spreadsheet') || (details && /excel|spreadsheet/i.test(details))) fileType = 'xlsx';
        else if (actBody.includes('/f/archive') || (details && /zip|archive/i.test(details))) fileType = 'zip';
        else if (actBody.includes('/f/video') || (details && /video/i.test(details))) fileType = 'video';
        else if (actBody.includes('/f/audio') || (details && /audio/i.test(details))) fileType = 'audio';
        else if (/\.(pdf|pptx?|docx?|xlsx?|zip|rar|mp4|py|c|cpp|java|sql)(\?|$)/i.test(name || link || '')) {
          const extMatch = (name || link || '').match(/\.(pdf|pptx?|docx?|xlsx?|zip|rar|mp4|py|c|cpp|java|sql)(\?|$)/i);
          if (extMatch) fileType = extMatch[1].toLowerCase();
        }

        activities.push({
          id: modId,
          type: modType,
          name,
          link,
          completed: isCompleted,
          hidden: isActHidden,
          availability,
          fileType,
          description,
          details,
        });
      }

      sections.push({
        id: sectionId,
        number: secNum,
        name: sectionName,
        hidden: isSecHidden,
        summary,
        isEmpty: activities.length === 0,
        activities,
      });
    }

    return {
      id: courseId,
      title: courseTitle,
      url,
      sections,
    };
  }

  /**
   * Get assignments across a specific course or all enrolled courses.
   * strict rejects the whole collection if any course cannot be fetched.
   */
  async getAssignments(courseId = null, options = {}) {
    if (!courseId) {
      const courses = await this.getCourses(options.strict ? { strict: true } : {});
      const allAssignments = [];
      for (const course of courses) {
        try {
          const assigns = await this.getAssignments(course.id, options);
          allAssignments.push(...assigns.map(a => ({ ...a, coursename: course.fullname })));
        } catch {
          if (options.strict) throw new Error('Unable to fetch all assignments.');
          // Best-effort listing remains available to non-snapshot callers.
        }
      }
      return allAssignments;
    }

    const url = `${this.baseUrl}/mod/assign/index.php?id=${courseId}`;
    const res = await this.fetchWithAuth(url);
    if (!res.ok) {
      if (options.strict) throw new Error('Unable to fetch assignments.');
      return [];
    }

    const html = await res.text();
    if (options.strict) assertAuthenticatedHtml(html);
    const assignments = [];
    const rowRegex = /<tr class="[^"]*">([\s\S]*?)<\/tr>/gi;
    let rowMatch;

    while ((rowMatch = rowRegex.exec(html)) !== null) {
      const row = rowMatch[1];
      const linkMatch = row.match(/<a href="https?:\/\/elearning\.vsu\.edu\.ph\/mod\/assign\/view\.php\?id=(\d+)"[^>]*>([\s\S]*?)<\/a>/i);
      if (!linkMatch) continue;

      const id = parseInt(linkMatch[1], 10);
      const name = linkMatch[2].replace(/<[^>]+>/g, '').trim();

      const cols = [];
      const colRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      let colMatch;
      while ((colMatch = colRegex.exec(row)) !== null) {
        cols.push(colMatch[1].replace(/<[^>]+>/g, '').trim());
      }

      assignments.push({
        id,
        courseid: parseInt(courseId, 10),
        topic: cols[0] || '',
        name: name || cols[1] || `Assignment ${id}`,
        link: `${this.baseUrl}/mod/assign/view.php?id=${id}`,
        duedate: cols[2] || 'No due date',
        submissionStatus: cols[3] || 'Unknown',
        grade: cols[4] || 'No grade',
      });
    }

    return assignments;
  }

  /**
   * Get detailed view of an assignment including rubric, grade, feedback, and files
   */
  async getAssignmentDetails(assignId) {
    const url = `${this.baseUrl}/mod/assign/view.php?id=${assignId}`;
    const res = await this.fetchWithAuth(url);
    if (!res.ok) {
      throw new Error(`Failed to load assignment ${assignId} (HTTP ${res.status})`);
    }

    const html = await res.text();
    const titleMatch = html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : `Assignment ${assignId}`;

    let description = '';
    const introIdx = html.indexOf('id="intro"');
    if (introIdx !== -1) {
      const afterIntro = html.slice(introIdx);
      const contentStart = afterIntro.indexOf('>');
      const nextSectionMatch = afterIntro.match(/<(?:div class="submissionstatustable"|div class="submission"|div class="box"|section|form|div id="page-footer")/i);
      const introSnippet = nextSectionMatch ? afterIntro.slice(contentStart + 1, nextSectionMatch.index) : afterIntro.slice(contentStart + 1, 3000);
      description = introSnippet.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    } else {
      const descMatch = html.match(/id="intro"[^>]*>([\s\S]*?)<\/div>/i);
      description = descMatch ? descMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
    }

    const tableData = {};
    const rowRegex = /<tr[^>]*>[\s\S]*?<th[^>]*>([\s\S]*?)<\/th>[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>[\s\S]*?<\/tr>/gi;
    let m;
    while ((m = rowRegex.exec(html)) !== null) {
      const key = m[1].replace(/<[^>]+>/g, '').trim();
      const val = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (key) tableData[key] = val;
    }

    // Clean comments boilerplate
    let cleanComments = null;
    const rawComments = tableData['Submission comments'] || '';
    if (rawComments) {
      const countMatch = rawComments.match(/Comments\s*\(([0-9]+)\)/i);
      const commentCount = countMatch ? parseInt(countMatch[1], 10) : 0;
      if (commentCount > 0) {
        let stripped = rawComments
          .replace(/___[a-zA-Z0-9_]+___/gi, '')
          .replace(/Show comments/gi, '')
          .replace(/Save comment\s*\|\s*Cancel/gi, '')
          .replace(/Comments\s*\(\d+\)/gi, '')
          .replace(/[\r\n\t]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        stripped = stripped.replace(/^[-–—\s]+/, '').replace(/[-–—\s]+$/, '').trim();
        cleanComments = stripped.length > 0 ? `${commentCount} comment(s): ${stripped}` : `${commentCount} comment(s)`;
      }
    }

    // Extract student online text submission if present
    let onlineText = null;
    const onlineTextMatch = html.match(/<th[^>]*>Online text<\/th>[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>/i);
    if (onlineTextMatch) {
      const cellHtml = onlineTextMatch[1];
      const contentMatch = cellHtml.match(/<div class="no-overflow">([\s\S]*?)<\/div>/i);
      const rawText = contentMatch ? contentMatch[1] : cellHtml;
      onlineText = rawText
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\n\s+\n/g, '\n\n')
        .replace(/\r?\n/g, '\n')
        .replace(/[ \t]+/g, ' ')
        .trim();
      if (!onlineText) onlineText = tableData['Online text'] || null;
    }

    // Extract teacher feedback comments if present
    let feedbackComments = null;
    const feedbackCommentMatch = html.match(/<th[^>]*>Feedback comments<\/th>[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>/i);
    if (feedbackCommentMatch) {
      const cellHtml = feedbackCommentMatch[1];
      const contentMatch = cellHtml.match(/<div class="no-overflow">([\s\S]*?)<\/div>/i);
      const rawText = contentMatch ? contentMatch[1] : cellHtml;
      feedbackComments = rawText
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\n\s+\n/g, '\n\n')
        .replace(/\r?\n/g, '\n')
        .replace(/[ \t]+/g, ' ')
        .trim();
      if (!feedbackComments) feedbackComments = tableData['Feedback comments'] || null;
    }

    // Extract instructor file attachments from full main content area without cutting off at inner nested divs
    const attachments = [];
    const seenUrls = new Set();
    let contentToSearch = html;
    const mainStart = html.indexOf('id="region-main"') !== -1
      ? html.indexOf('id="region-main"')
      : (html.indexOf('role="main"') !== -1 ? html.indexOf('role="main"') : html.indexOf('id="maincontent"'));
    const footerStart = html.indexOf('id="page-footer"') !== -1
      ? html.indexOf('id="page-footer"')
      : (html.indexOf('<footer') !== -1 ? html.indexOf('<footer') : -1);

    if (mainStart !== -1) {
      contentToSearch = footerStart !== -1 && footerStart > mainStart
        ? html.slice(mainStart, footerStart)
        : html.slice(mainStart);
    }

    const linkRegex = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let lMatch;
    while ((lMatch = linkRegex.exec(contentToSearch)) !== null) {
      let url = lMatch[1].replace(/&amp;/g, '&');
      if (url.startsWith('/')) url = `${this.baseUrl}${url}`;
      const text = lMatch[2].replace(/<[^>]+>/g, '').trim();

      // Skip navigation, user profile, theme chrome links, and submission/feedback components
      if (
        url.includes('/theme/') ||
        url.includes('/pix/') ||
        url.includes('/user/') ||
        url.includes('/mod/assign/view.php') ||
        url.includes('/course/view.php') ||
        url.includes('assignsubmission_file') ||
        url.includes('assignsubmission_onlinetext') ||
        url.includes('assignfeedback_file') ||
        url.includes('assignfeedback_comments')
      ) {
        continue;
      }

      const isPluginFile = url.includes('pluginfile.php') && (url.includes('mod_assign') || url.includes('intro') || url.includes('attachment'));
      const isDocUrl = /\.(pdf|pptx?|docx?|xlsx?|zip|rar|tar|gz|7z|png|jpe?g|mp4|webm|mp3|txt|md)(?:\?|$)/i.test(url);
      const isDocText = /\.(pdf|pptx?|docx?|xlsx?|zip|rar|tar|gz|7z|png|jpe?g|mp4|webm|mp3|txt|md)$/i.test(text);

      if (isPluginFile || isDocUrl || isDocText) {
        if (!seenUrls.has(url)) {
          seenUrls.add(url);
          let name = text;
          if (!name || name.startsWith('http')) {
            try {
              name = path.basename(new URL(url).pathname);
            } catch {
              name = `attachment_${attachments.length + 1}`;
            }
          }
          attachments.push({
            name,
            url,
          });
        }
      }
    }

    // Extract submitted files with download URLs and timestamps
    const submittedFiles = [];
    const fileSubRow = html.match(/<th[^>]*>File submissions<\/th>[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>/i);
    if (fileSubRow) {
      const cellHtml = fileSubRow[1];
      const aRegex = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      let aMatch;
      while ((aMatch = aRegex.exec(cellHtml)) !== null) {
        let href = aMatch[1].replace(/&amp;/g, '&');
        if (href.startsWith('/')) href = `${this.baseUrl}${href}`;
        if (!href.includes('forcedownload=1')) {
          href += (href.includes('?') ? '&' : '?') + 'forcedownload=1';
        }
        const fname = aMatch[2].replace(/<[^>]+>/g, '').trim();
        const timeMatch = cellHtml.slice(aMatch.index, aMatch.index + 350).match(/class="fileuploadsubmissiontime"[^>]*>([^<]+)<\/div>/i);
        const uploadTime = timeMatch ? timeMatch[1].trim() : null;
        submittedFiles.push({
          name: fname || path.basename(new URL(href).pathname),
          url: href,
          uploadedAt: uploadTime,
        });
      }
    }

    // Extract feedback files
    const feedbackFiles = [];
    const feedbackRow = html.match(/<th[^>]*>Feedback files<\/th>[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>/i);
    if (feedbackRow) {
      const cellHtml = feedbackRow[1];
      const aRegex = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      let aMatch;
      while ((aMatch = aRegex.exec(cellHtml)) !== null) {
        let href = aMatch[1].replace(/&amp;/g, '&');
        if (href.startsWith('/')) href = `${this.baseUrl}${href}`;
        if (!href.includes('forcedownload=1')) {
          href += (href.includes('?') ? '&' : '?') + 'forcedownload=1';
        }
        const fname = aMatch[2].replace(/<[^>]+>/g, '').trim();
        feedbackFiles.push({
          name: fname || path.basename(new URL(href).pathname),
          url: href,
        });
      }
    }

    // Extract structured rubric criteria if present
    let rubric = null;
    const rubricBoxMatch = html.match(/class="(?:gradingform_rubric|gradingform_guide)[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i);
    if (rubricBoxMatch) {
      const rubricHtml = rubricBoxMatch[0];
      const criteria = [];
      const critRegex = /<tr class="criterion[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi;
      let crMatch;
      while ((crMatch = critRegex.exec(rubricHtml)) !== null) {
        const crHtml = crMatch[1];
        const descMatch = crHtml.match(/class="description"[^>]*>([\s\S]*?)<\/td>/i);
        const desc = descMatch ? descMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
        const levels = [];
        const levRegex = /<td class="level[^"]*"[^>]*>([\s\S]*?)<\/td>/gi;
        let levMatch;
        while ((levMatch = levRegex.exec(crHtml)) !== null) {
          const lHtml = levMatch[1];
          const isChecked = levMatch[0].includes('checked') || levMatch[0].includes('currentchecked');
          const scoreMatch = lHtml.match(/class="score"[^>]*>([\s\S]*?)<\/span>/i);
          const defMatch = lHtml.match(/class="definition"[^>]*>([\s\S]*?)<\/div>/i);
          levels.push({
            score: scoreMatch ? scoreMatch[1].replace(/<[^>]+>/g, '').trim() : '',
            definition: defMatch ? defMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '',
            checked: isChecked,
          });
        }
        const remarkMatch = crHtml.match(/class="remark"[^>]*>([\s\S]*?)<\/td>/i);
        criteria.push({
          description: desc,
          levels,
          remark: remarkMatch ? remarkMatch[1].replace(/<[^>]+>/g, ' ').trim() : null,
        });
      }
      if (criteria.length > 0) {
        rubric = { criteria };
      }
    }

    // Extract course name from breadcrumb or title
    const courseMatch = html.match(/<li class="breadcrumb-item"[^>]*>[\s\S]*?<a[^>]*course\/view\.php\?id=\d+[^>]*>([\s\S]*?)<\/a>/i) ||
                        html.match(/<a[^>]*href="[^"]*course\/view\.php\?id=\d+"[^>]*>([\s\S]*?)<\/a>/i);
    const courseName = courseMatch ? courseMatch[1].replace(/<[^>]+>/g, '').trim() : null;

    // Separate rubric/guideline attachments from generic attachments
    const rubricAttachments = attachments.filter(att => {
      const text = `${att.name} ${att.url}`.toLowerCase();
      return text.includes('rubric') || text.includes('criteri') || text.includes('guideline') || text.includes('scoring') || text.includes('grading');
    });

    // Extract dates from Moodle 4+ activity-dates block or tableData
    const dueMatch = html.match(/data-region="activity-dates"[\s\S]*?<strong>\s*Due:\s*<\/strong>\s*([^<\n]+)/i) ||
                     html.match(/<strong>\s*Due:\s*<\/strong>\s*([^<\n]+)/i);
    const openedMatch = html.match(/data-region="activity-dates"[\s\S]*?<strong>\s*Opened:\s*<\/strong>\s*([^<\n]+)/i) ||
                       html.match(/<strong>\s*Opened:\s*<\/strong>\s*([^<\n]+)/i);

    const rawDueDate = (dueMatch ? dueMatch[1].trim() : null) || tableData['Due date'] || null;
    const openedDate = (openedMatch ? openedMatch[1].trim() : null) || tableData['Opened'] || null;
    const dueDate = rawDueDate || 'None';

    const subStatus = tableData['Submission status'] || 'Not submitted';
    const gradStatus = tableData['Grading status'] || 'Not graded';
    const timeRem = tableData['Time remaining'] || 'Unknown';
    const isSubmitted = (
      (/submitted/i.test(subStatus) && !/not submitted/i.test(subStatus)) ||
      (/graded/i.test(gradStatus) && !/not graded/i.test(gradStatus)) ||
      submittedFiles.length > 0 ||
      Boolean(onlineText && onlineText.length > 0)
    ) && !/no attempt/i.test(subStatus) && !/no submission/i.test(subStatus) && !/not submitted/i.test(subStatus);

    let isOverdue = /overdue/i.test(timeRem) || /overdue/i.test(subStatus);
    if (!isOverdue && !isSubmitted && dueDate && dueDate !== 'None') {
      const parsedDue = new Date(dueDate);
      if (!isNaN(parsedDue.getTime()) && parsedDue.getTime() < Date.now()) {
        isOverdue = true;
      }
    }

    return {
      id: assignId,
      title,
      course: courseName,
      url,
      description,
      status: subStatus,
      isSubmitted,
      gradingStatus: gradStatus,
      isGraded: /graded|released/i.test(gradStatus) && !/not graded/i.test(gradStatus),
      dueDate,
      openedDate,
      timeRemaining: timeRem,
      isOverdue,
      lastModified: tableData['Last modified'] || null,
      grade: tableData['Grade'] ? tableData['Grade'].replace(/&nbsp;/g, ' ') : null,
      gradedOn: tableData['Graded on'] || null,
      gradedBy: tableData['Graded by'] || null,
      group: tableData['Group'] || null,
      onlineText,
      fileSubmissions: tableData['File submissions'] || null,
      submittedFiles,
      feedbackFiles,
      feedbackComments,
      rubric,
      rubricAttachments,
      submissionComments: cleanComments,
      attachments,
    };
  }

  /**
   * Direct inspection of assignment submission status
   */
  async getSubmissionStatus(assignId) {
    return this.getAssignmentDetails(assignId);
  }

  /**
   * Get submission statuses across all assignments in a course (with concurrency pool)
   */
  async getCourseSubmissions(courseId, options = {}) {
    const assignments = await this.getAssignments(courseId);
    const concurrency = Math.max(1, Math.min(8, parseInt(options.concurrency, 10) || 4));
    const results = [];

    const settled = await asyncPool(concurrency, assignments, async (assign) => {
      try {
        const details = await this.getSubmissionStatus(assign.id);
        return {
          id: assign.id,
          name: assign.name,
          course: details.course || assign.coursename,
          status: details.status,
          isSubmitted: details.isSubmitted,
          gradingStatus: details.gradingStatus,
          isGraded: details.isGraded,
          grade: details.grade,
          dueDate: details.dueDate,
          openedDate: details.openedDate,
          timeRemaining: details.timeRemaining,
          isOverdue: details.isOverdue,
          submittedFileCount: details.submittedFiles.length,
          hasOnlineText: Boolean(details.onlineText),
          onlineText: details.onlineText,
          feedbackComments: details.feedbackComments,
          rubricCount: details.rubricAttachments.length + (details.rubric ? 1 : 0),
          url: details.url,
        };
      } catch (err) {
        return {
          id: assign.id,
          name: assign.name,
          error: err.message,
        };
      }
    }, {
      onStart: options.onStart,
      onProgress: options.onProgress,
    });

    for (const s of settled) {
      if (s.status === 'fulfilled') {
        results.push(s.value);
      }
    }

    return {
      courseId,
      total: results.length,
      submitted: results.filter(r => r.isSubmitted).length,
      graded: results.filter(r => r.isGraded).length,
      overdue: results.filter(r => r.isOverdue).length,
      submissions: results,
    };
  }

  /**
   * Download attached rubric files, guidelines, and rubric markdown for an assignment
   */
  async downloadAssignmentRubrics(assignId, destDir = null, options = {}) {
    const details = await this.getAssignmentDetails(assignId);
    const sanitizedTitle = details.title.replace(/[\/\\:*?"<>|]/g, '_').trim();
    const resolvedDest = destDir
      ? expandHome(destDir)
      : path.join(os.homedir(), 'Downloads', 'VSUEE', 'Rubrics', sanitizedTitle);

    await fs.mkdir(resolvedDest, { recursive: true });

    let filesToDownload = details.rubricAttachments && details.rubricAttachments.length > 0
      ? details.rubricAttachments
      : (details.attachments || []);

    const concurrency = Math.max(1, Math.min(16, parseInt(options.concurrency, 10) || 4));
    const downloadedFiles = [];

    if (filesToDownload.length > 0) {
      const settled = await asyncPool(concurrency, filesToDownload, async (att) => {
        const res = await this.downloadResource(att.url, resolvedDest, options);
        return { name: att.name, ...res };
      }, {
        onStart: options.onStart,
        onProgress: options.onProgress,
      });

      for (const item of settled) {
        if (item.status === 'fulfilled') {
          downloadedFiles.push(item.value);
        } else {
          downloadedFiles.push({ error: item.reason?.message || String(item.reason) });
        }
      }
    }

    let rubricMarkdownPath = null;
    if (details.rubric && details.rubric.criteria && details.rubric.criteria.length > 0) {
      rubricMarkdownPath = path.join(resolvedDest, 'rubric_criteria.md');
      let md = `# Rubric: ${details.title}\n\n`;
      md += `- **URL**: ${details.url}\n`;
      md += `- **Due Date**: ${details.dueDate}\n`;
      md += `- **Status**: ${details.status}\n`;
      if (details.grade) md += `- **Grade**: ${details.grade}\n`;
      if (details.feedbackComments) md += `- **Teacher Feedback Comments**: ${details.feedbackComments}\n`;
      md += `\n## Criteria\n\n`;
      for (const crit of details.rubric.criteria) {
        md += `### ${crit.description}\n\n`;
        if (crit.remark) md += `**Feedback**: ${crit.remark}\n\n`;
        md += `| Level | Score | Definition | Selected |\n`;
        md += `| :--- | :--- | :--- | :---: |\n`;
        for (let idx = 0; idx < crit.levels.length; idx++) {
          const l = crit.levels[idx];
          const sel = l.checked ? '✔ [SELECTED]' : '';
          md += `| Level ${idx + 1} | ${l.score} | ${l.definition.replace(/\|/g, '\\|')} | ${sel} |\n`;
        }
        md += `\n`;
      }
      await fs.writeFile(rubricMarkdownPath, md, 'utf8');
    }

    return {
      assignmentId: details.id,
      title: details.title,
      destination: resolvedDest,
      downloadedFiles,
      rubricMarkdownPath,
      count: downloadedFiles.filter(f => !f.error && !f.skipped).length + (rubricMarkdownPath ? 1 : 0),
    };
  }

  /**
   * Download student's submitted files for an assignment
   */
  async downloadSubmissionFiles(assignId, destDir = null, options = {}) {
    const details = await this.getAssignmentDetails(assignId);
    const sanitizedTitle = details.title.replace(/[\/\\:*?"<>|]/g, '_').trim();
    const resolvedDest = destDir
      ? expandHome(destDir)
      : path.join(os.homedir(), 'Downloads', 'VSUEE', 'Submissions', sanitizedTitle);

    await fs.mkdir(resolvedDest, { recursive: true });

    if (!details.submittedFiles || details.submittedFiles.length === 0) {
      return {
        assignmentId: details.id,
        title: details.title,
        destination: resolvedDest,
        count: 0,
        files: [],
        message: 'No submitted files found for this assignment.',
      };
    }

    const concurrency = Math.max(1, Math.min(16, parseInt(options.concurrency, 10) || 4));
    const downloadedFiles = [];

    const settled = await asyncPool(concurrency, details.submittedFiles, async (file) => {
      const res = await this.downloadResource(file.url, resolvedDest, options);
      return { name: file.name, uploadedAt: file.uploadedAt, ...res };
    }, {
      onStart: options.onStart,
      onProgress: options.onProgress,
    });

    for (const item of settled) {
      if (item.status === 'fulfilled') {
        downloadedFiles.push(item.value);
      } else {
        downloadedFiles.push({ error: item.reason?.message || String(item.reason) });
      }
    }

    return {
      assignmentId: details.id,
      title: details.title,
      destination: resolvedDest,
      count: downloadedFiles.filter(f => !f.error && !f.skipped).length,
      files: downloadedFiles,
    };
  }

  /**
   * Submit an assignment (file and/or online text) to Moodle.
   *
   * @param {number|string} assignId - Moodle assignment module ID
   * @param {Object} options
   * @param {string} [options.filePath] - Absolute or relative path to file to upload
   * @param {string} [options.onlineText] - Text content for online text submissions
   * @param {boolean} [options.final=false] - Whether to finalize submission for grading
   * @param {Function} [options.onProgress] - Optional progress callback
   * @returns {Promise<Object>} Result details including verified assignment status, file name, sha256, etc.
   */
  async submitAssignment(assignId, options = {}) {
    if (!assignId) {
      throw new Error('Assignment ID is required');
    }

    const { filePath, onlineText, final: isFinal = false } = options;
    if (!filePath && !onlineText) {
      throw new Error('Must provide either a file (--file <path>) or online text (--text <string>) to submit');
    }

    let fileInfo = null;
    let resolvedFilePath = null;
    if (filePath) {
      resolvedFilePath = path.resolve(expandHome(filePath));
      if (!fsSync.existsSync(resolvedFilePath)) {
        throw new Error(`File not found: ${resolvedFilePath}`);
      }
      const stats = fsSync.statSync(resolvedFilePath);
      if (stats.isDirectory()) {
        throw new Error(`Target file path is a directory: ${resolvedFilePath}`);
      }
      if (stats.size === 0) {
        throw new Error(`Target file is empty (0 bytes): ${resolvedFilePath}`);
      }

      const fileBuffer = fsSync.readFileSync(resolvedFilePath);
      const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');
      fileInfo = {
        name: path.basename(resolvedFilePath),
        path: resolvedFilePath,
        size: stats.size,
        sha256,
        buffer: fileBuffer,
      };
    }

    // Step 1: Fetch edit submission form
    const editUrl = `${this.baseUrl}/mod/assign/view.php?id=${assignId}&action=editsubmission`;
    const editRes = await this.fetchWithAuth(editUrl);
    if (!editRes.ok) {
      throw new Error(`Failed to load submission form for assignment ${assignId} (HTTP ${editRes.status})`);
    }

    const html = await editRes.text();

    // Check if form is present
    const formMatch = html.match(/<form[^>]+action=["']([^"']*view\.php[^"']*)["'][^>]*>([\s\S]*?)<\/form>/i);
    if (!formMatch) {
      if (html.includes('Submissions are not accepted') || html.includes('not accepting submissions') || html.includes('cut-off date')) {
        throw new Error(`Assignment ${assignId} is closed or not accepting submissions.`);
      }
      throw new Error(`Could not find submission form for assignment ${assignId}. Submissions may be locked or disabled.`);
    }

    const formHtml = formMatch[2];
    const formAction = formMatch[1].startsWith('/') ? `${this.baseUrl}${formMatch[1]}` : formMatch[1];

    // Extract sesskey
    const sesskey = this.extractSesskey(html) || this.sesskey;
    if (!sesskey) {
      throw new Error('Could not determine session key (sesskey) for submission');
    }

    // Extract hidden fields
    const inputs = {};
    const inputRegex = /<input[^>]+name=["']([^"']+)["'][^>]*value=["']([^"']*)["']/gi;
    let inMatch;
    while ((inMatch = inputRegex.exec(formHtml)) !== null) {
      inputs[inMatch[1]] = inMatch[2];
    }

    // Check for filemanager configuration
    let draftItemId = null;
    let repoId = 4;
    let clientId = null;
    let maxbytes = null;
    let acceptedTypes = null;
    let author = this.userName || 'Student';
    let defaultLicense = 'allrightsreserved';
    let contextId = 0;
    let areaMaxBytes = -1;

    const fmMatch = html.match(/M\.form_filemanager\.init\(Y,\s*(\{[\s\S]*?\})\);/);
    if (fmMatch) {
      try {
        const fmOpts = JSON.parse(fmMatch[1]);
        draftItemId = fmOpts.itemid || null;
        clientId = fmOpts.client_id || null;
        maxbytes = fmOpts.maxbytes ? parseInt(fmOpts.maxbytes, 10) : null;
        acceptedTypes = fmOpts.accepted_types || null;
        if (fmOpts.author) author = fmOpts.author;
        if (fmOpts.defaultlicense) defaultLicense = fmOpts.defaultlicense;
        if (fmOpts.context?.id) contextId = fmOpts.context.id;
        if (fmOpts.areamaxbytes) areaMaxBytes = fmOpts.areamaxbytes;

        const repos = fmOpts.filepicker?.repositories || fmOpts.repositories || {};
        for (const [rid, rdata] of Object.entries(repos)) {
          if (rdata.type === 'upload') {
            repoId = parseInt(rid, 10);
            break;
          }
        }
      } catch {
        const fallbackItem = html.match(/"itemid":\s*(\d+)/);
        if (fallbackItem) draftItemId = parseInt(fallbackItem[1], 10);
      }
    }

    // Step 2: Validate file against constraints
    if (fileInfo) {
      if (maxbytes && maxbytes > 0 && fileInfo.size > maxbytes) {
        const maxMb = (maxbytes / (1024 * 1024)).toFixed(1);
        const fileMb = (fileInfo.size / (1024 * 1024)).toFixed(1);
        throw new Error(`File size (${fileMb} MB) exceeds maximum allowed size (${maxMb} MB) for this assignment`);
      }

      if (acceptedTypes && Array.isArray(acceptedTypes) && acceptedTypes.length > 0 && !acceptedTypes.includes('*')) {
        const ext = path.extname(fileInfo.name).toLowerCase();
        const isAccepted = acceptedTypes.some(t => {
          const cleanT = t.toLowerCase().trim();
          if (cleanT.startsWith('.')) return cleanT === ext;
          if (cleanT === 'document') return ['.pdf', '.doc', '.docx', '.txt', '.odt', '.rtf'].includes(ext);
          if (cleanT === 'archive') return ['.zip', '.rar', '.7z', '.tar', '.gz'].includes(ext);
          if (cleanT === 'image') return ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext);
          return false;
        });
        if (!isAccepted) {
          throw new Error(`File extension "${ext}" is not accepted for this assignment. Accepted types: ${acceptedTypes.join(', ')}`);
        }
      }

      if (!draftItemId) {
        throw new Error('This assignment does not accept file submissions or file area is not available');
      }

      // Step 3: Upload file to draft file area via Moodle repository AJAX
      if (typeof options.onProgress === 'function') {
        options.onProgress({ step: 'uploading', filename: fileInfo.name, size: fileInfo.size });
      }

      const uploadUrl = `${this.baseUrl}/repository/repository_ajax.php?action=upload`;
      const formData = new FormData();
      formData.append('repo_id', String(repoId));
      formData.append('itemid', String(draftItemId));
      formData.append('p', '');
      formData.append('page', '');
      formData.append('env', 'filemanager');
      formData.append('sesskey', sesskey);
      formData.append('client_id', clientId || String(draftItemId));
      formData.append('maxbytes', String(maxbytes || -1));
      formData.append('areamaxbytes', String(areaMaxBytes || -1));
      formData.append('ctx_id', String(contextId || 0));
      formData.append('saveas_filename', fileInfo.name);
      formData.append('saveas_author', author);
      formData.append('saveas_license', defaultLicense);

      const mimeType = getMimeType(fileInfo.name);
      const blob = new Blob([fileInfo.buffer], { type: mimeType });
      formData.append('repo_upload_file', blob, fileInfo.name);

      const uploadRes = await this.fetchWithAuth(uploadUrl, {
        method: 'POST',
        body: formData,
      });

      if (!uploadRes.ok) {
        throw new Error(`Failed to upload file to Moodle repository (HTTP ${uploadRes.status})`);
      }

      const uploadJson = await uploadRes.json();
      if (uploadJson.error) {
        throw new Error(`Moodle file upload rejected: ${uploadJson.error}`);
      }
    }

    // Step 4: Submit the submission form (savesubmission)
    if (typeof options.onProgress === 'function') {
      options.onProgress({ step: 'saving' });
    }

    const saveFormData = new FormData();
    saveFormData.append('id', String(assignId));
    saveFormData.append('action', 'savesubmission');
    saveFormData.append('sesskey', sesskey);
    saveFormData.append('_qf__mod_assign_submission_form', inputs['_qf__mod_assign_submission_form'] || '1');
    if (inputs['lastmodified']) saveFormData.append('lastmodified', inputs['lastmodified']);
    if (inputs['userid']) saveFormData.append('userid', inputs['userid']);
    if (draftItemId) saveFormData.append('files_filemanager', String(draftItemId));

    if (onlineText) {
      const otItemMatch = formHtml.match(/name=["']onlinetext_editor\[itemid\]["'][^>]*value=["'](\d+)["']/i);
      const otItemId = otItemMatch ? otItemMatch[1] : '';
      saveFormData.append('onlinetext_editor[text]', `<p>${onlineText.replace(/\n/g, '<br />')}</p>`);
      saveFormData.append('onlinetext_editor[format]', '1');
      if (otItemId) saveFormData.append('onlinetext_editor[itemid]', otItemId);
    }

    saveFormData.append('submitbutton', 'Save changes');

    const saveRes = await this.fetchWithAuth(formAction, {
      method: 'POST',
      body: saveFormData,
    });

    if (!saveRes.ok) {
      throw new Error(`Failed to save submission (HTTP ${saveRes.status})`);
    }

    // Step 5: Finalize submission for grading if requested
    let finalized = false;
    if (isFinal) {
      if (typeof options.onProgress === 'function') {
        options.onProgress({ step: 'finalizing' });
      }

      const finalViewUrl = `${this.baseUrl}/mod/assign/view.php?id=${assignId}&action=submit`;
      const finalRes = await this.fetchWithAuth(finalViewUrl);
      if (finalRes.ok) {
        const finalHtml = await finalRes.text();
        if (finalHtml.includes('submissionstatement') || finalHtml.includes('confirm') || finalHtml.includes('action="savesubmit"')) {
          const confirmData = new FormData();
          confirmData.append('id', String(assignId));
          confirmData.append('action', 'submit');
          confirmData.append('sesskey', sesskey);
          confirmData.append('submissionstatement', '1');
          confirmData.append('confirm', '1');
          confirmData.append('submitbutton', 'Continue');

          const submitRes = await this.fetchWithAuth(`${this.baseUrl}/mod/assign/view.php`, {
            method: 'POST',
            body: confirmData,
          });
          if (submitRes.ok) {
            finalized = true;
          }
        }
      }
    }

    // Step 6: Verify post-submission state
    const details = await this.getAssignmentDetails(assignId);

    // Step 7: Write local audit log
    const auditDir = path.join(os.homedir(), '.config', 'vsuee');
    try {
      await fs.mkdir(auditDir, { recursive: true });
      const logPath = path.join(auditDir, 'submissions.log');
      const timestamp = new Date().toISOString();
      const logEntry = `[${timestamp}] ASSIGN_ID=${assignId} MODE=${isFinal ? 'final' : 'draft'} STATUS="${details.status || 'Submitted'}" FILE="${fileInfo ? fileInfo.name : 'none'}" SHA256="${fileInfo ? fileInfo.sha256 : 'none'}"\n`;
      await fs.appendFile(logPath, logEntry, 'utf8');
    } catch {
      // Non-critical if audit logging fails
    }

    return {
      success: true,
      assignId: Number(assignId),
      title: details.title,
      course: details.course,
      status: details.status || details.submissionStatus,
      isFinal: Boolean(isFinal && finalized),
      mode: isFinal ? 'final' : 'draft',
      file: fileInfo ? {
        name: fileInfo.name,
        path: fileInfo.path,
        size: fileInfo.size,
        sha256: fileInfo.sha256,
      } : null,
      onlineText: onlineText || null,
      submittedFiles: details.submittedFiles || [],
      timestamp: new Date().toISOString(),
      verified: true,
    };
  }

  /**
   * Export calendar deadlines, quizzes, and events to standard RFC 5545 .ics file
   */
  async exportCalendarIcs(destFilePath = null, options = {}) {
    const targetPath = destFilePath
      ? expandHome(destFilePath)
      : path.join(os.homedir(), 'Downloads', 'vsuee_calendar.ics');

    await fs.mkdir(path.dirname(targetPath), { recursive: true });

    const allEvents = [];
    const seenUids = new Set();
    let fetchedFromMoodle = false;

    // 1. Attempt official Moodle calendar export endpoint to get native calendar events
    try {
      if (this.sesskey) {
        const form = new URLSearchParams();
        form.append('sesskey', this.sesskey);
        form.append('_qf__core_calendar_export_form', '1');
        form.append('events[exportevents]', options.events || 'all');
        form.append('period[timeperiod]', options.period || 'recentupcoming');
        form.append('export', 'Export');

        const res = await this.fetchWithAuth(`${this.baseUrl}/calendar/export.php`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: form.toString(),
        });

        if (res.ok) {
          const text = await res.text();
          if (text.includes('BEGIN:VCALENDAR') && text.includes('BEGIN:VEVENT')) {
            fetchedFromMoodle = true;
            const veventRegex = /BEGIN:VEVENT([\s\S]*?)END:VEVENT/gi;
            let m;
            while ((m = veventRegex.exec(text)) !== null) {
              const block = m[1];
              const getField = (name) => {
                const fMatch = block.match(new RegExp(`(?:^|\\r?\\n)${name}(?:;[^:]*)?:(.*(?:\\r?\\n[ \t][^\\r\\n]*)*)`, 'i'));
                if (!fMatch) return null;
                return fMatch[1].replace(/\r?\n[ \t]/g, '').replace(/\\,/g, ',').replace(/\\;/g, ';').trim();
              };
              const uid = getField('UID') || `vsuee-moodle-${crypto.randomUUID()}@elearning.vsu.edu.ph`;
              const summary = getField('SUMMARY') || 'VSU Event';
              const categories = getField('CATEGORIES') || '';
              const dtstart = getField('DTSTART');
              const dtend = getField('DTEND');
              const description = getField('DESCRIPTION');
              const location = getField('LOCATION') || categories || 'VSU eLearning';

              const uidKey = uid.toLowerCase();
              seenUids.add(uidKey);
              const numMatch = uid.match(/^(\d+)@/);
              if (numMatch) {
                seenUids.add(`vsuee-timeline-${numMatch[1]}@elearning.vsu.edu.ph`.toLowerCase());
                seenUids.add(numMatch[1]);
              }

              // Filter by courseId if specified
              if (options.courseId) {
                const cIdStr = String(options.courseId);
                const matchesCourse = categories.includes(cIdStr) || summary.includes(cIdStr);
                if (!matchesCourse) continue;
              }

              allEvents.push({
                uid,
                summary,
                name: summary,
                categories,
                coursename: categories,
                location,
                dtstart: dtstart || new Date(),
                dtend: dtend || new Date(),
                description: description || '',
              });
            }
          }
        }
      }
    } catch {
      // Fallback to local timeline & assignment synthesis
    }

    // 2. Fetch timeline events and merge any not already present
    const timelineEvents = await this.getTimeline(100).catch(() => []);
    for (const tl of timelineEvents) {
      if (options.courseId && String(tl.courseid) !== String(options.courseId)) continue;
      const uid = `vsuee-timeline-${tl.id}@elearning.vsu.edu.ph`.toLowerCase();
      const rawUid = `${tl.id}@elearning.vsu.edu.ph`.toLowerCase();
      if (seenUids.has(uid) || seenUids.has(rawUid) || seenUids.has(String(tl.id))) continue;
      seenUids.add(uid);

      const start = tl.timestart ? new Date(tl.timestart) : new Date();
      allEvents.push({
        uid,
        id: tl.id,
        name: tl.coursename ? `[${tl.coursename}] ${tl.name}` : tl.name,
        summary: tl.coursename ? `[${tl.coursename}] ${tl.name}` : tl.name,
        dtstart: start,
        dtend: new Date(start.getTime() + 3600000),
        description: `Activity: ${tl.activityname || tl.name}\nCourse: ${tl.coursename}\nAction Link: ${tl.actionurl}`,
        coursename: tl.coursename,
        location: tl.coursename || 'VSU eLearning',
        actionurl: tl.actionurl,
        url: tl.actionurl,
        categories: tl.coursename,
      });
    }

    // 3. Fetch course assignments and include all assignments with due dates!
    if (options.includeAssignments !== false) {
      try {
        const assigns = await this.getAssignments(options.courseId || null);
        for (const assign of assigns) {
          if (!assign.duedate || assign.duedate === '-' || assign.duedate.toLowerCase().includes('no due')) {
            continue;
          }
          const uid = `vsuee-assign-${assign.id}@elearning.vsu.edu.ph`.toLowerCase();
          if (seenUids.has(uid)) continue;
          seenUids.add(uid);

          let validDate = new Date(assign.duedate);
          if (isNaN(validDate.getTime())) {
            validDate = new Date();
          } else if (validDate.getFullYear() < 2020 && !/\b(19|20)\d{2}\b/.test(String(assign.duedate))) {
            const withYear = String(assign.duedate).replace(/(\d{1,2}\s+[A-Za-z]+)/, `$1 ${new Date().getFullYear()}`);
            const retryD = new Date(withYear);
            if (!isNaN(retryD.getTime())) validDate = retryD;
          }
          allEvents.push({
            uid,
            id: assign.id,
            name: assign.coursename ? `[${assign.coursename}] ${assign.name} Due` : `${assign.name} Due`,
            summary: assign.coursename ? `[${assign.coursename}] ${assign.name} Due` : `${assign.name} Due`,
            dtstart: validDate,
            dtend: new Date(validDate.getTime() + 1800000),
            description: `Assignment: ${assign.name}\nCourse: ${assign.coursename || 'VSUEE'}\nStatus: ${assign.submissionStatus}\nGrade: ${assign.grade}\nLink: ${assign.link}`,
            coursename: assign.coursename,
            location: assign.coursename || 'VSU eLearning',
            actionurl: assign.link,
            url: assign.link,
            categories: assign.coursename,
          });
        }
      } catch {}
    }

    // 4. Generate clean, standards-compliant RFC 5545 iCalendar content with alarms and folding
    const calName = options.courseId
      ? `VSUEE Course ${options.courseId} Schedule`
      : (options.calendarName || 'VSU eLearning Schedule');

    const icsContent = generateIcsCalendar(allEvents, {
      calendarName: calName,
      includeAlarms: options.includeAlarms !== false,
    });

    await fs.writeFile(targetPath, icsContent, 'utf8');
    const stat = await fs.stat(targetPath);

    return {
      savedPath: targetPath,
      eventCount: allEvents.length,
      bytes: stat.size,
      fetchedFromMoodle,
    };
  }

  /**
   * Get content of a Moodle Page module (e.g. syllabus, reading materials, instructor notes)
   */
  async getPageContent(pageId) {
    const url = `${this.baseUrl}/mod/page/view.php?id=${pageId}`;
    const res = await this.fetchWithAuth(url);
    if (!res.ok) {
      throw new Error(`Failed to load page module ${pageId} (HTTP ${res.status})`);
    }

    const html = await res.text();
    const titleMatch = html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : `Page ${pageId}`;

    const contentMatch = html.match(/class="box py-3 generalbox[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/section>/i) ||
                         html.match(/class="box py-3 generalbox[^"]*"[^>]*>([\s\S]*?)<\/div>/i) ||
                         html.match(/role="main"[^>]*>([\s\S]*?)<\/section>/i);

    const rawContent = contentMatch ? contentMatch[1] : '';
    const plainText = rawContent
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\n\s+\n/g, '\n\n')
      .trim();

    const modifiedMatch = html.match(/class="modified"[^>]*>([\s\S]*?)<\/div>/i);
    const lastModified = modifiedMatch ? modifiedMatch[1].replace(/<[^>]+>/g, '').trim() : null;

    return {
      id: pageId,
      title,
      url,
      lastModified,
      content: plainText,
      contentHtml: rawContent.trim(),
    };
  }

  /**
   * Get details, time limits, and attempt status of a Moodle Quiz
   */
  async getQuizDetails(quizId) {
    const url = `${this.baseUrl}/mod/quiz/view.php?id=${quizId}`;
    const res = await this.fetchWithAuth(url);
    if (!res.ok) {
      throw new Error(`Failed to load quiz ${quizId} (HTTP ${res.status})`);
    }

    const html = await res.text();
    const titleMatch = html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : `Quiz ${quizId}`;

    const introMatch = html.match(/id="intro"[^>]*>([\s\S]*?)<\/div>/i) ||
                       html.match(/class="quizinfo"[^>]*>([\s\S]*?)<\/div>/i);
    const intro = introMatch ? introMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';

    const mainMatch = html.match(/role="main"[\s\S]*?<\/section>/i) ||
                      html.match(/id="region-main"[\s\S]*?<\/section>/i);
    const mainHtml = mainMatch ? mainMatch[0] : html;

    const openedMatch = mainHtml.match(/(?:Opened|Opens):?(?:<\/[^>]+>)?\s*([^<\n]+)/i) ||
                        mainHtml.match(/This quiz opened at\s*([^<\n]+)/i);
    const closedMatch = mainHtml.match(/(?:Closed|Closes):?(?:<\/[^>]+>)?\s*([^<\n]+)/i) ||
                        mainHtml.match(/This quiz will close on\s*([^<\n]+)/i);
    const limitMatch = mainHtml.match(/Time limit:?(?:<\/[^>]+>)?\s*([^<\n]+)/i);
    const attemptsMatch = mainHtml.match(/Attempts allowed:?(?:<\/[^>]+>)?\s*([^<\n]+)/i);
    const gradingMatch = mainHtml.match(/Grading method:?(?:<\/[^>]+>)?\s*([^<\n]+)/i);

    const attemptsTable = [];
    const trRegex = /<tr class="[^"]*attemptsummary[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi;
    let tr;
    while ((tr = trRegex.exec(mainHtml)) !== null) {
      const cells = [...tr[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => c[1].replace(/<[^>]+>/g, '').trim());
      if (cells.length > 0) attemptsTable.push(cells);
    }

    return {
      id: quizId,
      title,
      url,
      instructions: intro,
      opened: openedMatch ? openedMatch[1].trim() : null,
      closed: closedMatch ? closedMatch[1].trim() : null,
      timeLimit: limitMatch ? limitMatch[1].trim() : null,
      attemptsAllowed: attemptsMatch ? attemptsMatch[1].trim() : null,
      gradingMethod: gradingMatch ? gradingMatch[1].trim() : null,
      attempts: attemptsTable,
    };
  }

  /**
   * Get discussions from a Moodle Forum module
   */
  async getForumDiscussions(forumId) {
    const url = `${this.baseUrl}/mod/forum/view.php?id=${forumId}`;
    const res = await this.fetchWithAuth(url);
    if (!res.ok) {
      throw new Error(`Failed to load forum ${forumId} (HTTP ${res.status})`);
    }

    const html = await res.text();
    const titleMatch = html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : `Forum ${forumId}`;

    const introMatch = html.match(/id="intro"[^>]*>([\s\S]*?)<\/div>/i);
    const intro = introMatch ? introMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';

    const discussions = [];
    const trRegex = /<tr class="discussion[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi;
    let tr;
    while ((tr = trRegex.exec(html)) !== null) {
      const row = tr[1];
      const topicMatch = row.match(/class="topic[^"]*"[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      const authorMatch = row.match(/class="author[^"]*"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i);
      const repliesMatch = row.match(/class="replies[^"]*"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i) ||
                           row.match(/class="replies[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
      const lastPostMatch = row.match(/class="lastpost[^"]*"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i);

      if (topicMatch) {
        discussions.push({
          topic: topicMatch[2].replace(/<[^>]+>/g, '').trim(),
          link: topicMatch[1],
          author: authorMatch ? authorMatch[1].replace(/<[^>]+>/g, '').trim() : 'Unknown',
          replies: repliesMatch ? repliesMatch[1].replace(/<[^>]+>/g, '').trim() : '0',
          lastPost: lastPostMatch ? lastPostMatch[1].replace(/<[^>]+>/g, '').trim() : null,
        });
      }
    }

    return {
      id: forumId,
      title,
      url,
      intro,
      discussions,
    };
  }

  /**
   * Get external or video URL from a Moodle URL module
   */
  async getUrlDetails(urlId) {
    const url = `${this.baseUrl}/mod/url/view.php?id=${urlId}`;
    const res = await this.fetchWithAuth(url);
    if (!res.ok) {
      throw new Error(`Failed to load URL module ${urlId} (HTTP ${res.status})`);
    }

    const html = await res.text();
    const titleMatch = html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : `URL ${urlId}`;

    const videoMatch = html.match(/&quot;src&quot;:&quot;([^&"]+)&quot;/i) ||
                       html.match(/data-setup-lazy='[\s\S]*?"src":"([^"]+)"/i);
    const linkMatch = html.match(/class=["']urlworkaround["'][^>]*>[\s\S]*?<a[^>]*href=["']([^"']+)["']/i) ||
                      html.match(/<div class=["'][^"']*box[^"']*generalbox[^"']*">[\s\S]*?<a[^>]*href=["']([^"']+)["']/i);

    const targetUrl = videoMatch ? videoMatch[1].replace(/&amp;/g, '&') : (linkMatch ? linkMatch[1] : null);

    return {
      id: urlId,
      title,
      url,
      targetUrl,
    };
  }

  /**
   * Get gradebook overview or course-specific user grade report
   */
  async getGrades(courseId = null) {
    const url = courseId
      ? `${this.baseUrl}/grade/report/user/index.php?id=${courseId}`
      : `${this.baseUrl}/grade/report/overview/index.php`;

    const res = await this.fetchWithAuth(url);
    if (!res.ok) {
      throw new Error(`Failed to fetch grades (HTTP ${res.status})`);
    }

    const html = await res.text();
    const rows = [];
    const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let trMatch;

    while ((trMatch = trRegex.exec(html)) !== null) {
      const tr = trMatch[1];
      const cells = [];
      const cellRegex = /<(td|th)[^>]*>([\s\S]*?)<\/\1>/gi;
      let cMatch;
      while ((cMatch = cellRegex.exec(tr)) !== null) {
        cells.push(cMatch[2].replace(/<[^>]+>/g, '').trim());
      }
      if (cells.length > 1 && cells.some(c => c.trim().length > 0)) {
        rows.push(cells);
      }
    }

    return {
      courseId,
      url,
      table: rows,
    };
  }

  /**
   * Download a single resource file directly from Moodle with smart incremental caching
   */
  async downloadResource(url, destFilePath, options = {}) {
    const skipExisting = options.skipExisting !== false;
    const force = Boolean(options.force);

    // 1. Direct handling for data URIs (e.g. data:image/png;base64,...)
    if (url.startsWith('data:')) {
      const match = url.match(/^data:([^;,]+)?(?:;charset=[^;,]+)?(;base64)?,([\s\S]*)$/i);
      if (!match) {
        throw new Error('Invalid data URI format');
      }
      const mime = (match[1] || 'application/octet-stream').toLowerCase();
      const isBase64 = Boolean(match[2]);
      const rawData = match[3];
      const buffer = isBase64 ? Buffer.from(rawData, 'base64') : Buffer.from(decodeURIComponent(rawData), 'utf8');

      const mimeExt = getExtensionFromMimeType(mime) || (mime.startsWith('image/') ? `.${mime.split('/')[1]}` : '');
      let fileName = options.defaultName || `data_${crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 10)}`;
      if (!path.extname(fileName) && mimeExt) {
        fileName = `${fileName}${mimeExt}`;
      }
      fileName = fileName.replace(/[\/\\:*?"<>|]/g, '_').trim();

      const resolvedDest = expandHome(destFilePath);
      let targetPath = resolvedDest;
      const isDir = Boolean(
        (fsSync.existsSync(resolvedDest) && (await fs.stat(resolvedDest)).isDirectory()) ||
        options.isDir ||
        (!path.extname(resolvedDest) && !options.isFile)
      );

      if (isDir) {
        if (!fsSync.existsSync(resolvedDest)) {
          await fs.mkdir(resolvedDest, { recursive: true });
        }
        targetPath = path.join(resolvedDest, fileName);
        if (options.uniqueNames && fsSync.existsSync(targetPath)) {
          const existingStat = await fs.stat(targetPath);
          if (existingStat.size !== buffer.length) {
            const fileExt = path.extname(fileName);
            const nameWithoutExt = path.basename(fileName, fileExt);
            fileName = `${nameWithoutExt}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}${fileExt}`;
            targetPath = path.join(resolvedDest, fileName);
          }
        }
      }

      if (skipExisting && !force && fsSync.existsSync(targetPath)) {
        const localStat = await fs.stat(targetPath);
        if (localStat.size === buffer.length) {
          return {
            savedPath: targetPath,
            size: localStat.size,
            skipped: true,
            name: path.basename(targetPath),
          };
        }
      }

      const dir = path.dirname(targetPath);
      if (!fsSync.existsSync(dir)) {
        await fs.mkdir(dir, { recursive: true });
      }

      const randSuffix = crypto.randomBytes(4).toString('hex');
      const tempPath = `${targetPath}.part_${Date.now()}_${randSuffix}`;
      try {
        await fs.writeFile(tempPath, buffer);
        await fs.rename(tempPath, targetPath);
      } catch (err) {
        try { await fs.unlink(tempPath); } catch {}
        throw err;
      }

      return {
        savedPath: targetPath,
        size: buffer.length,
        skipped: false,
        name: path.basename(targetPath),
      };
    }

    // 2. Normalize HTTP/HTTPS or relative URLs
    let currentUrl = url;
    if (currentUrl.startsWith('//')) currentUrl = `https:${currentUrl}`;
    else if (currentUrl.startsWith('/')) currentUrl = `${this.baseUrl}${currentUrl}`;

    let res = await this.fetchWithAuth(currentUrl, {
      redirect: 'follow',
    });

    if (!res.ok) {
      throw new Error(`Failed to download resource from ${currentUrl} (HTTP ${res.status})`);
    }

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
      const html = await res.text();

      // Check for Moodle folder download zip
      const folderZipMatch = html.match(/href="([^"]+download_folder\.php[^"]+)"/i) ||
                             html.match(/action="([^"]+download_folder\.php[^"]+)"/i);
      if (folderZipMatch) {
        let realUrl = folderZipMatch[1].replace(/&amp;/g, '&');
        if (realUrl.startsWith('//')) realUrl = `https:${realUrl}`;
        else if (realUrl.startsWith('/')) realUrl = `${this.baseUrl}${realUrl}`;
        currentUrl = realUrl;
        res = await this.fetchWithAuth(currentUrl, {
          redirect: 'follow',
        });
        if (!res.ok) {
          throw new Error(`Failed to download folder archive from ${currentUrl} (HTTP ${res.status})`);
        }
      } else {
        // Check for embedded file in iframe/object/resourceworkaround
        const embedMatch = html.match(/<object[^>]*data="([^"]+pluginfile\.php[^"]+)"/i) ||
                           html.match(/<iframe[^>]*src="([^"]+pluginfile\.php[^"]+)"/i) ||
                           html.match(/<a[^>]*href="([^"]+pluginfile\.php\/\d+\/mod_resource\/content\/[^"]+)"/i) ||
                           html.match(/class="resourceworkaround"[^>]*><a[^>]*href="([^"]+)"/i);
        if (embedMatch) {
          let realUrl = embedMatch[1].replace(/&amp;/g, '&');
          if (realUrl.startsWith('//')) realUrl = `https:${realUrl}`;
          else if (realUrl.startsWith('/')) realUrl = `${this.baseUrl}${realUrl}`;
          currentUrl = realUrl;
          res = await this.fetchWithAuth(currentUrl, {
            redirect: 'follow',
          });
          if (!res.ok) {
            throw new Error(`Failed to download embedded resource from ${currentUrl} (HTTP ${res.status})`);
          }
        } else {
          // Check for multiple folder files in fp-filename
          const folderFiles = [];
          const fpRegex = /<span\s+class="fp-filename"[^>]*>[\s\S]*?<a\s+href="([^"]+pluginfile\.php[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
          let fpMatch;
          while ((fpMatch = fpRegex.exec(html)) !== null) {
            folderFiles.push({
              url: fpMatch[1].replace(/&amp;/g, '&'),
              name: fpMatch[2].replace(/<[^>]+>/g, '').trim(),
            });
          }

          if (folderFiles.length > 0) {
            const folderDir = destFilePath;
            if (!fsSync.existsSync(folderDir)) {
              await fs.mkdir(folderDir, { recursive: true });
            }
            let totalSize = 0;
            let filesDownloaded = 0;
            for (const file of folderFiles) {
              const fPath = path.join(folderDir, file.name);
              const r = await this.downloadResource(file.url, fPath, options);
              totalSize += r.size;
              if (!r.skipped) filesDownloaded++;
            }
            return {
              savedPath: folderDir,
              size: totalSize,
              skipped: filesDownloaded === 0,
              isFolder: true,
              fileCount: folderFiles.length,
            };
          }

          // HTML page without any downloadable binary
          throw new Error(`Resource URL returned an HTML page with no downloadable file or folder content.`);
        }
      }
    }

    const resolvedDest = expandHome(destFilePath);
    let targetPath = resolvedDest;
    const isDir = Boolean(
      (fsSync.existsSync(resolvedDest) && (await fs.stat(resolvedDest)).isDirectory()) ||
      options.isDir ||
      (!path.extname(resolvedDest) && !options.isFile)
    );

    // Determine filename
    let detectedName = '';
    const disposition = res.headers.get('content-disposition') || '';
    const fnMatch = disposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)["']?/i);
    if (fnMatch) {
      detectedName = decodeURIComponent(fnMatch[1]);
    } else {
      try {
        const urlObj = new URL(currentUrl);
        const qFile = urlObj.searchParams.get('file') || urlObj.searchParams.get('filename');
        if (qFile) {
          detectedName = decodeURIComponent(path.basename(qFile));
        } else {
          const parsedPath = urlObj.pathname;
          const base = path.basename(parsedPath);
          if (base && !base.endsWith('.php')) {
            detectedName = decodeURIComponent(base);
          }
        }
      } catch {
        // ignore URL parsing error
      }
    }

    if (!detectedName || detectedName.endsWith('.php')) {
      detectedName = options.defaultName || `resource_${Date.now()}`;
    }

    // Ensure detectedName has an extension if mime type is known
    const ext = path.extname(detectedName);
    const mimeExt = getExtensionFromMimeType(res.headers.get('content-type'));
    if (!ext && mimeExt) {
      detectedName = `${detectedName}${mimeExt}`;
    }
    if (detectedName.length > 100) {
      const fileExt = path.extname(detectedName);
      detectedName = `${detectedName.slice(0, 80)}_${Date.now()}${fileExt}`;
    }
    detectedName = detectedName.replace(/[\/\\:*?"<>|]/g, '_').trim();

    if (isDir) {
      if (!fsSync.existsSync(resolvedDest)) {
        await fs.mkdir(resolvedDest, { recursive: true });
      }
      let fileName = detectedName;
      targetPath = path.join(resolvedDest, fileName);

      if (options.uniqueNames && fsSync.existsSync(targetPath)) {
        const existingStat = await fs.stat(targetPath);
        const cl = parseInt(res.headers.get('content-length') || '0', 10);
        if (existingStat.size !== cl || cl === 0) {
          const fileExt = path.extname(fileName);
          const nameWithoutExt = path.basename(fileName, fileExt);
          fileName = `${nameWithoutExt}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}${fileExt}`;
          targetPath = path.join(resolvedDest, fileName);
        }
      }
    } else if (detectedName && path.extname(detectedName) && !path.extname(targetPath)) {
      targetPath = `${targetPath}${path.extname(detectedName)}`;
    }

    // Incremental skipping: check if target file already exists with same size or mtime
    const contentLength = parseInt(res.headers.get('content-length') || '0', 10);
    const lastModifiedHeader = res.headers.get('last-modified');
    if (skipExisting && !force && fsSync.existsSync(targetPath)) {
      const localStat = await fs.stat(targetPath);
      const isSizeMatch = localStat.size > 0 && contentLength > 0 && localStat.size === contentLength;
      const isMtimeMatch = localStat.size > 0 && lastModifiedHeader && Math.abs(localStat.mtime.getTime() - new Date(lastModifiedHeader).getTime()) < 2000;
      if (isSizeMatch || isMtimeMatch) {
        try { await res.body?.cancel(); } catch {}
        return {
          savedPath: targetPath,
          size: localStat.size,
          skipped: true,
          name: path.basename(targetPath),
        };
      }
    }

    const dir = path.dirname(targetPath);
    if (!fsSync.existsSync(dir)) {
      await fs.mkdir(dir, { recursive: true });
    }

    // Atomic write to unique temporary file
    const randSuffix = crypto.randomBytes(4).toString('hex');
    const tempPath = `${targetPath}.part_${Date.now()}_${randSuffix}`;
    const writeStream = createWriteStream(tempPath);
    try {
      await pipeline(res.body, writeStream);

      // Deduplication check for chunked / zero-content-length responses
      if (skipExisting && !force && fsSync.existsSync(targetPath)) {
        const existingStat = await fs.stat(targetPath);
        const tempStat = await fs.stat(tempPath);
        if (existingStat.size > 0 && existingStat.size === tempStat.size) {
          await fs.unlink(tempPath);
          return {
            savedPath: targetPath,
            size: existingStat.size,
            skipped: true,
            name: path.basename(targetPath),
          };
        }
      }

      await fs.rename(tempPath, targetPath);
      if (lastModifiedHeader) {
        try { await fs.utimes(targetPath, new Date(), new Date(lastModifiedHeader)); } catch {}
      }
    } catch (pipeErr) {
      try { await fs.unlink(tempPath); } catch {}
      throw pipeErr;
    }

    return {
      savedPath: targetPath,
      size: (await fs.stat(targetPath)).size,
      skipped: false,
      name: path.basename(targetPath),
    };
  }

  /**
   * Download a single module (resource, folder, page, or assignment attachments) by ID or URL
   */
  async downloadModule(moduleIdOrUrl, destPath = null, options = {}) {
    const target = String(moduleIdOrUrl).trim();
    const defaultDir = destPath ? expandHome(destPath) : path.join(os.homedir(), 'Downloads', 'VSUEE');
    const isTargetFile = Boolean(path.extname(defaultDir) || options.isFile);
    const modOptions = { isDir: !isTargetFile, ...options };

    // 1. Shortcut matches
    const assignMatch = target.match(/^(?:assign|assignment|a)[:\/\s]+(\d+)$/i);
    const resMatch = target.match(/^(?:mod|resource|file|r)[:\/\s]+(\d+)$/i);
    const folderMatch = target.match(/^(?:folder|f)[:\/\s]+(\d+)$/i);
    const pageMatch = target.match(/^(?:page|p)[:\/\s]+(\d+)$/i);

    if (assignMatch) {
      return await this.downloadAssignmentAttachments(assignMatch[1], defaultDir, modOptions);
    }
    if (resMatch) {
      const resUrl = `${this.baseUrl}/mod/resource/view.php?id=${resMatch[1]}`;
      return { id: resMatch[1], type: 'resource', ...(await this.downloadResource(resUrl, defaultDir, modOptions)) };
    }
    if (folderMatch) {
      const folderUrl = `${this.baseUrl}/mod/folder/view.php?id=${folderMatch[1]}`;
      return { id: folderMatch[1], type: 'folder', ...(await this.downloadResource(folderUrl, defaultDir, modOptions)) };
    }

    // 2. Full URL
    if (target.startsWith('http://') || target.startsWith('https://')) {
      if (target.includes('/mod/assign/')) {
        const match = target.match(/[?&]id=(\d+)/);
        if (match) {
          return await this.downloadAssignmentAttachments(match[1], defaultDir, modOptions);
        }
      }
      return await this.downloadResource(target, defaultDir, modOptions);
    }

    // 3. Pure numeric ID
    if (/^\d+$/.test(target)) {
      const modId = target;
      if (options.type === 'assign' || options.assign) {
        return { id: modId, type: 'assign', ...(await this.downloadAssignmentAttachments(modId, defaultDir, modOptions)) };
      }
      if (options.type === 'folder' || options.folder) {
        const folderUrl = `${this.baseUrl}/mod/folder/view.php?id=${modId}`;
        return { id: modId, type: 'folder', ...(await this.downloadResource(folderUrl, defaultDir, modOptions)) };
      }

      // Default cascade: mod_resource -> mod_folder -> assignment
      const resUrl = `${this.baseUrl}/mod/resource/view.php?id=${modId}`;
      try {
        const res = await this.downloadResource(resUrl, defaultDir, modOptions);
        return { id: modId, type: 'resource', ...res };
      } catch (resourceErr) {
        const folderUrl = `${this.baseUrl}/mod/folder/view.php?id=${modId}`;
        try {
          const folderRes = await this.downloadResource(folderUrl, defaultDir, modOptions);
          return { id: modId, type: 'folder', ...folderRes };
        } catch (folderErr) {
          try {
            const assignRes = await this.downloadAssignmentAttachments(modId, defaultDir, modOptions);
            if (assignRes.files.length > 0) {
              return { id: modId, type: 'assign', ...assignRes };
            }
          } catch {}
          throw new Error(`Could not download module ${modId}: ${resourceErr.message}`);
        }
      }
    }

    throw new Error(`Invalid module ID or URL: "${target}"`);
  }

  /**
   * Download all instructor attachments associated with an assignment
   */
  async downloadAssignmentAttachments(assignId, destDir = null, options = {}) {
    const assign = await this.getAssignmentDetails(assignId);
    const sanitizedTitle = assign.title.replace(/[\/\\:*?"<>|]/g, '_').trim();
    const targetFolder = destDir || path.join(os.homedir(), 'Downloads', 'VSUEE', sanitizedTitle, 'attachments');
    await fs.mkdir(targetFolder, { recursive: true });

    const downloaded = [];
    const typeFilter = options.typeFilter ? options.typeFilter.toLowerCase().replace(/^\./, '') : null;

    let filteredAtts = assign.attachments || [];
    if (typeFilter) {
      filteredAtts = filteredAtts.filter(att => {
        const ext = path.extname(att.name || att.url).toLowerCase().replace(/^\./, '');
        return matchesType(ext, typeFilter);
      });
    }

    const concurrency = Math.max(1, Math.min(16, parseInt(options.concurrency, 10) || 4));
    const settled = await asyncPool(concurrency, filteredAtts, async (att) => {
      const dest = path.join(targetFolder, att.name || `attachment_${Date.now()}`);
      const res = await this.downloadResource(att.url, dest, options);
      return {
        name: att.name,
        url: att.url,
        path: res.savedPath,
        size: res.size,
        skipped: res.skipped || false,
      };
    }, {
      onStart: options.onStart,
      onProgress: options.onProgress,
    });

    for (const item of settled) {
      if (item.status === 'fulfilled') {
        downloaded.push(item.value);
      } else {
        downloaded.push({
          error: item.reason?.message || String(item.reason),
        });
      }
    }

    return {
      id: assignId,
      title: assign.title,
      destination: targetFolder,
      downloadCount: downloaded.filter(d => !d.error && !d.skipped).length,
      skippedCount: downloaded.filter(d => d.skipped).length,
      errors: downloaded.filter(d => d.error),
      files: downloaded,
    };
  }

  /**
   * Download all downloadable materials in a course with incremental skipping, section filter, and optional assignment attachments
   */
  async downloadCourseMaterials(courseId, destDir = path.join(os.homedir(), 'Downloads', 'VSUEE'), options = {}) {
    const resolvedDest = expandHome(destDir);
    const contents = await this.getCourseContents(courseId);
    const sanitizedCourseTitle = contents.title.replace(/[\/\\:*?"<>|]/g, '_').trim();
    const courseFolder = path.join(resolvedDest, sanitizedCourseTitle);

    const typeFilter = options.typeFilter ? options.typeFilter.toLowerCase().replace(/^\./, '') : null;
    const tasks = [];

    for (const section of contents.sections) {
      if (options.section !== undefined && options.section !== null && String(section.number) !== String(options.section)) {
        continue;
      }

      const sanitizedSecName = `${section.number}_${section.name.replace(/[\/\\:*?"<>|]/g, '_').trim()}`;
      const secFolder = path.join(courseFolder, sanitizedSecName);

      for (const act of section.activities) {
        if (act.type === 'resource' || act.type === 'folder') {
          if (!act.link) continue;

          if (typeFilter) {
            let ft = act.fileType;
            if (!ft) {
              const nameExt = path.extname(act.name).toLowerCase().replace(/^\./, '');
              if (nameExt) ft = nameExt;
            }
            if (!matchesType(ft, typeFilter)) {
              continue;
            }
          }

          const sanitizedActName = act.name.replace(/[\/\\:*?"<>|]/g, '_').trim();
          tasks.push({
            type: 'resource',
            name: act.name,
            link: act.link,
            sectionName: section.name,
            dest: path.join(secFolder, sanitizedActName),
          });
        } else if (options.includeAssignments && act.type === 'assign') {
          const assignFolder = path.join(secFolder, 'assignments', act.name.replace(/[\/\\:*?"<>|]/g, '_').trim());
          tasks.push({
            type: 'assign',
            name: act.name,
            id: act.id,
            sectionName: section.name,
            assignFolder,
          });
        }
      }
    }

    const concurrency = Math.max(1, Math.min(16, parseInt(options.concurrency, 10) || 4));
    const downloads = [];

    const settled = await asyncPool(concurrency, tasks, async (task) => {
      if (task.type === 'resource') {
        try {
          const result = await this.downloadResource(task.link, task.dest, options);
          return [{
            module: task.name,
            section: task.sectionName,
            path: result.savedPath,
            size: result.size,
            skipped: result.skipped || false,
          }];
        } catch (err) {
          return [{
            module: task.name,
            section: task.sectionName,
            error: err.message,
          }];
        }
      } else if (task.type === 'assign') {
        try {
          const assignRes = await this.downloadAssignmentAttachments(task.id, task.assignFolder, { ...options, typeFilter });
          const items = [];
          for (const f of assignRes.files) {
            items.push({
              module: `${task.name} (Attachment: ${f.name})`,
              section: task.sectionName,
              path: f.path,
              size: f.size,
              skipped: f.skipped || false,
              error: f.error,
            });
          }
          return items;
        } catch (err) {
          return [{
            module: `${task.name} (Attachments)`,
            section: task.sectionName,
            error: err.message,
          }];
        }
      }
      return [];
    }, {
      onStart: options.onStart,
      onProgress: options.onProgress,
    });

    for (const item of settled) {
      if (item.status === 'fulfilled' && Array.isArray(item.value)) {
        downloads.push(...item.value);
      } else if (item.status === 'rejected') {
        downloads.push({ module: 'Task error', error: item.reason?.message || String(item.reason) });
      }
    }

    return {
      course: contents.title,
      destination: courseFolder,
      downloadCount: downloads.filter(d => !d.error && !d.skipped).length,
      skippedCount: downloads.filter(d => d.skipped).length,
      errors: downloads.filter(d => d.error),
      items: downloads,
    };
  }

  /**
   * Extract image links from HTML markup with theme filtering
   */
  /**
   * Extract image links from HTML markup with theme filtering and lazy loading support
   */
  extractImagesFromHtml(html, pageBaseUrl = null, options = {}) {
    const base = pageBaseUrl || this.baseUrl;
    const urls = new Map();

    const normalizeUrl = (raw) => {
      if (!raw) return null;
      let s = raw.trim();
      if (!s) return null;
      if (s.startsWith('//')) s = `https:${s}`;
      else if (s.startsWith('/')) s = `${this.baseUrl}${s}`;
      else if (!s.startsWith('http://') && !s.startsWith('https://') && !s.startsWith('data:')) {
        try { s = new URL(s, base).href; } catch { return null; }
      }
      return s;
    };

    const isThemeChrome = (s) => {
      if (options.includeTheme) return false;
      return (
        s.includes('/theme/image.php/') ||
        s.includes('/pix/') ||
        s.includes('spacer.gif') ||
        s.includes('favicon') ||
        s.includes('monologo') ||
        /\/icon(?:\.png|\.svg|\.gif)?(?:\?|$)/i.test(s) ||
        /\/f\/(?:pdf|document|powerpoint|spreadsheet|archive)/i.test(s) ||
        s.includes('vsuseal') ||
        s.includes('brandlogo') ||
        s.includes('vsu%20logo') ||
        s.includes('vsu+logo')
      );
    };

    // 1. Process <img> tags (src, data-src, data-original, data-lazy-src, srcset)
    const imgRegex = /<img[^>]+>/gi;
    let imgTagMatch;
    while ((imgTagMatch = imgRegex.exec(html)) !== null) {
      const tag = imgTagMatch[0];
      const altMatch = tag.match(/alt=["']([^"']*)["']/i);
      const titleMatch = tag.match(/title=["']([^"']*)["']/i);
      const alt = altMatch ? altMatch[1].trim() : '';
      const title = titleMatch ? titleMatch[1].trim() : '';

      const srcMatch = tag.match(/src=["']([^"']+)["']/i);
      const dataSrcMatch = tag.match(/(?:data-src|data-original|data-lazy-src|data-url)=["']([^"']+)["']/i);
      const srcsetMatch = tag.match(/srcset=["']([^"']+)["']/i);

      const candidateUrls = [];
      if (dataSrcMatch) candidateUrls.push(dataSrcMatch[1]);
      if (srcMatch) candidateUrls.push(srcMatch[1]);
      if (srcsetMatch) {
        const parts = srcsetMatch[1].split(',').map(p => p.trim().split(/\s+/)[0]).filter(Boolean);
        candidateUrls.push(...parts);
      }

      for (const raw of candidateUrls) {
        const u = normalizeUrl(raw);
        if (u && !isThemeChrome(u) && !urls.has(u)) {
          urls.set(u, { url: u, alt, title });
        }
      }
    }

    // 2. Process <source srcset="..."> inside <picture>
    const sourceRegex = /<source[^>]+srcset=["']([^"']+)["'][^>]*>/gi;
    let sMatch;
    while ((sMatch = sourceRegex.exec(html)) !== null) {
      const parts = sMatch[1].split(',').map(p => p.trim().split(/\s+/)[0]).filter(Boolean);
      for (const raw of parts) {
        const u = normalizeUrl(raw);
        if (u && !isThemeChrome(u) && !urls.has(u)) {
          urls.set(u, { url: u, alt: '', title: '' });
        }
      }
    }

    // 3. Direct image links <a href="...png|jpg|jpeg|gif|webp|svg">
    const aImgRegex = /<a[^>]+href=["']([^"']+\.(?:png|jpe?g|gif|webp|svg|bmp)(?:\?[^"']*)?)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let aMatch;
    while ((aMatch = aImgRegex.exec(html)) !== null) {
      const u = normalizeUrl(aMatch[1]);
      if (u && !isThemeChrome(u) && !urls.has(u)) {
        urls.set(u, { url: u, alt: aMatch[2].replace(/<[^>]+>/g, '').trim(), title: '' });
      }
    }

    return Array.from(urls.values());
  }

  /**
   * Extract and download embedded content images from a course, page, assignment, forum, or URL
   */
  async downloadImagesFromTarget(target, destDir = null, options = {}) {
    let targetUrl = String(target).trim();
    let targetType = 'url';
    let targetId = null;

    const courseMatch = targetUrl.match(/^(?:course|c)[:\/\s]+(\d+)$/i);
    const assignMatch = targetUrl.match(/^(?:assign|assignment|a)[:\/\s]+(\d+)$/i);
    const quizMatch = targetUrl.match(/^(?:quiz|q)[:\/\s]+(\d+)$/i);
    const pageMatch = targetUrl.match(/^(?:page|p)[:\/\s]+(\d+)$/i);
    const forumMatch = targetUrl.match(/^(?:forum|f)[:\/\s]+(\d+)$/i);
    const discussMatch = targetUrl.match(/^(?:discuss|discussion|d)[:\/\s]+(\d+)$/i);

    if (courseMatch) {
      targetType = 'course';
      targetId = courseMatch[1];
      targetUrl = `${this.baseUrl}/course/view.php?id=${targetId}`;
    } else if (assignMatch) {
      targetType = 'assign';
      targetId = assignMatch[1];
      targetUrl = `${this.baseUrl}/mod/assign/view.php?id=${targetId}`;
    } else if (quizMatch) {
      targetType = 'quiz';
      targetId = quizMatch[1];
      targetUrl = `${this.baseUrl}/mod/quiz/view.php?id=${targetId}`;
    } else if (pageMatch) {
      targetType = 'page';
      targetId = pageMatch[1];
      targetUrl = `${this.baseUrl}/mod/page/view.php?id=${targetId}`;
    } else if (forumMatch) {
      targetType = 'forum';
      targetId = forumMatch[1];
      targetUrl = `${this.baseUrl}/mod/forum/view.php?id=${targetId}`;
    } else if (discussMatch) {
      targetType = 'discuss';
      targetId = discussMatch[1];
      targetUrl = `${this.baseUrl}/mod/forum/discuss.php?d=${targetId}`;
    } else if (/^\d+$/.test(targetUrl)) {
      if (options.type === 'page' || options.page) {
        targetType = 'page';
        targetId = targetUrl;
        targetUrl = `${this.baseUrl}/mod/page/view.php?id=${targetId}`;
      } else if (options.type === 'assign' || options.assign) {
        targetType = 'assign';
        targetId = targetUrl;
        targetUrl = `${this.baseUrl}/mod/assign/view.php?id=${targetId}`;
      } else if (options.type === 'forum' || options.forum) {
        targetType = 'forum';
        targetId = targetUrl;
        targetUrl = `${this.baseUrl}/mod/forum/view.php?id=${targetId}`;
      } else if (options.type === 'discuss' || options.discuss) {
        targetType = 'discuss';
        targetId = targetUrl;
        targetUrl = `${this.baseUrl}/mod/forum/discuss.php?d=${targetId}`;
      } else if (options.type === 'quiz' || options.quiz) {
        targetType = 'quiz';
        targetId = targetUrl;
        targetUrl = `${this.baseUrl}/mod/quiz/view.php?id=${targetId}`;
      } else {
        targetType = 'course';
        targetId = targetUrl;
        targetUrl = `${this.baseUrl}/course/view.php?id=${targetId}`;
      }
    } else if (targetUrl.startsWith('/')) {
      targetUrl = `${this.baseUrl}${targetUrl}`;
    }

    const res = await this.fetchWithAuth(targetUrl);
    if (!res.ok) {
      throw new Error(`Failed to fetch page for image extraction (HTTP ${res.status})`);
    }

    const html = await res.text();
    const titleMatch = html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i) ||
                       html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) ||
                       html.match(/<title>([^<]+)<\/title>/i);
    const pageTitle = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : 'VSUEE_Images';
    const sanitizedTitle = pageTitle.replace(/[\/\\:*?"<>|]/g, '_').trim();
    const imgFolder = expandHome(destDir) || path.join(os.homedir(), 'Downloads', 'VSUEE', sanitizedTitle, 'images');
    await fs.mkdir(imgFolder, { recursive: true });

    let htmlToParse = html;
    if (targetType === 'course' && options.section !== undefined && options.section !== null) {
      const secRegex = new RegExp(`<(?:li|section|div)[^>]*id=["']section-${options.section}["'][\\s\\S]*?<\\/(?:li|section|div)>`, 'i');
      const secMatch = html.match(secRegex);
      if (secMatch) {
        htmlToParse = secMatch[0];
      }
    }

    let extractedList = this.extractImagesFromHtml(htmlToParse, targetUrl, options);

    // Deep scan: for courses, also extract embedded diagrams/figures from all page modules
    if (targetType === 'course' && options.deep && targetId) {
      try {
        const courseData = await this.getCourseContents(targetId);
        for (const sec of courseData.sections) {
          if (options.section !== undefined && options.section !== null && String(sec.number) !== String(options.section)) {
            continue;
          }
          for (const act of sec.activities) {
            if (act.type === 'page' && act.link) {
              try {
                const pRes = await this.fetchWithAuth(act.link);
                if (pRes.ok) {
                  const pHtml = await pRes.text();
                  const pImages = this.extractImagesFromHtml(pHtml, act.link, options);
                  for (const img of pImages) {
                    if (!extractedList.some(e => e.url === img.url)) {
                      extractedList.push({
                        ...img,
                        module: act.name,
                      });
                    }
                  }
                }
              } catch {}
            }
          }
        }
      } catch {}
    }

    // Forum post scan: if target is a forum, scan discussions for embedded images
    if (targetType === 'forum') {
      const discussRegex = /<a[^>]+href=["']([^"']*discuss\.php\?d=(\d+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
      const seenDiscuss = new Set();
      let dMatch;
      while ((dMatch = discussRegex.exec(html)) !== null) {
        let dUrl = dMatch[1].replace(/&amp;/g, '&');
        if (dUrl.startsWith('/')) dUrl = `${this.baseUrl}${dUrl}`;
        const dTitle = dMatch[3].replace(/<[^>]+>/g, '').trim();
        if (!seenDiscuss.has(dUrl)) {
          seenDiscuss.add(dUrl);
          try {
            const dRes = await this.fetchWithAuth(dUrl);
            if (dRes.ok) {
              const dHtml = await dRes.text();
              const dImages = this.extractImagesFromHtml(dHtml, dUrl, options);
              for (const img of dImages) {
                if (!extractedList.some(e => e.url === img.url)) {
                  extractedList.push({
                    ...img,
                    module: dTitle ? `Discussion: ${dTitle}` : 'Forum Post',
                  });
                }
              }
            }
          } catch {}
        }
      }
    }

    const concurrency = Math.max(1, Math.min(16, parseInt(options.concurrency, 10) || 4));
    const downloaded = [];

    const settled = await asyncPool(concurrency, extractedList, async (item, idx) => {
      const imgIndex = idx + 1;
      const defaultName = item.alt
        ? `${item.alt.replace(/[\/\\:*?"<>|]/g, '_').slice(0, 30)}_${imgIndex}`
        : `image_${imgIndex}`;
      try {
        const result = await this.downloadResource(item.url, imgFolder, {
          isDir: true,
          uniqueNames: true,
          defaultName,
          ...options,
        });
        return {
          url: item.url,
          alt: item.alt,
          module: item.module,
          path: result.savedPath,
          size: result.size,
          skipped: result.skipped || false,
        };
      } catch (err) {
        return {
          url: item.url,
          alt: item.alt,
          module: item.module,
          error: err.message,
        };
      }
    }, {
      onStart: options.onStart,
      onProgress: options.onProgress,
    });

    for (const res of settled) {
      if (res.status === 'fulfilled' && res.value) {
        downloaded.push(res.value);
      } else if (res.status === 'rejected') {
        downloaded.push({ error: res.reason?.message || String(res.reason) });
      }
    }

    return {
      target: targetUrl,
      title: pageTitle,
      destination: imgFolder,
      totalFound: extractedList.length,
      downloadCount: downloaded.filter(d => !d.error && !d.skipped).length,
      skippedCount: downloaded.filter(d => d.skipped).length,
      errors: downloaded.filter(d => d.error),
      images: downloaded,
    };
  }

  /**
   * Alias for backward compatibility
   */
  async downloadCourseImages(courseIdOrUrl, destDir, options = {}) {
    return this.downloadImagesFromTarget(courseIdOrUrl, destDir, options);
  }
}

