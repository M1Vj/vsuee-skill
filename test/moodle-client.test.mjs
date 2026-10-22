import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsSync from 'node:fs';
import { MoodleClient, expandHome, getMimeType } from '../lib/moodle-client.mjs';

test('MoodleClient session management and headers', async () => {
  const client = new MoodleClient();
  client.sessionCookie = 'testcookie123';
  const headers = client.getHeaders();
  assert.equal(headers['Cookie'], 'MoodleSession=testcookie123');
  assert.equal(typeof headers['User-Agent'], 'string');
});

test('MoodleClient extractCookieFromResponse handles various headers', () => {
  const client = new MoodleClient();

  const mockRes1 = {
    headers: {
      getSetCookie: () => ['MoodleSession=abc456def; path=/; secure; HttpOnly'],
    },
  };
  assert.equal(client.extractCookieFromResponse(mockRes1), 'abc456def');

  const mockRes2 = {
    headers: {
      get: (h) => (h === 'set-cookie' ? 'MoodleSession=xyz789; path=/' : null),
    },
  };
  assert.equal(client.extractCookieFromResponse(mockRes2), 'xyz789');

  const mockResEmpty = { headers: null };
  assert.equal(client.extractCookieFromResponse(mockResEmpty), null);
});

test('MoodleClient extractSesskey parses sesskey patterns', () => {
  const client = new MoodleClient();

  const html1 = '<script>var M = {"sesskey":"AbCdEf1234"};</script>';
  assert.equal(client.extractSesskey(html1), 'AbCdEf1234');

  const html2 = '<a href="https://elearning.vsu.edu.ph/login/logout.php?sesskey=XyZ987">Logout</a>';
  assert.equal(client.extractSesskey(html2), 'XyZ987');

  const html3 = '<input type="hidden" name="sesskey" value="Tok12345" />';
  assert.equal(client.extractSesskey(html3), 'Tok12345');

  assert.equal(client.extractSesskey(''), null);
  assert.equal(client.extractSesskey(null), null);
});

test('MoodleClient extractUserInfo extracts fullname and userid', () => {
  const client = new MoodleClient();

  const html = `
    <div class="usermenu">
      <span class="usertext mr-1">Student User</span>
      <a href="https://elearning.vsu.edu.ph/user/profile.php?id=12345" title="View profile">Profile</a>
    </div>
  `;
  const info = client.extractUserInfo(html);
  assert.equal(info.fullname, 'Student User');
  assert.equal(info.id, '12345');

  const emptyInfo = client.extractUserInfo('');
  assert.equal(emptyInfo, null);
});

test('MoodleClient checkStatus identifies network error cleanly', async () => {
  const client = new MoodleClient({ baseUrl: 'http://127.0.0.1:59999' });
  client.sessionCookie = 'anycookie';
  const status = await client.checkStatus();
  assert.equal(status.authenticated, false);
  assert.equal(status.isNetworkError, true);
  assert.match(status.reason, /Network error/);
});

test('MoodleClient downloadResource handles HTML responses without crashing streams', async () => {
  const client = new MoodleClient();
  const origFetch = globalThis.fetch;
  try {
    // Mock fetch returning HTML page with no embedded files
    globalThis.fetch = async () => ({
      ok: true,
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      text: async () => '<html><body><h1>No files here</h1></body></html>',
    });

    await assert.rejects(
      async () => {
        await client.downloadResource('https://elearning.vsu.edu.ph/mod/resource/view.php?id=999', '/tmp/test_download.pdf');
      },
      /Resource URL returned an HTML page with no downloadable file/
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('expandHome expands ~, ~/path, and safely returns non-string or absolute paths', () => {
  assert.equal(expandHome('~'), os.homedir());
  assert.equal(expandHome('~/Downloads/VSUEE'), path.join(os.homedir(), 'Downloads', 'VSUEE'));
  assert.equal(expandHome('/tmp/file.txt'), '/tmp/file.txt');
  assert.equal(expandHome('relative/path.txt'), 'relative/path.txt');
  assert.equal(expandHome(null), null);
  assert.equal(expandHome(undefined), undefined);
  assert.equal(expandHome(12345), 12345);
});

test('MoodleClient getCourseContents parses persistent section IDs, cleans accesshide, and extracts details', async () => {
  const client = new MoodleClient();
  const mockHtml = `
    <html>
      <head><title>Course: CSci 144</title></head>
      <body>
        <h1>CSci 144 - Parallel Computing</h1>
        <ul class="topics">
          <li id="section-0" class="section main clearfix" aria-labelledby="sectionid-45678-title">
            <h3 class="sectionname" id="sectionid-45678-title"><span>General Syllabus</span></h3>
            <div class="summary"><p>General course notes and overview</p></div>
            <ul class="section img-text">
              <li class="activity forum modtype_forum" id="module-1001">
                <div class="activityinstance">
                  <a class="aalink" href="https://elearning.vsu.edu.ph/mod/forum/view.php?id=1001">
                    <span class="instancename">Announcements<span class="accesshide "> Forum</span></span>
                  </a>
                </div>
              </li>
              <li class="activity resource modtype_resource" id="module-1002">
                <div class="activityinstance">
                  <a class="aalink" href="https://elearning.vsu.edu.ph/mod/resource/view.php?id=1002">
                    <span class="instancename">Lecture 1 Slides<span class="accesshide"> File</span></span>
                  </a>
                  <span class="resourcedetails">1.4 MB PDF document uploaded 01/09/26, 10:00</span>
                </div>
              </li>
            </ul>
          </li>
        </ul>
      </body>
    </html>
  `;

  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({
      ok: true,
      text: async () => mockHtml,
    });

    const course = await client.getCourseContents(1610);
    assert.equal(course.id, 1610);
    assert.equal(course.title, 'CSci 144 - Parallel Computing');
    assert.equal(course.sections.length, 1);

    const sec0 = course.sections[0];
    assert.equal(sec0.id, 45678); // parsed from aria-labelledby sectionid-45678-title
    assert.equal(sec0.number, 0);
    assert.equal(sec0.name, 'General Syllabus');
    assert.match(sec0.summary, /General course notes/);
    assert.equal(sec0.activities.length, 2);

    // Verify screen reader text is stripped
    const act0 = sec0.activities[0];
    assert.equal(act0.name, 'Announcements'); // Not 'Announcements Forum'
    assert.equal(act0.type, 'forum');

    const act1 = sec0.activities[1];
    assert.equal(act1.name, 'Lecture 1 Slides'); // Not 'Lecture 1 Slides File'
    assert.equal(act1.fileType, 'pdf');
    assert.equal(act1.details, '1.4 MB PDF document uploaded 01/09/26, 10:00');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('MoodleClient getUrlDetails extracts embedded video and target link', async () => {
  const client = new MoodleClient();
  const mockHtml = `
    <html>
      <body>
        <h2>OpenCL Architecture Video</h2>
        <div class="urlworkaround">
          <a href="https://www.youtube.com/watch?v=sample123">Click here to view video</a>
        </div>
      </body>
    </html>
  `;

  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({
      ok: true,
      text: async () => mockHtml,
    });

    const details = await client.getUrlDetails(262927);
    assert.equal(details.id, 262927);
    assert.equal(details.title, 'OpenCL Architecture Video');
    assert.equal(details.targetUrl, 'https://www.youtube.com/watch?v=sample123');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('MoodleClient setCourseHidden calls core_user_update_user_preferences', async () => {
  const client = new MoodleClient();
  client.sessionCookie = 'test-session';
  client.sesskey = 'test-sesskey';

  let calledMethod = null;
  let calledArgs = null;
  client.callAjax = async (method, args) => {
    calledMethod = method;
    calledArgs = args;
    return null;
  };

  const res = await client.setCourseHidden(1610, true);
  assert.equal(res.success, true);
  assert.equal(res.courseId, 1610);
  assert.equal(res.hidden, true);
  assert.equal(calledMethod, 'core_user_update_user_preferences');
  assert.deepEqual(calledArgs, {
    preferences: [{ type: 'block_myoverview_hidden_course_1610', value: 1 }],
  });

  const resUnhide = await client.setCourseHidden(1610, false);
  assert.equal(resUnhide.hidden, false);
  assert.deepEqual(calledArgs, {
    preferences: [{ type: 'block_myoverview_hidden_course_1610', value: 0 }],
  });
});

test('getMimeType returns correct MIME types', () => {
  assert.equal(getMimeType('document.pdf'), 'application/pdf');
  assert.equal(getMimeType('paper.docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(getMimeType('archive.zip'), 'application/zip');
  assert.equal(getMimeType('presentation.pptx'), 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  assert.equal(getMimeType('spreadsheet.xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(getMimeType('sheet.xls'), 'application/vnd.ms-excel');
  assert.equal(getMimeType('image.png'), 'image/png');
  assert.equal(getMimeType('unknown.xyz123'), 'application/octet-stream');
  assert.equal(getMimeType(null), 'application/octet-stream');
});

test('MoodleClient submitAssignment validation checks', async () => {
  const client = new MoodleClient();
  client.sessionCookie = 'mock-cookie';
  client.sesskey = 'mock-sesskey';

  // Requires assignId
  await assert.rejects(
    async () => client.submitAssignment(null),
    /Assignment ID is required/
  );

  // Requires either file or online text
  await assert.rejects(
    async () => client.submitAssignment(12345, {}),
    /Must provide either a file/
  );

  // Requires valid existing file
  await assert.rejects(
    async () => client.submitAssignment(12345, { filePath: '/non/existent/file.pdf' }),
    /File not found/
  );

  // Requires non-empty file
  const tmpFile = path.join(os.tmpdir(), `vsuee_test_empty_${Date.now()}.txt`);
  fsSync.writeFileSync(tmpFile, '');
  try {
    await assert.rejects(
      async () => client.submitAssignment(12345, { filePath: tmpFile }),
      /Target file is empty/
    );
  } finally {
    if (fsSync.existsSync(tmpFile)) fsSync.unlinkSync(tmpFile);
  }
});

test('MoodleClient submitAssignment end-to-end mock flow', async () => {
  const client = new MoodleClient();
  client.sessionCookie = 'mock-cookie';
  client.sesskey = 'mock-sesskey';

  const testFile = path.join(os.tmpdir(), `vsuee_sub_${Date.now()}.pdf`);
  fsSync.writeFileSync(testFile, '%PDF-1.4 mock pdf content for submission');

  const mockEditHtml = `
    <!DOCTYPE html>
    <html>
      <body>
        <form action="https://elearning.vsu.edu.ph/mod/assign/view.php" method="post">
          <input type="hidden" name="lastmodified" value="1700000000" />
          <input type="hidden" name="id" value="12345" />
          <input type="hidden" name="userid" value="27467" />
          <input type="hidden" name="action" value="savesubmission" />
          <input type="hidden" name="sesskey" value="mock-sesskey" />
          <input type="hidden" name="_qf__mod_assign_submission_form" value="1" />
        </form>
        <script>
          M.form_filemanager.init(Y, {
            "itemid": 987654321,
            "maxbytes": 20971520,
            "maxfiles": 10,
            "client_id": "client_abc123",
            "accepted_types": [".pdf", ".docx"],
            "repositories": {
              "4": { "id": "4", "name": "Upload a file", "type": "upload" }
            }
          });
        </script>
      </body>
    </html>
  `;

  const mockViewHtml = `
    <!DOCTYPE html>
    <html>
      <body>
        <h2>Midterm Project Report</h2>
        <div id="intro">Submit your midterm project report here.</div>
        <table class="generaltable">
          <tr><th>Submission status</th><td>Submitted for grading</td></tr>
          <tr><th>Grading status</th><td>Not graded</td></tr>
          <tr><th>Due date</th><td>Friday, 15 May 2026, 11:59 PM</td></tr>
          <tr><th>File submissions</th><td><a href="https://elearning.vsu.edu.ph/pluginfile.php/1/mod_assign/submission_files/test.pdf">${path.basename(testFile)}</a></td></tr>
        </table>
      </body>
    </html>
  `;

  const requests = [];

  client.fetchWithAuth = async (url, opts = {}) => {
    requests.push({ url, method: opts.method || 'GET', body: opts.body });

    if (url.includes('action=editsubmission')) {
      return {
        ok: true,
        status: 200,
        text: async () => mockEditHtml,
      };
    }

    if (url.includes('repository_ajax.php?action=upload')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ event: 'upload', id: 98765, file: path.basename(testFile) }),
      };
    }

    if (url.includes('mod/assign/view.php') && opts.method === 'POST') {
      return {
        ok: true,
        status: 200,
        text: async () => mockViewHtml,
      };
    }

    if (url.includes('mod/assign/view.php?id=12345')) {
      return {
        ok: true,
        status: 200,
        text: async () => mockViewHtml,
      };
    }

    return { ok: true, status: 200, text: async () => '' };
  };

  try {
    const result = await client.submitAssignment(12345, {
      filePath: testFile,
      final: false,
    });

    assert.equal(result.success, true);
    assert.equal(result.assignId, 12345);
    assert.equal(result.mode, 'draft');
    assert.equal(result.verified, true);
    assert.equal(result.file.name, path.basename(testFile));
    assert.ok(result.file.sha256);
    assert.equal(result.file.size > 0, true);

    // Verify upload request occurred
    const uploadReq = requests.find(r => r.url.includes('repository_ajax.php?action=upload'));
    assert.ok(uploadReq, 'Repository upload request should have been made');
    assert.equal(uploadReq.method, 'POST');

    // Verify form save request occurred
    const saveReq = requests.find(r => r.url.includes('mod/assign/view.php') && r.method === 'POST');
    assert.ok(saveReq, 'Save submission form request should have been made');
  } finally {
    if (fsSync.existsSync(testFile)) fsSync.unlinkSync(testFile);
  }
});

// Snapshot consumers require complete collections; ordinary listing remains best-effort.
for (const [method, payload] of [
  ['getCourses', { courses: [] }],
  ['getTimeline', { events: [] }],
]) {
  const read = (client, strict) => method === 'getCourses'
    ? client.getCourses({ strict })
    : client.getTimeline(30, { strict });

  test(`${method} strict accepts an authoritative empty AJAX collection without HTML fallback`, async () => {
    const client = new MoodleClient();
    client.callAjax = async () => payload;
    let fallbackCalls = 0;
    client.fetchWithAuth = async () => {
      fallbackCalls++;
      return { ok: true, text: async () => '<html></html>' };
    };
    assert.deepEqual(await read(client, true), []);
    assert.equal(fallbackCalls, 0);
    // Preserve the historical fallback for existing non-strict callers.
    assert.deepEqual(await read(client, false), []);
    assert.equal(fallbackCalls, 1);
  });

  test(`${method} strict rejects an unsuccessful HTML fallback rather than returning empty`, async () => {
    const client = new MoodleClient();
    for (const ajaxResult of [null, { unexpected: [] }]) {
      client.callAjax = async () => ajaxResult;
      client.fetchWithAuth = async () => ({ ok: false, status: 503, text: async () => '' });
      await assert.rejects(read(client, true), /Unable to fetch/);
      assert.deepEqual(await read(client, false), []);
    }
    client.callAjax = async () => { throw new Error('synthetic AJAX failure'); };
    await assert.rejects(read(client, true), /Unable to fetch/);
  });

  test(`${method} strict still permits a successful empty HTML fallback`, async () => {
    const client = new MoodleClient();
    client.callAjax = async () => { throw new Error('synthetic AJAX unavailable'); };
    client.fetchWithAuth = async () => ({ ok: true, text: async () => '<html><body>No items</body></html>' });
    assert.deepEqual(await read(client, true), []);
  });
}

test('strict collections reject recognized logged-out HTML, not an empty collection', async () => {
  const client = new MoodleClient();
  client.callAjax = async () => { throw new Error('synthetic AJAX unavailable'); };
  for (const html of [
    '<form><input name="logintoken" value="synthetic-placeholder"></form>',
    '<a href="/login/index.php">Login</a>You are not logged in',
  ]) {
    client.fetchWithAuth = async () => ({ ok: true, text: async () => html });
    await assert.rejects(client.getCourses({ strict: true }), /Session expired/);
    await assert.rejects(client.getTimeline(30, { strict: true }), /Session expired/);
    await assert.rejects(client.getAssignments(10, { strict: true }), /Session expired/);
    assert.deepEqual(await client.getAssignments(10), []);
  }
});

const snapshotAssignmentHtml = '<table><tr class="assignment"><td>Topic</td><td><a href="https://elearning.vsu.edu.ph/mod/assign/view.php?id=51">Synthetic assignment</a></td><td>Tomorrow</td><td>No attempt</td><td>No grade</td></tr></table>';

test('getAssignments strict rejects a partial collection after one course succeeds', async () => {
  const client = new MoodleClient();
  const optionsSeen = [];
  client.getCourses = async options => {
    optionsSeen.push(options);
    return [{ id: 10, fullname: 'Synthetic 10' }, { id: 20, fullname: 'Synthetic 20' }];
  };
  for (const failure of ['http', 'network', 'body']) {
    client.fetchWithAuth = async url => {
      if (url.endsWith('id=10')) return { ok: true, text: async () => snapshotAssignmentHtml };
      if (failure === 'network') throw new Error('synthetic network failure');
      if (failure === 'body') return { ok: true, text: async () => { throw new Error('synthetic body failure'); } };
      return { ok: false, status: 503, text: async () => '' };
    };
    await assert.rejects(client.getAssignments(null, { strict: true }), /Unable to fetch all assignments/);
    const partial = await client.getAssignments();
    assert.deepEqual(partial.map(a => a.id), [51]);
    assert.equal(partial[0].coursename, 'Synthetic 10');
  }
  assert.deepEqual(optionsSeen.filter(options => options.strict), [
    { strict: true }, { strict: true }, { strict: true },
  ]);
});

test('getAssignments strict distinguishes a failed course from successful empty courses', async () => {
  const client = new MoodleClient();
  client.fetchWithAuth = async () => ({ ok: false, status: 403, text: async () => '' });
  await assert.rejects(client.getAssignments(10, { strict: true }), /Unable to fetch assignments/);
  assert.deepEqual(await client.getAssignments(10), []);
  client.getCourses = async () => [{ id: 10, fullname: 'Synthetic 10' }, { id: 20, fullname: 'Synthetic 20' }];
  client.fetchWithAuth = async url => ({ ok: true, text: async () => url.endsWith('id=10') ? snapshotAssignmentHtml : '<table></table>' });
  assert.deepEqual((await client.getAssignments(null, { strict: true })).map(a => a.id), [51]);
  assert.deepEqual(await client.getAssignments(20, { strict: true }), []);
  client.fetchWithAuth = async () => ({ ok: true, text: async () => '<table></table>' });
  assert.deepEqual(await client.getAssignments(null, { strict: true }), []);
});

test('strict assignment catalog failure cannot masquerade as zero enrolled courses', async () => {
  const client = new MoodleClient();
  client.callAjax = async () => { throw new Error('synthetic AJAX unavailable'); };
  client.fetchWithAuth = async () => ({ ok: false, status: 503, text: async () => '' });
  await assert.rejects(client.getAssignments(null, { strict: true }), /Unable to fetch the course catalog/);
  assert.deepEqual(await client.getAssignments(), []);
});

test('strict AJAX reads retain nonempty course and timeline normalization', async () => {
  const client = new MoodleClient();
  client.callAjax = async method => method.includes('course_get')
    ? { courses: [{ id: 10, fullname: 'Synthetic 10', hidden: true }] }
    : { events: [{ id: 71, name: 'Synthetic deadline', course: { id: 10, fullname: 'Synthetic 10' }, action: { url: 'https://synthetic.invalid/event' } }] };
  client.fetchWithAuth = async () => assert.fail('Nonempty AJAX results must not use fallback');
  assert.deepEqual(await client.getCourses({ strict: true }), await client.getCourses());
  assert.deepEqual(await client.getTimeline(30, { strict: true }), await client.getTimeline(30));
});
