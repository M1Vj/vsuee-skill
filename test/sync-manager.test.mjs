import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SyncManager, hashData, expandHome } from '../lib/sync-manager.mjs';
import { MoodleClient } from '../lib/moodle-client.mjs';

test('hashData generates consistent and deterministic hashes', () => {
  const h1 = hashData({ a: 1, b: 'test' });
  const h2 = hashData({ a: 1, b: 'test' });
  const h3 = hashData({ a: 2, b: 'test' });

  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
  assert.equal(typeof h1, 'string');
  assert.equal(h1.length, 16);
});

test('SyncManager diff: initial baseline snapshot has no changes', () => {
  const sm = new SyncManager();
  const snapshot = {
    timestamp: '2026-09-06T12:00:00Z',
    courseCount: 2,
    courses: [
      { id: 100, fullname: 'Course A', sections: [{ number: 0, name: 'Gen', activities: [{ id: 1 }] }] },
      { id: 200, fullname: 'Course B', sections: [] },
    ],
  };

  const diff = sm.diffSnapshots(null, snapshot);
  assert.equal(diff.isInitial, true);
  assert.equal(diff.hasChanges, false);
  assert.match(diff.summary, /Baseline snapshot established/);
});

test('SyncManager diff: detects newly added module and unhidden section', () => {
  const sm = new SyncManager();
  const oldSnap = {
    timestamp: '2026-09-05T10:00:00Z',
    courses: [{
      id: 1610,
      fullname: 'CSci 144',
      sections: [
        {
          number: 0,
          name: 'General',
          hidden: false,
          activities: [{ id: 1, type: 'forum', name: 'Announcements', link: 'http://a', hidden: false }]
        },
        {
          number: 1,
          name: 'Midterms',
          hidden: true,
          activities: []
        }
      ]
    }],
    assignments: [],
  };

  const newSnap = {
    timestamp: '2026-09-06T10:00:00Z',
    courses: [{
      id: 1610,
      fullname: 'CSci 144',
      sections: [
        {
          number: 0,
          name: 'General',
          hidden: false,
          activities: [
            { id: 1, type: 'forum', name: 'Announcements', link: 'http://a', hidden: false },
            { id: 2, type: 'resource', name: 'Lecture 1 Slides', link: 'http://b', hidden: false, fileType: 'pdf' }
          ]
        },
        {
          number: 1,
          name: 'Midterms',
          hidden: false,
          activities: []
        }
      ]
    }],
    assignments: [],
  };

  const diff = sm.diffSnapshots(oldSnap, newSnap);
  assert.equal(diff.hasChanges, true);
  assert.equal(diff.totalChangeCount, 2);
  assert.equal(diff.changes.modulesAdded.length, 1);
  assert.equal(diff.changes.modulesAdded[0].name, 'Lecture 1 Slides');
  assert.equal(diff.changes.modulesAdded[0].fileType, 'pdf');
  assert.equal(diff.changes.sectionsUnhidden.length, 1);
  assert.equal(diff.changes.sectionsUnhidden[0].sectionName, 'Midterms');

  const report = sm.formatDiffReport(diff);
  assert.match(report, /NEW LESSONS & MATERIALS ADDED/);
  assert.match(report, /Lecture 1 Slides/);
  assert.match(report, /PREVIOUSLY HIDDEN CONTENT REVEALED/);
  assert.match(report, /Midterms/);
});

test('SyncManager diff: detects deadline change and submission status change', () => {
  const sm = new SyncManager();
  const oldSnap = {
    timestamp: '2026-09-05T10:00:00Z',
    courses: [{ id: 100, fullname: 'Course 1', sections: [] }],
    assignments: [
      {
        id: 501,
        courseid: 100,
        coursename: 'Course 1',
        name: 'Project 1',
        duedate: 'Friday, 12 Sept 2026, 11:59 PM',
        submissionStatus: 'No attempt',
        grade: 'No grade',
      }
    ],
  };

  const newSnap = {
    timestamp: '2026-09-06T10:00:00Z',
    courses: [{ id: 100, fullname: 'Course 1', sections: [] }],
    assignments: [
      {
        id: 501,
        courseid: 100,
        coursename: 'Course 1',
        name: 'Project 1',
        duedate: 'Monday, 15 Sept 2026, 11:59 PM',
        submissionStatus: 'Submitted for grading',
        grade: 'No grade',
      }
    ],
  };

  const diff = sm.diffSnapshots(oldSnap, newSnap);
  assert.equal(diff.hasChanges, true);
  assert.equal(diff.changes.deadlinesChanged.length, 1);
  assert.equal(diff.changes.deadlinesChanged[0].oldDate, 'Friday, 12 Sept 2026, 11:59 PM');
  assert.equal(diff.changes.deadlinesChanged[0].newDate, 'Monday, 15 Sept 2026, 11:59 PM');
  assert.equal(diff.changes.submissionStatusChanged.length, 1);
  assert.equal(diff.changes.submissionStatusChanged[0].newStatus, 'Submitted for grading');

  const report = sm.formatDiffReport(diff);
  assert.match(report, /DEADLINE \/ DUE DATE CHANGES/);
  assert.match(report, /WAS: Friday, 12 Sept/);
  assert.match(report, /NOW: Monday, 15 Sept/);
  assert.match(report, /SUBMISSION & GRADE UPDATES/);
});

test('SyncManager diff: handles course enrollment additions and drops', () => {
  const sm = new SyncManager();
  const oldSnap = {
    timestamp: '2026-09-01T00:00:00Z',
    courses: [{ id: 100, fullname: 'Course Old', sections: [] }],
    assignments: [],
  };

  const newSnap = {
    timestamp: '2026-09-06T00:00:00Z',
    courses: [{ id: 200, fullname: 'Course New', sections: [] }],
    assignments: [],
  };

  const diff = sm.diffSnapshots(oldSnap, newSnap);
  assert.equal(diff.hasChanges, true);
  assert.equal(diff.changes.coursesAdded.length, 1);
  assert.equal(diff.changes.coursesAdded[0].id, 200);
  assert.equal(diff.changes.coursesRemoved.length, 1);
  assert.equal(diff.changes.coursesRemoved[0].id, 100);

  const report = sm.formatDiffReport(diff);
  assert.match(report, /NEW COURSE ENROLLMENTS/);
  assert.match(report, /COURSES UNENROLLED OR REMOVED/);
});

test('SyncManager persistence and rotation', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vsuee_test_'));
  try {
    const sm = new SyncManager({ snapshotsDir: tmpDir });
    await sm.init();

    const snap1 = { timestamp: '2026-09-01T00:00:00Z', courseCount: 1, courses: [], assignments: [] };
    await sm.saveSnapshot(snap1);

    const loaded1 = await sm.getLatestSnapshot();
    assert.equal(loaded1.timestamp, '2026-09-01T00:00:00Z');
    assert.equal(await sm.getPreviousSnapshot(), null);

    // Save snap2 -> snap1 becomes previous
    const snap2 = { timestamp: '2026-09-02T00:00:00Z', courseCount: 2, courses: [], assignments: [] };
    await sm.saveSnapshot(snap2);

    const loadedLatest = await sm.getLatestSnapshot();
    const loadedPrev = await sm.getPreviousSnapshot();
    assert.equal(loadedLatest.timestamp, '2026-09-02T00:00:00Z');
    assert.equal(loadedPrev.timestamp, '2026-09-01T00:00:00Z');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('SyncManager diff: detects section summary, renamed, hidden items, and grade updates', () => {
  const sm = new SyncManager();
  const oldSnap = {
    timestamp: '2026-09-05T00:00:00Z',
    courses: [{
      id: 100,
      fullname: 'CS 101',
      sections: [
        {
          number: 1,
          name: 'Old Topic Name',
          hidden: false,
          summary: 'Old syllabus notes',
          activities: [
            { id: 10, type: 'resource', name: 'File 1', link: 'http://f1', hidden: false, description: 'Read page 1' },
            { id: 11, type: 'quiz', name: 'Quiz 1', link: 'http://q1', hidden: false },
          ]
        },
        {
          number: 2,
          name: 'Topic 2',
          hidden: false,
          summary: '',
          activities: []
        }
      ]
    }],
    assignments: [
      { id: 201, courseid: 100, coursename: 'CS 101', name: 'Lab 1', duedate: 'Sept 10', submissionStatus: 'Submitted', grade: 'No grade' }
    ],
    timeline: [
      { id: 301, name: 'Quiz 1 closes', coursename: 'CS 101', formattedtime: 'Sept 10, 11:59 PM' }
    ]
  };

  const newSnap = {
    timestamp: '2026-09-06T00:00:00Z',
    courses: [{
      id: 100,
      fullname: 'CS 101',
      sections: [
        {
          number: 1,
          name: 'New Topic Name',
          hidden: true, // Concealed section
          summary: 'Updated syllabus notes: Zoom link added',
          activities: [
            { id: 10, type: 'resource', name: 'File 1', link: 'http://f1', hidden: false, description: 'Read pages 1 to 20' }
          ]
        },
        {
          number: 2,
          name: 'Topic 2',
          hidden: false,
          summary: '',
          activities: [
            // Moved Quiz 1 from section 1 to section 2, and hid it
            { id: 11, type: 'quiz', name: 'Quiz 1', link: 'http://q1', hidden: true }
          ]
        }
      ]
    }],
    assignments: [
      // Grade updated without submission status change
      { id: 201, courseid: 100, coursename: 'CS 101', name: 'Lab 1', duedate: 'Sept 10', submissionStatus: 'Submitted', grade: '98/100' }
    ],
    timeline: [
      { id: 301, name: 'Quiz 1 closes', coursename: 'CS 101', formattedtime: 'Sept 10, 11:59 PM' },
      { id: 302, name: 'Midterm Exam Opens', coursename: 'CS 101', formattedtime: 'Sept 15, 8:00 AM' }
    ]
  };

  const diff = sm.diffSnapshots(oldSnap, newSnap);
  assert.equal(diff.hasChanges, true);

  // Check section summary change
  assert.equal(diff.changes.sectionsSummaryUpdated.length, 1);
  assert.equal(diff.changes.sectionsSummaryUpdated[0].newSummary, 'Updated syllabus notes: Zoom link added');

  // Check renamed section
  assert.equal(diff.changes.sectionsRenamed.length, 1);
  assert.equal(diff.changes.sectionsRenamed[0].oldName, 'Old Topic Name');
  assert.equal(diff.changes.sectionsRenamed[0].newName, 'New Topic Name');

  // Check hidden section and hidden module
  assert.equal(diff.changes.sectionsHidden.length, 1);
  assert.equal(diff.changes.modulesHidden.length, 1);
  assert.equal(diff.changes.modulesHidden[0].id, 11);

  // Check module description change
  assert.equal(diff.changes.modulesUpdated.length, 2);
  const file1Update = diff.changes.modulesUpdated.find(m => m.id === 10);
  assert.ok(file1Update.changes.some(c => c.includes('Instructions/notes updated')));

  // Check module section move
  const quiz1Update = diff.changes.modulesUpdated.find(m => m.id === 11);
  assert.ok(quiz1Update.changes.some(c => c.includes('Moved from Section 1')));

  // Check grade update
  assert.equal(diff.changes.gradesUpdated.length, 1);
  assert.equal(diff.changes.gradesUpdated[0].oldGrade, 'No grade');
  assert.equal(diff.changes.gradesUpdated[0].newGrade, '98/100');

  // Check timeline added
  assert.equal(diff.changes.timelineAdded.length, 1);
  assert.equal(diff.changes.timelineAdded[0].name, 'Midterm Exam Opens');

  // Verify formatDiffReport prints all categories
  const report = sm.formatDiffReport(diff);
  assert.match(report, /RENAMED SECTIONS/);
  assert.match(report, /SECTION SUMMARY & ANNOUNCEMENT UPDATES/);
  assert.match(report, /CONTENT HIDDEN BY INSTRUCTORS/);
  assert.match(report, /NEW GRADES POSTED BY INSTRUCTORS/);
  assert.match(report, /NEW CALENDAR EVENTS & QUIZ WINDOWS/);
  assert.match(report, /UPDATED LESSONS \/ FILES \/ DESCRIPTIONS/);
});

test('SyncManager buildSnapshot single-course merges without truncating other courses', async () => {
  const sm = new SyncManager();

  const mockClient = {
    checkStatus: async () => ({ authenticated: true, user: { id: 1, fullname: 'Student' } }),
    getCourseContents: async (id) => ({
      id,
      title: `Course ${id} Updated`,
      url: `http://c/${id}`,
      sections: [{ number: 1, name: 'T1', activities: [{ id: 99, type: 'resource', name: 'New Slide' }] }]
    }),
    getAssignments: async () => [
      { id: 701, courseid: 200, name: 'Assign 200', duedate: 'D1', submissionStatus: 'S1', grade: 'G1' }
    ],
    getTimeline: async () => [],
    baseUrl: 'https://elearning.vsu.edu.ph',
  };

  const baseSnapshot = {
    version: 1,
    timestamp: '2026-09-01T00:00:00Z',
    courseCount: 3,
    courses: [
      { id: 100, fullname: 'Course 100', sections: [] },
      { id: 200, fullname: 'Course 200', sections: [] },
      { id: 300, fullname: 'Course 300', sections: [] }
    ],
    assignments: [
      { id: 700, courseid: 100, name: 'Assign 100', duedate: 'D0', submissionStatus: 'S0', grade: 'G0' }
    ],
    timeline: []
  };

  // Syncing only course 200 with baseSnapshot should merge, NOT delete courses 100 and 300
  const merged = await sm.buildSnapshot({
    client: mockClient,
    courseId: 200,
    baseSnapshot,
  });

  assert.equal(merged.courseCount, 3);
  assert.deepEqual(merged.courses.map(c => c.id), [100, 200, 300]);
  assert.equal(merged.courses.find(c => c.id === 200).fullname, 'Course 200 Updated');
  // Assignments for course 100 preserved, course 200 assignment added
  assert.equal(merged.assignments.length, 2);
  assert.ok(merged.assignments.some(a => a.courseid === 100));
  assert.ok(merged.assignments.some(a => a.courseid === 200));
});

test('SyncManager autoDownloadNewMaterials collects from unhidden and updated items', async () => {
  const sm = new SyncManager();

  const downloadedUrls = [];
  const mockClient = {
    downloadResource: async (url, targetPath, options) => {
      downloadedUrls.push({ url, targetPath, force: options?.force });
      return { savedPath: targetPath, size: 1234, skipped: false };
    }
  };

  const diffResult = {
    hasChanges: true,
    changes: {
      modulesAdded: [
        { type: 'resource', name: 'Add1.pdf', link: 'http://add1', sectionNumber: 1, sectionName: 'Topic 1', courseName: 'CS1' }
      ],
      modulesUnhidden: [
        { type: 'resource', name: 'Unhide1.pdf', link: 'http://unhide1', sectionNumber: 2, sectionName: 'Topic 2', courseName: 'CS1' }
      ],
      modulesUpdated: [
        {
          type: 'resource',
          name: 'Update1.pptx',
          link: 'http://update1',
          sectionNumber: 1,
          sectionName: 'Topic 1',
          courseName: 'CS1',
          changes: ['Link updated']
        }
      ]
    }
  };

  const summary = await sm.autoDownloadNewMaterials(mockClient, diffResult, '/tmp/vsuee_dl');
  assert.equal(summary.downloaded, 3);
  assert.equal(downloadedUrls.length, 3);

  // Check that update1 was requested with force: true
  const updateReq = downloadedUrls.find(d => d.url === 'http://update1');
  assert.equal(updateReq.force, true);

  // Check consistent directory structure
  assert.match(downloadedUrls[0].targetPath, /1_Topic 1[\/\\]Add1\.pdf/);
  assert.match(downloadedUrls[1].targetPath, /2_Topic 2[\/\\]Unhide1\.pdf/);
});

test('SyncManager diff: detects sections reordered via persistent section database IDs', () => {
  const sm = new SyncManager();
  const oldSnap = {
    timestamp: '2026-09-01T00:00:00Z',
    courses: [{
      id: 1610,
      fullname: 'CSci 144',
      sections: [
        { id: 9001, number: 1, name: 'Syllabus', activities: [] },
        { id: 9002, number: 2, name: 'Module 1 Architecture', activities: [] },
      ]
    }],
    assignments: [],
  };

  const newSnap = {
    timestamp: '2026-09-06T00:00:00Z',
    courses: [{
      id: 1610,
      fullname: 'CSci 144',
      sections: [
        // Instructor swapped sections: Module 1 is now section 1, Syllabus is now section 2
        { id: 9002, number: 1, name: 'Module 1 Architecture', activities: [] },
        { id: 9001, number: 2, name: 'Syllabus', activities: [] },
      ]
    }],
    assignments: [],
  };

  const diff = sm.diffSnapshots(oldSnap, newSnap);
  assert.equal(diff.hasChanges, true);
  assert.equal(diff.changes.sectionsReordered.length, 2);

  const reordered1 = diff.changes.sectionsReordered.find(s => s.sectionName === 'Module 1 Architecture');
  assert.equal(reordered1.oldNumber, 2);
  assert.equal(reordered1.newNumber, 1);

  const reordered2 = diff.changes.sectionsReordered.find(s => s.sectionName === 'Syllabus');
  assert.equal(reordered2.oldNumber, 1);
  assert.equal(reordered2.newNumber, 2);

  const report = sm.formatDiffReport(diff);
  assert.match(report, /REORDERED SECTIONS/);
  assert.match(report, /Module 1 Architecture/);
});

test('SyncManager diff: detects coursesUnhidden and coursesHidden transitions', () => {
  const sm = new SyncManager();
  const oldSnap = {
    timestamp: '2026-09-01T00:00:00Z',
    courses: [
      { id: 100, fullname: 'Course A', hidden: true, sections: [] },
      { id: 200, fullname: 'Course B', hidden: false, sections: [] },
    ],
    assignments: [],
  };

  const newSnap = {
    timestamp: '2026-09-06T00:00:00Z',
    courses: [
      // Course A is revealed (unhidden)
      { id: 100, fullname: 'Course A', hidden: false, sections: [] },
      // Course B is archived / hidden
      { id: 200, fullname: 'Course B', hidden: true, sections: [] },
    ],
    assignments: [],
  };

  const diff = sm.diffSnapshots(oldSnap, newSnap);
  assert.equal(diff.hasChanges, true);
  assert.equal(diff.changes.coursesUnhidden.length, 1);
  assert.equal(diff.changes.coursesUnhidden[0].id, 100);
  assert.equal(diff.changes.coursesHidden.length, 1);
  assert.equal(diff.changes.coursesHidden[0].id, 200);

  const report = sm.formatDiffReport(diff);
  assert.match(report, /COURSES ACTIVATED \/ UNHIDDEN/);
  assert.match(report, /COURSES CONCEALED \/ ARCHIVED/);
});

test('SyncManager expandHome resolves tilde and preserves non-string and relative values', () => {
  assert.equal(expandHome('~'), os.homedir());
  assert.equal(expandHome('~/test_dir'), path.join(os.homedir(), 'test_dir'));
  assert.equal(expandHome(null), null);
  assert.equal(expandHome(undefined), undefined);
  assert.equal(expandHome(999), 999);
});

test('SyncManager notifySystem handles special characters safely without throwing', () => {
  const sm = new SyncManager();
  // Should not throw even with quotes, backticks, newlines, and unicode
  assert.doesNotThrow(() => {
    sm.notifySystem('VSUEE "Instructor\'s" Notice', 'New update: `File $1 & "quotes"`\nLine 2');
  });
});


function collectionBaseline() {
  return {
    version: 1,
    timestamp: '2026-09-01T00:00:00Z',
    user: { id: 1, fullname: 'Synthetic student' },
    courseCount: 2,
    totalModules: 0,
    courses: [10, 20].map(id => ({ id, fullname: `Synthetic ${id}`, sections: [] })),
    assignments: [10, 20].map((courseid, i) => ({
      id: 51 + i, courseid, name: `Synthetic assignment ${i}`, duedate: 'Tomorrow',
      submissionStatus: 'No attempt', grade: 'No grade',
    })),
    timeline: [{ id: 71, courseid: 10, name: 'Synthetic deadline', formattedtime: 'Tomorrow' }],
  };
}

function collectionClient(base = collectionBaseline()) {
  return {
    baseUrl: 'https://synthetic.invalid',
    checkStatus: async () => ({ authenticated: true, user: base.user }),
    getCourses: async () => base.courses,
    getCourseContents: async id => ({ title: `Synthetic ${id}`, sections: [] }),
    getAssignments: async () => [],
    getTimeline: async () => [],
  };
}

async function withCollectionManager(run) {
  const snapshotsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vsuee_collections_'));
  try {
    await run(new SyncManager({ snapshotsDir }));
  } finally {
    await fs.rm(snapshotsDir, { recursive: true, force: true });
  }
}

for (const courseId of [null, 10]) {
  for (const collection of ['assignments', 'timeline']) {
    test(`buildSnapshot ${courseId ? 'single-course' : 'full'} ${collection} failure leaves saved snapshots and freshness unchanged`, async () => {
      await withCollectionManager(async sm => {
        const base = collectionBaseline();
        await sm.saveSnapshot({ ...base, timestamp: '2026-08-31T00:00:00Z' });
        await sm.saveSnapshot(base);
        const files = [sm.latestFile, sm.previousFile, sm.manifestFile];
        const before = await Promise.all(files.map(file => fs.readFile(file, 'utf8')));
        const client = collectionClient(base);
        const method = collection === 'assignments' ? 'getAssignments' : 'getTimeline';
        for (const failure of ['reject', 'invalid']) {
          client[method] = async () => {
            if (failure === 'reject') throw new Error('https://synthetic.invalid/?sesskey=synthetic-private-marker');
            return null;
          };
          await assert.rejects(async () => {
            const snapshot = await sm.buildSnapshot({ client, courseId });
            await sm.saveSnapshot(snapshot);
          }, err => {
            assert.match(err.message, /Unable to fetch.*Snapshot not updated; please retry/);
            assert.doesNotMatch(err.message, /synthetic-private-marker|sesskey|https:/);
            return true;
          });
          assert.deepEqual(await Promise.all(files.map(file => fs.readFile(file, 'utf8'))), before);
        }
        assert.deepEqual(base, collectionBaseline());
      });
    });
  }

  test(`buildSnapshot ${courseId ? 'single-course' : 'full'} successful empty collections clear only the intended assignments and all timeline data`, async () => {
    await withCollectionManager(async sm => {
      const base = collectionBaseline();
      const snapshot = await sm.buildSnapshot({ client: collectionClient(base), baseSnapshot: base, courseId });
      assert.deepEqual(snapshot.assignments.map(a => a.id), courseId ? [52] : []);
      assert.deepEqual(snapshot.timeline, []);
      assert.deepEqual(sm.diffSnapshots(base, snapshot).changes.assignmentsRemoved.map(a => a.id), courseId ? [51] : [51, 52]);
      assert.deepEqual(base, collectionBaseline());
    });
  });
}

test('buildSnapshot requests complete collections and preserves successful single-course merges', async () => {
  await withCollectionManager(async sm => {
    const base = collectionBaseline();
    const client = collectionClient(base);
    const calls = [];
    client.getCourses = async options => { calls.push(['courses', options]); return base.courses; };
    client.getAssignments = async (courseId, options) => {
      calls.push(['assignments', courseId, options]);
      return [{ ...base.assignments[0], grade: 'Synthetic updated grade' }];
    };
    client.getTimeline = async (limit, options) => {
      calls.push(['timeline', limit, options]);
      return [{ ...base.timeline[0], formattedtime: 'Later' }];
    };
    await sm.buildSnapshot({ client, baseSnapshot: base });
    assert.deepEqual(calls, [
      ['courses', { all: true, strict: true }],
      ['assignments', null, { strict: true }],
      ['timeline', 30, { strict: true }],
    ]);
    calls.length = 0;
    const snapshot = await sm.buildSnapshot({ client, baseSnapshot: base, courseId: 10 });
    assert.deepEqual(calls, [['assignments', 10, { strict: true }], ['timeline', 30, { strict: true }]]);
    assert.deepEqual(snapshot.assignments.map(a => a.id), [52, 51]);
    assert.equal(snapshot.timeline[0].formattedtime, 'Later');
    assert.deepEqual(snapshot.courses.map(c => c.id), [10, 20]);
  });
});

test('buildSnapshot catalog failure is sanitized and stops before assignments', async () => {
  await withCollectionManager(async sm => {
    const client = collectionClient();
    client.getAssignments = async () => assert.fail('Assignments must not run after a failed catalog');
    for (const failure of ['reject', 'invalid']) {
      client.getCourses = async () => {
        if (failure === 'reject') throw new Error('https://synthetic.invalid/?sesskey=synthetic-private-marker');
        return null;
      };
      await assert.rejects(sm.buildSnapshot({ client }), err => {
        assert.equal(err.message, 'Unable to fetch the course catalog. Snapshot not updated; please retry.');
        return true;
      });
    }
    assert.equal(await sm.getLatestSnapshot(), null);
  });
});

test('buildSnapshot initial collection failure creates no baseline; later success recovers cleanly', async () => {
  await withCollectionManager(async sm => {
    const client = collectionClient();
    client.getAssignments = async () => { throw new Error('synthetic unavailable'); };
    await assert.rejects(async () => sm.saveSnapshot(await sm.buildSnapshot({ client })), /Snapshot not updated/);
    assert.equal(await sm.getLatestSnapshot(), null);
    client.getAssignments = async () => [];
    const snapshot = await sm.buildSnapshot({ client });
    assert.equal(sm.diffSnapshots(null, snapshot).isInitial, true);
    await sm.saveSnapshot(snapshot);
    assert.deepEqual((await sm.getLatestSnapshot()).assignments, []);
    assert.deepEqual((await sm.getLatestSnapshot()).timeline, []);
  });
});


test('buildSnapshot rejects real client partial assignments and recovers without false removals', async () => {
  await withCollectionManager(async sm => {
    const base = collectionBaseline();
    await sm.saveSnapshot(base);
    const before = await fs.readFile(sm.latestFile, 'utf8');
    const client = new MoodleClient({ baseUrl: 'https://synthetic.invalid' });
    client.checkStatus = async () => ({ authenticated: true, user: base.user });
    client.getCourses = async () => base.courses;
    client.getCourseContents = async id => ({ title: `Synthetic ${id}`, sections: [] });
    client.getTimeline = async () => [];
    let unavailable = true;
    client.fetchWithAuth = async url => {
      const courseId = Number(new URL(url).searchParams.get('id'));
      if (unavailable && courseId === 20) return { ok: false, status: 503, text: async () => '' };
      const id = courseId === 10 ? 51 : 52;
      return { ok: true, text: async () => `<tr class="assignment"><td>Topic</td><td><a href="https://elearning.vsu.edu.ph/mod/assign/view.php?id=${id}">Synthetic assignment</a></td><td>Tomorrow</td><td>No attempt</td><td>No grade</td></tr>` };
    };
    await assert.rejects(async () => sm.saveSnapshot(await sm.buildSnapshot({ client })), /Unable to fetch all assignments/);
    assert.equal(await fs.readFile(sm.latestFile, 'utf8'), before);
    unavailable = false;
    const snapshot = await sm.buildSnapshot({ client });
    assert.deepEqual(snapshot.assignments.map(a => a.id), [51, 52]);
    assert.deepEqual(sm.diffSnapshots(base, snapshot).changes.assignmentsRemoved, []);
  });
});

test('failed collection fetch does not relabel an existing snapshot under another account', async () => {
  await withCollectionManager(async sm => {
    const base = collectionBaseline();
    await sm.saveSnapshot(base);
    const before = await fs.readFile(sm.latestFile, 'utf8');
    const client = collectionClient(base);
    client.checkStatus = async () => ({ authenticated: true, user: { id: 2, fullname: 'Other synthetic student' } });
    client.getTimeline = async () => { throw new Error('synthetic unavailable'); };
    for (const courseId of [null, 10]) {
      await assert.rejects(async () => sm.saveSnapshot(await sm.buildSnapshot({ client, courseId })), /Unable to fetch the timeline/);
      assert.equal(await fs.readFile(sm.latestFile, 'utf8'), before);
    }
  });
});
