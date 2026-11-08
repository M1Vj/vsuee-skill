import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import {
  MoodleClient,
  getExtensionFromMimeType,
  matchesType,
  asyncPool,
  formatIcsDate,
  escapeIcsText,
  foldIcsLine,
  generateIcsCalendar,
  ProgressIndicator,
} from '../lib/moodle-client.mjs';

test('getExtensionFromMimeType returns correct extensions including media', () => {
  assert.equal(getExtensionFromMimeType('image/png'), '.png');
  assert.equal(getExtensionFromMimeType('image/jpeg; charset=utf-8'), '.jpg');
  assert.equal(getExtensionFromMimeType('image/webp'), '.webp');
  assert.equal(getExtensionFromMimeType('image/svg+xml'), '.svg');
  assert.equal(getExtensionFromMimeType('application/pdf'), '.pdf');
  assert.equal(getExtensionFromMimeType('application/vnd.openxmlformats-officedocument.presentationml.presentation'), '.pptx');
  assert.equal(getExtensionFromMimeType('application/vnd.openxmlformats-officedocument.wordprocessingml.document'), '.docx');
  assert.equal(getExtensionFromMimeType('application/zip'), '.zip');
  assert.equal(getExtensionFromMimeType('application/x-7z-compressed'), '.7z');
  assert.equal(getExtensionFromMimeType('video/webm'), '.webm');
  assert.equal(getExtensionFromMimeType('audio/wav'), '.wav');
  assert.equal(getExtensionFromMimeType('unknown/format'), '');
  assert.equal(getExtensionFromMimeType(null), '');
});

test('matchesType properly matches extensions and aliases', () => {
  assert.equal(matchesType('pdf', 'pdf'), true);
  assert.equal(matchesType('pptx', 'ppt'), true);
  assert.equal(matchesType('ppt', 'pptx'), true);
  assert.equal(matchesType('docx', 'doc'), true);
  assert.equal(matchesType('doc', 'docx'), true);
  assert.equal(matchesType('xlsx', 'xls'), true);
  assert.equal(matchesType('mp4', 'video'), true);
  assert.equal(matchesType('webm', 'video'), true);
  assert.equal(matchesType('mp3', 'audio'), true);
  assert.equal(matchesType('pdf', 'pptx'), false);
  assert.equal(matchesType(null, 'pdf'), false);
  assert.equal(matchesType('pdf', null), true);
});

test('MoodleClient extractImagesFromHtml extracts lazy-loaded, srcset, and content diagrams', () => {
  const client = new MoodleClient();
  const html = `
    <div class="header">
      <img src="https://elearning.vsu.edu.ph/theme/image.php/academi/core/123/vsuseal300.png" alt="Seal" />
      <img src="https://elearning.vsu.edu.ph/pix/spacer.gif" alt="" />
      <img src="https://elearning.vsu.edu.ph/theme/image.php/academi/core/123/icon.png" alt="icon" />
    </div>
    <div class="content">
      <h2>Lesson 1 Architecture</h2>
      <img src="https://elearning.vsu.edu.ph/pluginfile.php/1234/mod_page/content/1/distributed_memory.png" alt="Distributed Architecture Diagram" />
      <img src="https://elearning.vsu.edu.ph/pix/spacer.gif" data-src="https://external.cdn.org/images/matrix_multiplication.jpg" alt="Matrix Flowchart" />
      <picture>
        <source srcset="https://elearning.vsu.edu.ph/pluginfile.php/1234/mod_page/content/1/diagram_2x.webp 2x, https://elearning.vsu.edu.ph/pluginfile.php/1234/mod_page/content/1/diagram_1x.webp 1x">
        <img src="https://elearning.vsu.edu.ph/pluginfile.php/1234/mod_page/content/1/fallback.png" alt="Diagram" />
      </picture>
      <a href="https://elearning.vsu.edu.ph/pluginfile.php/1234/mod_page/content/1/full_graph.svg">View Full Architecture Graph</a>
    </div>
  `;

  // By default, filter out theme icons but include content images (including lazy-loaded and srcset)
  const contentImages = client.extractImagesFromHtml(html, 'https://elearning.vsu.edu.ph/mod/page/view.php?id=123');
  assert.ok(contentImages.some(i => i.url.includes('distributed_memory.png') && i.alt === 'Distributed Architecture Diagram'));
  assert.ok(contentImages.some(i => i.url.includes('matrix_multiplication.jpg')));
  assert.ok(contentImages.some(i => i.url.includes('diagram_1x.webp') || i.url.includes('diagram_2x.webp')));
  assert.ok(contentImages.some(i => i.url.includes('full_graph.svg')));
});

test('MoodleClient downloadResource handles base64 data URIs without ENAMETOOLONG', async () => {
  const client = new MoodleClient();
  const tmpDir = path.join(os.tmpdir(), `test_data_uri_${Date.now()}`);
  await fs.mkdir(tmpDir, { recursive: true });

  try {
    // Generate a long dummy PNG payload (>300 bytes, base64 >400 chars)
    const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const dummyPng = Buffer.concat([pngHeader, Buffer.alloc(300, 42)]);
    const dataUri = `data:image/png;base64,${dummyPng.toString('base64')}`;

    const res = await client.downloadResource(dataUri, tmpDir, {
      isDir: true,
      defaultName: 'embedded_diagram',
    });

    assert.equal(res.skipped, false);
    assert.ok(res.savedPath.endsWith('.png'));
    assert.ok(path.basename(res.savedPath).startsWith('embedded_diagram'));
    const stat = await fs.stat(res.savedPath);
    assert.equal(stat.size, dummyPng.length);

    // Verify incremental skipping on re-download
    const resCached = await client.downloadResource(dataUri, tmpDir, {
      isDir: true,
      defaultName: 'embedded_diagram',
    });
    assert.equal(resCached.skipped, true);
  } finally {
    try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('MoodleClient downloadResource appends extension from Content-Type if missing in URL', async () => {
  const client = new MoodleClient();
  const tmpDir = path.join(os.tmpdir(), `test_dl_${Date.now()}`);
  await fs.mkdir(tmpDir, { recursive: true });

  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({
      ok: true,
      headers: new Headers({
        'content-type': 'image/png',
        'content-length': '12',
      }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from('fake-png-data'));
          controller.close();
        },
      }),
    });

    const res = await client.downloadResource('https://elearning.vsu.edu.ph/pluginfile.php/123/image_without_ext', tmpDir, { isDir: true });
    assert.equal(res.skipped, false);
    assert.ok(res.savedPath.endsWith('.png'), `Saved path should end with .png: ${res.savedPath}`);
    assert.ok((await fs.stat(res.savedPath)).size > 0);
  } finally {
    globalThis.fetch = origFetch;
    try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('MoodleClient downloadModule saves directly to specified file path without creating a directory', async () => {
  const client = new MoodleClient();
  const tmpFile = path.join(os.tmpdir(), `test_single_file_${Date.now()}.pdf`);

  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({
      ok: true,
      headers: new Headers({
        'content-type': 'application/pdf',
        'content-length': '16',
      }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from('fake-pdf-content'));
          controller.close();
        },
      }),
    });

    const res = await client.downloadModule(229320, tmpFile);
    assert.equal(res.savedPath, tmpFile);
    const stat = await fs.stat(tmpFile);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.size, 16);
  } finally {
    globalThis.fetch = origFetch;
    try { await fs.unlink(tmpFile); } catch {}
  }
});

test('MoodleClient downloadModule supports shortcut targets like "assign 123" and "resource 456"', async () => {
  const client = new MoodleClient();

  // Mock downloadAssignmentAttachments
  client.downloadAssignmentAttachments = async (assignId) => ({
    id: assignId,
    type: 'assign',
    title: 'Assignment Test',
    files: [{ name: 'rubric.pdf' }],
  });

  // Mock downloadResource
  client.downloadResource = async (url) => ({
    savedPath: '/tmp/test.pdf',
    size: 100,
    skipped: false,
  });

  const assignRes = await client.downloadModule('assign 248286');
  assert.equal(assignRes.id, '248286');

  const resRes = await client.downloadModule('resource 229320');
  assert.equal(resRes.id, '229320');
  assert.equal(resRes.type, 'resource');
});

test('MoodleClient downloadCourseMaterials respects typeFilter, section, and includeAssignments', async () => {
  const client = new MoodleClient();
  const tmpDir = path.join(os.tmpdir(), `test_materials_${Date.now()}`);

  // Mock getCourseContents
  client.getCourseContents = async () => ({
    title: 'Test Course 101',
    sections: [
      {
        number: 1,
        name: 'Introduction',
        activities: [
          { id: 101, type: 'resource', name: 'Lecture 1 Slides.pptx', link: 'https://vsu/lec1.pptx', fileType: 'pptx' },
          { id: 102, type: 'resource', name: 'Syllabus.pdf', link: 'https://vsu/syllabus.pdf', fileType: 'pdf' },
          { id: 103, type: 'assign', name: 'Homework 1', link: 'https://vsu/assign1', fileType: null },
        ],
      },
      {
        number: 2,
        name: 'Advanced Topics',
        activities: [
          { id: 201, type: 'resource', name: 'Lecture 2 Slides.pptx', link: 'https://vsu/lec2.pptx', fileType: 'pptx' },
        ],
      },
    ],
  });

  // Mock downloadResource
  client.downloadResource = async (url, dest) => ({
    savedPath: dest,
    size: 1024,
    skipped: false,
  });

  // Mock downloadAssignmentAttachments
  client.downloadAssignmentAttachments = async (assignId, dest, options = {}) => {
    let files = [{ name: 'rubric.pdf', path: path.join(dest, 'rubric.pdf'), size: 512 }];
    if (options.typeFilter && options.typeFilter === 'pptx') {
      files = [];
    }
    return {
      id: assignId,
      title: 'Homework 1',
      destination: dest,
      downloadCount: files.length,
      skippedCount: 0,
      errors: [],
      files,
    };
  };

  // Filter for pdf only
  const pdfOnly = await client.downloadCourseMaterials(999, tmpDir, { typeFilter: 'pdf' });
  assert.equal(pdfOnly.downloadCount, 1);
  assert.equal(pdfOnly.items[0].module, 'Syllabus.pdf');

  // Filter for pptx using ppt alias
  const pptxOnly = await client.downloadCourseMaterials(999, tmpDir, { typeFilter: 'ppt' });
  assert.equal(pptxOnly.downloadCount, 2);

  // Filter by section
  const sec2Only = await client.downloadCourseMaterials(999, tmpDir, { section: 2 });
  assert.equal(sec2Only.downloadCount, 1);
  assert.equal(sec2Only.items[0].module, 'Lecture 2 Slides.pptx');

  // Include assignments
  const withAssign = await client.downloadCourseMaterials(999, tmpDir, { includeAssignments: true });
  assert.equal(withAssign.downloadCount, 4);
  assert.ok(withAssign.items.some(i => i.module.includes('Homework 1 (Attachment: rubric.pdf)')));
});

test('asyncPool strictly enforces bounded concurrency pool', async () => {
  const concurrency = 3;
  const items = Array.from({ length: 12 }, (_, i) => i);
  let maxActive = 0;
  let currentlyActive = 0;

  const results = await asyncPool(concurrency, items, async (item) => {
    currentlyActive++;
    if (currentlyActive > maxActive) {
      maxActive = currentlyActive;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    currentlyActive--;
    return item * 2;
  });

  assert.ok(maxActive <= concurrency, `maxActive (${maxActive}) should not exceed concurrency (${concurrency})`);
  assert.equal(results.length, items.length);
  for (let i = 0; i < items.length; i++) {
    assert.equal(results[i].status, 'fulfilled');
    assert.equal(results[i].value, i * 2);
  }
});

test('asyncPool handles errors gracefully and fires onStart and onProgress', async () => {
  const items = ['a', 'b', 'fail', 'c'];
  const started = [];
  const progressed = [];

  const results = await asyncPool(
    2,
    items,
    async (item) => {
      if (item === 'fail') throw new Error('Boom');
      return item.toUpperCase();
    },
    {
      onStart: (ev) => started.push(ev.item),
      onProgress: (ev) => progressed.push({ item: ev.item, hasError: Boolean(ev.error) }),
    }
  );

  assert.equal(started.length, 4);
  assert.equal(progressed.length, 4);
  assert.equal(results[0].value, 'A');
  assert.equal(results[1].value, 'B');
  assert.equal(results[2].status, 'rejected');
  assert.match(results[2].reason.message, /Boom/);
  assert.equal(results[3].value, 'C');
});

test('RFC 5545 iCalendar date formatting, escaping, and line folding', () => {
  const d = new Date('2026-09-07T04:00:00.000Z');
  assert.equal(formatIcsDate(d), '20260907T040000Z');

  const rawText = 'Hello; world, how\nare you\\doing?';
  const escaped = escapeIcsText(rawText);
  assert.equal(escaped, 'Hello\\; world\\, how\\nare you\\\\doing?');

  const longLine = 'SUMMARY:This is an extremely long summary text that exceeds seventy-five octets and therefore must be properly folded with CRLF and space according to RFC 5545 standards.';
  const folded = foldIcsLine(longLine);
  assert.ok(folded.includes('\r\n '));
  const lines = folded.split('\r\n');
  assert.ok(lines[0].length <= 75);
  for (let i = 1; i < lines.length; i++) {
    assert.ok(lines[i].startsWith(' '));
  }
});

test('generateIcsCalendar produces valid RFC 5545 VCALENDAR and VEVENTs', () => {
  const events = [
    {
      id: 101,
      name: 'Midterm Exam Due',
      timestart: '2026-10-15T01:00:00.000Z',
      timeend: '2026-10-15T03:00:00.000Z',
      coursename: 'CSci 144 - Distributed Systems',
      description: 'Submit your solution repository link',
      actionurl: 'https://elearning.vsu.edu.ph/mod/assign/view.php?id=101',
    },
  ];

  const ics = generateIcsCalendar(events, { calendarName: 'VSU Deadlines' });
  assert.ok(ics.includes('BEGIN:VCALENDAR'));
  assert.ok(ics.includes('VERSION:2.0'));
  assert.ok(ics.includes('PRODID:-//VSUEE Moodle Client//EN'));
  assert.ok(ics.includes('X-WR-CALNAME:VSU Deadlines'));
  assert.ok(ics.includes('BEGIN:VEVENT'));
  assert.ok(ics.includes('UID:vsuee-101@elearning.vsu.edu.ph'));
  assert.ok(ics.includes('DTSTART:20261015T010000Z'));
  assert.ok(ics.includes('DTEND:20261015T030000Z'));
  assert.ok(ics.includes('SUMMARY:Midterm Exam Due'));
  assert.ok(ics.includes('CATEGORIES:CSci 144 - Distributed Systems'));
  assert.ok(ics.includes('END:VEVENT'));
  assert.ok(ics.includes('END:VCALENDAR'));
});

test('ProgressIndicator renders in TTY and computes progress accurately', () => {
  let output = '';
  const fakeStream = {
    write: (str) => { output += str; },
  };

  const indicator = new ProgressIndicator(10, {
    stream: fakeStream,
    quiet: false,
    json: false,
  });
  indicator.isTty = true;

  indicator.onStart({ item: { name: 'slide1.pptx' }, activeCount: 2 });
  indicator.onProgress({ completed: 5, item: { name: 'slide1.pptx' }, activeCount: 1, result: { skipped: false } });
  indicator.finish();

  assert.equal(indicator.completed, 5);
  assert.equal(indicator.successful, 1);
  assert.ok(output.includes('[') && output.includes(']'));
});

test('MoodleClient getAssignmentDetails parses rich submission details, submitted files, and rubrics', async () => {
  const client = new MoodleClient();
  const mockHtml = `
    <h2>Project Assignment: Microservices</h2>
    <div id="intro"><p>Build a gRPC microservice. Check attached rubric.</p></div>
    <div id="region-main">
      <a href="https://elearning.vsu.edu.ph/pluginfile.php/999/mod_assign/intro/Grading_Rubric.pdf">Grading_Rubric.pdf</a>
      <table class="generaltable">
        <tr><th scope="row">Submission status</th><td>Submitted for grading</td></tr>
        <tr><th scope="row">Grading status</th><td>Released</td></tr>
        <tr><th scope="row">Due date</th><td>Friday, 10 October 2026, 11:59 PM</td></tr>
        <tr><th scope="row">Time remaining</th><td>Assignment was submitted 2 days early</td></tr>
        <tr><th scope="row">File submissions</th>
          <td>
            <div class="fileuploadsubmission">
              <a href="https://elearning.vsu.edu.ph/pluginfile.php/888/assignsubmission_file/submission_files/123/microservice_v1.zip">microservice_v1.zip</a>
            </div>
            <div class="fileuploadsubmissiontime">8 October 2026, 3:45 PM</div>
          </td>
        </tr>
      </table>
      <div class="feedback">
        <table class="generaltable">
          <tr><th scope="row">Grade</th><td>95.00&nbsp;/&nbsp;100.00</td></tr>
          <tr><th scope="row">Graded on</th><td>Monday, 13 October 2026, 9:00 AM</td></tr>
          <tr><th scope="row">Graded by</th><td>Dr. John Doe</td></tr>
          <tr><th scope="row">Feedback files</th>
            <td><a href="https://elearning.vsu.edu.ph/pluginfile.php/777/assignfeedback_file/feedback_files/456/instructor_notes.pdf">instructor_notes.pdf</a></td>
          </tr>
        </table>
      </div>
      <div class="gradingform_rubric">
        <tr class="criterion">
          <td class="description">Architecture & Design</td>
          <td class="level checked"><span class="score">40</span><div class="definition">Clean separation of concerns</div></td>
          <td class="level"><span class="score">20</span><div class="definition">Monolithic or tightly coupled</div></td>
          <td class="remark">Excellent clean architecture</td>
        </tr>
      </div>
    </div>
  `;

  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({
      ok: true,
      text: async () => mockHtml,
    });

    const details = await client.getAssignmentDetails(555);
    assert.equal(details.id, 555);
    assert.equal(details.title, 'Project Assignment: Microservices');
    assert.equal(details.isSubmitted, true);
    assert.equal(details.isGraded, true);
    assert.equal(details.isOverdue, false);
    assert.equal(details.grade, '95.00 / 100.00');
    assert.equal(details.gradedBy, 'Dr. John Doe');

    // Submitted files
    assert.equal(details.submittedFiles.length, 1);
    assert.equal(details.submittedFiles[0].name, 'microservice_v1.zip');
    assert.ok(details.submittedFiles[0].url.includes('forcedownload=1'));
    assert.equal(details.submittedFiles[0].uploadedAt, '8 October 2026, 3:45 PM');

    // Feedback files
    assert.equal(details.feedbackFiles.length, 1);
    assert.equal(details.feedbackFiles[0].name, 'instructor_notes.pdf');

    // Rubric attachments
    assert.equal(details.rubricAttachments.length, 1);
    assert.equal(details.rubricAttachments[0].name, 'Grading_Rubric.pdf');

    // Interactive rubric criteria
    assert.ok(details.rubric);
    assert.equal(details.rubric.criteria.length, 1);
    assert.equal(details.rubric.criteria[0].description, 'Architecture & Design');
    assert.equal(details.rubric.criteria[0].levels[0].score, '40');
    assert.equal(details.rubric.criteria[0].levels[0].checked, true);
    assert.equal(details.rubric.criteria[0].remark, 'Excellent clean architecture');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('MoodleClient downloadAssignmentRubrics downloads files and writes rubric_criteria.md', async () => {
  const client = new MoodleClient();
  const tmpDir = path.join(os.tmpdir(), `test_rubric_dl_${Date.now()}`);

  client.getAssignmentDetails = async () => ({
    id: 999,
    title: 'Lab 3 Rubric Test',
    url: 'https://vsu/assign/999',
    dueDate: 'Next Friday',
    status: 'Submitted',
    grade: '100 / 100',
    rubricAttachments: [
      { name: 'rubric.pdf', url: 'https://vsu/rubric.pdf' },
    ],
    attachments: [],
    rubric: {
      criteria: [
        {
          description: 'Code Quality',
          remark: 'Well documented',
          levels: [
            { score: '50', definition: 'Follows standards', checked: true },
            { score: '25', definition: 'Messy code', checked: false },
          ],
        },
      ],
    },
  });

  client.downloadResource = async (url, dest) => ({
    savedPath: path.join(dest, 'rubric.pdf'),
    size: 2048,
    skipped: false,
  });

  try {
    const res = await client.downloadAssignmentRubrics(999, tmpDir);
    assert.equal(res.assignmentId, 999);
    assert.equal(res.downloadedFiles.length, 1);
    assert.ok(res.rubricMarkdownPath);

    const mdContent = await fs.readFile(res.rubricMarkdownPath, 'utf8');
    assert.ok(mdContent.includes('# Rubric: Lab 3 Rubric Test'));
    assert.ok(mdContent.includes('Code Quality'));
    assert.ok(mdContent.includes('Well documented'));
  } finally {
    try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('MoodleClient exportCalendarIcs creates valid .ics file with events', async () => {
  const client = new MoodleClient();
  const tmpFile = path.join(os.tmpdir(), `test_cal_${Date.now()}.ics`);

  client.getTimeline = async () => [
    {
      id: 777,
      name: 'Quiz 2 closes',
      activityname: 'Quiz 2',
      coursename: 'CSci 144',
      courseid: 1610,
      timestart: '2026-10-20T04:00:00.000Z',
      actionurl: 'https://vsu/quiz/777',
      overdue: false,
    },
  ];

  client.getAssignments = async () => [
    {
      id: 888,
      name: 'Final Project',
      coursename: 'CSci 144',
      duedate: '2026-10-30T15:59:00.000Z',
      submissionStatus: 'No submission',
      grade: '-',
      link: 'https://vsu/assign/888',
    },
  ];

  try {
    const res = await client.exportCalendarIcs(tmpFile);
    assert.equal(res.savedPath, tmpFile);
    assert.ok(res.eventCount >= 2);

    const content = await fs.readFile(tmpFile, 'utf8');
    assert.ok(content.includes('BEGIN:VCALENDAR'));
    assert.ok(content.includes('Quiz 2 closes'));
    assert.ok(content.includes('Final Project'));
    assert.ok(content.includes('END:VCALENDAR'));
  } finally {
    try { await fs.unlink(tmpFile); } catch {}
  }
});

test('foldIcsLine strictly respects RFC 5545 75-octet limit with UTF-8 multi-byte characters', () => {
  const lineWithUnicode = 'DESCRIPTION:Malugod na pagbati! Ito ay pagsusulit ukol sa mga aralin: 📝 Distributed Systems — Architecture & Synchronization (2026). Pakisuyong magpasa bago matapos ang takdang araw!';
  const folded = foldIcsLine(lineWithUnicode);
  assert.ok(folded.includes('\r\n '));
  const lines = folded.split('\r\n');
  for (let i = 0; i < lines.length; i++) {
    const byteLen = Buffer.byteLength(lines[i], 'utf8');
    assert.ok(byteLen <= 75, `Line ${i} byte length (${byteLen}) should be <= 75 octets`);
    if (i > 0) {
      assert.ok(lines[i].startsWith(' '), `Continuation line ${i} must start with linear white-space`);
    }
  }
  // Ensure un-folding recovers the original string without character corruption
  const unfolded = lines[0] + lines.slice(1).map(l => l.slice(1)).join('');
  assert.equal(unfolded, lineWithUnicode);
});

test('formatIcsDate handles unix timestamps in seconds, 10-digit strings, and RFC 5545 strings', () => {
  // 1788753600 seconds = 2026-09-07T04:00:00.000Z
  assert.equal(formatIcsDate(1788753600), '20260907T040000Z');
  assert.equal(formatIcsDate('1788753600'), '20260907T040000Z');
  assert.equal(formatIcsDate('20260907T040000Z'), '20260907T040000Z');
  assert.equal(formatIcsDate('20260907T040000'), '20260907T040000Z');
  assert.equal(formatIcsDate(new Date('2026-09-07T04:00:00.000Z')), '20260907T040000Z');
});

test('generateIcsCalendar includes RFC 5545 VALARM reminders and action URLs', () => {
  const events = [
    {
      id: 999,
      name: 'Project Submission',
      timestart: '2026-11-20T15:00:00.000Z',
      actionurl: 'https://elearning.vsu.edu.ph/mod/assign/view.php?id=999',
      coursename: 'CS 200a - Internship/OJT',
    },
  ];

  const ics = generateIcsCalendar(events);
  assert.ok(ics.includes('BEGIN:VALARM'));
  assert.ok(ics.includes('TRIGGER:-PT24H'));
  assert.ok(ics.includes('TRIGGER:-PT2H'));
  assert.ok(ics.includes('ACTION:DISPLAY'));
  assert.ok(ics.includes('URL:https://elearning.vsu.edu.ph/mod/assign/view.php?id=999'));
  assert.ok(ics.includes('LOCATION:CS 200a - Internship/OJT'));
});

test('generateIcsCalendar derives the default end from each supported start representation', async (t) => {
  const starts = [
    ['Date object', new Date('2026-09-07T04:00:00.000Z')],
    ['ISO string', '2026-09-07T04:00:00.000Z'],
    ['offset ISO string', '2026-09-07T12:00:00+08:00'],
    ['Unix seconds', 1788753600],
    ['Unix seconds string', '1788753600'],
    ['Unix milliseconds', 1788753600000],
    ['compact UTC string', '20260907T040000Z'],
    ['compact string without Z', '20260907T040000'],
    ['padded compact string', ' 20260907T040000Z '],
  ];

  for (const [label, start] of starts) {
    for (const field of ['dtstart', 'timestart']) {
      await t.test(`${label} via ${field}`, () => {
        const ics = generateIcsCalendar([{ id: 1, [field]: start }]);
        assert.ok(ics.includes('DTSTART:20260907T040000Z\r\n'));
        assert.ok(ics.includes('DTEND:20260907T050000Z\r\n'));
      });
    }
  }
});

test('generateIcsCalendar keeps default ends one hour after starts across UTC date boundaries', () => {
  for (const [start, end] of [
    ['20261231T233000Z', '20270101T003000Z'],
    ['20280228T233000Z', '20280229T003000Z'],
    ['20280229T233000Z', '20280301T003000Z'],
  ]) {
    const ics = generateIcsCalendar([{ id: 1, dtstart: start }]);
    assert.ok(ics.includes(`DTEND:${end}\r\n`));
  }
});

test('generateIcsCalendar preserves explicit end values and field precedence', () => {
  const ics = generateIcsCalendar([{
    id: 1,
    dtstart: '20260907T040000Z',
    timestart: '20260908T040000Z',
    dtend: '20260907T043000Z',
    timeend: '20260907T060000Z',
  }]);
  assert.ok(ics.includes('DTSTART:20260907T040000Z\r\n'));
  assert.ok(ics.includes('DTEND:20260907T043000Z\r\n'));

  const timeEnd = generateIcsCalendar([{
    id: 2,
    timestart: 1788753600,
    timeend: 1788760800,
  }]);
  assert.ok(timeEnd.includes('DTEND:20260907T060000Z\r\n'));
});

test('getAssignmentDetails extracts Moodle 4+ activity-dates, full main attachments, and cleaned comments', async () => {
  const client = new MoodleClient();
  const mockMoodle4Html = `
    <h2>Capstone Research Manuscript</h2>
    <div id="region-main" role="main">
      <div class="activity-information">
        <div data-region="activity-dates">
          <div><strong>Opened:</strong> Monday, 1 September 2026, 8:00 AM</div>
          <div><strong>Due:</strong> Monday, 15 September 2026, 11:59 PM</div>
        </div>
      </div>
      <div id="intro" class="box generalbox">
        <div class="no-overflow">
          <p>Please review the manuscript guidelines.</p>
        </div>
      </div>
      <div class="attachments">
        <a href="https://elearning.vsu.edu.ph/pluginfile.php/555/mod_assign/intro/Manuscript_Guidelines_2026.pdf">Manuscript_Guidelines_2026.pdf</a>
        <a href="https://elearning.vsu.edu.ph/pluginfile.php/555/mod_assign/intro/Grading_Rubric_Scoring.docx">Grading_Rubric_Scoring.docx</a>
      </div>
      <table class="generaltable">
        <tr><th>Attempt number</th><td>This is attempt 1.</td></tr>
        <tr><th>Submission status</th><td>Submitted for grading</td></tr>
        <tr><th>Grading status</th><td>Not graded</td></tr>
        <tr><th>Time remaining</th><td>Assignment was submitted 3 days early</td></tr>
        <tr><th>Submission comments</th><td>___picture___ ___name___ - ___time___ ___content___ Show comments Comments (2) Save comment | Cancel</td></tr>
      </table>
    </div>
  `;

  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({
      ok: true,
      text: async () => mockMoodle4Html,
    });

    const details = await client.getAssignmentDetails(777);
    assert.equal(details.id, 777);
    assert.equal(details.title, 'Capstone Research Manuscript');
    assert.equal(details.dueDate, 'Monday, 15 September 2026, 11:59 PM');
    assert.equal(details.openedDate, 'Monday, 1 September 2026, 8:00 AM');
    assert.equal(details.isSubmitted, true);
    assert.equal(details.isOverdue, false);

    // Comments cleaned properly
    assert.ok(details.submissionComments.includes('2 comment(s)'));
    assert.ok(!details.submissionComments.includes('___picture___'));

    // Attachments parsed across full main content area
    assert.equal(details.attachments.length, 2);
    assert.ok(details.attachments.some(a => a.name === 'Manuscript_Guidelines_2026.pdf'));
    assert.ok(details.attachments.some(a => a.name === 'Grading_Rubric_Scoring.docx'));
    assert.equal(details.rubricAttachments.length, 2);
    assert.ok(details.rubricAttachments.some(a => a.name === 'Grading_Rubric_Scoring.docx'));
    assert.ok(details.rubricAttachments.some(a => a.name === 'Manuscript_Guidelines_2026.pdf'));
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('exportCalendarIcs merges native Moodle export with course assignment deadlines', async () => {
  const client = new MoodleClient();
  client.sesskey = 'dummy_sesskey';
  const tmpFile = path.join(os.tmpdir(), `test_merge_cal_${Date.now()}.ics`);

  const mockMoodleExport = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:1001@elearning.vsu.edu.ph
SUMMARY:Quiz 1 closes
DTSTART:20260910T120000Z
DTEND:20260910T130000Z
CATEGORIES:CSci 193
END:VEVENT
END:VCALENDAR`;

  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      if (String(url).includes('/calendar/export.php')) {
        return {
          ok: true,
          text: async () => mockMoodleExport,
        };
      }
      return { ok: false };
    };

    client.getTimeline = async () => [];
    client.getAssignments = async () => [
      {
        id: 2002,
        name: 'Sprint 1 Backlog Submission',
        coursename: 'CSci 144',
        duedate: 'Friday, 18 September 2026, 5:00 PM',
        submissionStatus: 'No submission',
        grade: '-',
        link: 'https://elearning.vsu.edu.ph/mod/assign/view.php?id=2002',
      },
    ];

    const res = await client.exportCalendarIcs(tmpFile);
    assert.equal(res.fetchedFromMoodle, true);
    assert.equal(res.eventCount, 2, 'Should merge 1 Moodle export event + 1 assignment deadline');

    const content = await fs.readFile(tmpFile, 'utf8');
    assert.ok(content.includes('Quiz 1 closes'), 'Must contain Moodle export quiz');
    assert.ok(content.includes('Sprint 1 Backlog Submission Due'), 'Must contain assignment deadline');
    assert.ok(content.includes('BEGIN:VALARM'), 'Must include reminder alarms');
  } finally {
    globalThis.fetch = origFetch;
    try { await fs.unlink(tmpFile); } catch {}
  }
});

test('formatIcsDate robustly resolves date strings without explicit 4-digit years to current year', () => {
  const currentYear = new Date().getFullYear();
  const dateWithoutYear = 'Monday, 7 September, 12:00 PM';
  const icsDate = formatIcsDate(dateWithoutYear);
  assert.ok(icsDate.startsWith(String(currentYear)), `Date ${icsDate} should start with current year ${currentYear}`);
  assert.ok(icsDate.includes('0907T'), `Date ${icsDate} should contain month and day (0907)`);

  const dateWithoutYear2 = '7 September, 12:00 PM';
  const icsDate2 = formatIcsDate(dateWithoutYear2);
  assert.ok(icsDate2.startsWith(String(currentYear)), `Date ${icsDate2} should start with current year ${currentYear}`);
});

test('getAssignmentDetails extracts online text submissions and teacher feedback comments', async () => {
  const client = new MoodleClient();
  const mockHtml = `
    <h2>Online Pitch Video</h2>
    <div id="region-main">
      <div id="intro"><p>Upload link to your YouTube video.</p></div>
      <table class="generaltable">
        <tr><th>Submission status</th><td>Submitted for grading</td></tr>
        <tr><th>Grading status</th><td>Graded</td></tr>
        <tr><th>Due date</th><td>Friday, 8 May 2026, 5:00 PM</td></tr>
        <tr>
          <th>Online text</th>
          <td>
            <div class="box py-3 plugincontentsummary">
              <div class="no-overflow"><p>https://youtube.com/shorts/sample123<br /></p></div>
            </div>
          </td>
        </tr>
        <tr>
          <th>Feedback comments</th>
          <td>
            <div class="no-overflow"><p>Excellent delivery and posture!</p></div>
          </td>
        </tr>
        <tr>
          <th>Submission comments</th>
          <td>___picture___ ___name___ - ___time___ ___content___ Show comments Comments (1) Save comment | Cancel</td>
        </tr>
      </table>
    </div>
  `;

  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({
      ok: true,
      text: async () => mockHtml,
    });

    const details = await client.getAssignmentDetails(888);
    assert.equal(details.id, 888);
    assert.equal(details.isSubmitted, true);
    assert.equal(details.isGraded, true);
    assert.equal(details.onlineText, 'https://youtube.com/shorts/sample123');
    assert.equal(details.feedbackComments, 'Excellent delivery and posture!');
    assert.equal(details.submissionComments, '1 comment(s)');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('downloadAssignmentAttachments downloads files in parallel using bounded concurrency pool', async () => {
  const client = new MoodleClient();
  const tmpDir = path.join(os.tmpdir(), `test_assign_att_${Date.now()}`);

  client.getAssignmentDetails = async () => ({
    id: 999,
    title: 'Lab 4 Assignment',
    attachments: [
      { name: 'lab4_spec.pdf', url: 'https://elearning.vsu.edu.ph/spec.pdf' },
      { name: 'starter_code.zip', url: 'https://elearning.vsu.edu.ph/code.zip' },
    ],
  });

  const downloadedUrls = [];
  client.downloadResource = async (url, dest) => {
    downloadedUrls.push(url);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, 'mock-binary', 'utf8');
    return { savedPath: dest, size: 11, skipped: false };
  };

  try {
    const started = [];
    const res = await client.downloadAssignmentAttachments(999, tmpDir, {
      concurrency: 2,
      onStart: (ev) => started.push(ev.index),
    });

    assert.equal(res.id, 999);
    assert.equal(res.downloadCount, 2);
    assert.equal(downloadedUrls.length, 2);
    assert.equal(started.length, 2);
  } finally {
    try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch {}
  }
});


