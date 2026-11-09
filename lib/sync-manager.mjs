import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { exec, execFile } from 'node:child_process';
import { asyncPool, expandHome } from './moodle-client.mjs';

export { expandHome };

const CONFIG_DIR = path.join(os.homedir(), '.config', 'vsuee');
const SNAPSHOTS_DIR = path.join(CONFIG_DIR, 'snapshots');
const LATEST_FILE = path.join(SNAPSHOTS_DIR, 'latest.json');
const PREVIOUS_FILE = path.join(SNAPSHOTS_DIR, 'previous.json');
const MANIFEST_FILE = path.join(SNAPSHOTS_DIR, 'manifest.json');

/**
 * Utility to compute a hash for an object or string
 */
export function hashData(data) {
  const str = typeof data === 'string' ? data : JSON.stringify(data);
  return crypto.createHash('sha256').update(str).digest('hex').slice(0, 16);
}

export class SyncManager {
  constructor(options = {}) {
    this.configDir = options.configDir || CONFIG_DIR;
    this.snapshotsDir = options.snapshotsDir || SNAPSHOTS_DIR;
    this.latestFile = path.join(this.snapshotsDir, 'latest.json');
    this.previousFile = path.join(this.snapshotsDir, 'previous.json');
    this.manifestFile = path.join(this.snapshotsDir, 'manifest.json');
  }

  async init() {
    if (!fsSync.existsSync(this.snapshotsDir)) {
      await fs.mkdir(this.snapshotsDir, { recursive: true, mode: 0o700 });
    }
  }

  async getLatestSnapshot() {
    try {
      if (fsSync.existsSync(this.latestFile)) {
        const raw = await fs.readFile(this.latestFile, 'utf8');
        return JSON.parse(raw);
      }
    } catch {
      // ignore
    }
    return null;
  }

  async getPreviousSnapshot() {
    try {
      if (fsSync.existsSync(this.previousFile)) {
        const raw = await fs.readFile(this.previousFile, 'utf8');
        return JSON.parse(raw);
      }
    } catch {
      // ignore
    }
    return null;
  }

  /**
   * Builds a deep, normalized snapshot of the user's Moodle courses, sections,
   * modules, assignments, and upcoming deadlines.
   */
  async buildSnapshot({ client, classification = 'all', includeHidden = false, courseId = null, baseSnapshot = null, onProgress = null } = {}) {
    await this.init();

    if (!client) {
      throw new Error('MoodleClient instance is required to build a snapshot.');
    }

    const status = await client.checkStatus();
    if (!status.authenticated) {
      if (status.isNetworkError) {
        throw new Error(`Network error connecting to VSUEE: ${status.reason}`);
      }
      throw new Error('Moodle session is not authenticated. Please run `vsuee login` or check session.');
    }

    const timestamp = new Date().toISOString();
    const effectiveBaseSnapshot = baseSnapshot || (await this.getLatestSnapshot());

    let coursesToScan = [];

    if (courseId) {
      // Single course snapshot
      coursesToScan = [{ id: parseInt(courseId, 10), fullname: `Course ${courseId}` }];
    } else {
      if (onProgress) onProgress({ phase: 'courses', message: 'Discovering course catalog...' });
      try {
        coursesToScan = await client.getCourses({ all: true, strict: true });
        if (!Array.isArray(coursesToScan)) throw new Error('Invalid course catalog');
      } catch {
        throw new Error('Unable to fetch the course catalog. Snapshot not updated; please retry.');
      }
    }

    const courseDataList = [];

    for (let i = 0; i < coursesToScan.length; i++) {
      const c = coursesToScan[i];
      const prevCourse = effectiveBaseSnapshot?.courses?.find(x => x.id === c.id);

      // If course is marked hidden, and caller didn't request includeHidden, and not single-course:
      if (!courseId && !includeHidden && c.hidden) {
        if (prevCourse && Array.isArray(prevCourse.sections) && prevCourse.sections.length > 0) {
          courseDataList.push({
            ...prevCourse,
            hidden: true,
            fullname: c.fullname || prevCourse.fullname,
            shortname: c.shortname || prevCourse.shortname,
            progress: c.progress ?? prevCourse.progress,
            url: c.viewurl || prevCourse.url,
          });
        } else {
          courseDataList.push({
            id: c.id,
            fullname: c.fullname || `Course ${c.id}`,
            shortname: c.shortname || null,
            hidden: true,
            progress: c.progress ?? null,
            url: c.viewurl || `${client.baseUrl}/course/view.php?id=${c.id}`,
            sections: [],
            signature: hashData({ id: c.id, fullname: c.fullname, hidden: true }),
          });
        }
        continue;
      }

      if (onProgress) {
        onProgress({
          phase: 'course_contents',
          current: i + 1,
          total: coursesToScan.length,
          course: c.fullname || c.shortname || `ID ${c.id}`,
          message: `Fetching course ${i + 1}/${coursesToScan.length}: ${c.fullname || c.id}`,
        });
      }

      try {
        const content = await client.getCourseContents(c.id, { includeEmptySections: true });
        const courseTitle = content.title || c.fullname || `Course ${c.id}`;

        const sections = (content.sections || []).map(sec => {
          const activities = (sec.activities || []).map(act => {
            const activitySignature = hashData({
              id: act.id,
              type: act.type,
              name: act.name,
              link: act.link || null,
              hidden: Boolean(act.hidden),
              completed: Boolean(act.completed),
              availability: act.availability || null,
              fileType: act.fileType || null,
              description: act.description || null,
              details: act.details || null,
            });

            return {
              id: act.id,
              type: act.type,
              name: act.name,
              link: act.link || null,
              completed: Boolean(act.completed),
              hidden: Boolean(act.hidden),
              availability: act.availability || null,
              fileType: act.fileType || null,
              description: act.description || null,
              details: act.details || null,
              signature: activitySignature,
            };
          });

          // Hierarchical Merkle signature: hashes section ID, name, status, and activities
          const sectionSignature = hashData({
            id: sec.id || sec.number,
            number: sec.number,
            name: sec.name,
            hidden: Boolean(sec.hidden),
            summary: sec.summary || null,
            activitySignatures: activities.map(a => a.signature),
          });

          return {
            id: sec.id || sec.number,
            number: sec.number,
            name: sec.name,
            hidden: Boolean(sec.hidden),
            summary: sec.summary || null,
            isEmpty: activities.length === 0,
            signature: sectionSignature,
            activities,
          };
        });

        courseDataList.push({
          id: c.id,
          fullname: courseTitle,
          shortname: c.shortname || null,
          hidden: Boolean(c.hidden),
          progress: c.progress ?? null,
          url: content.url || `${client.baseUrl}/course/view.php?id=${c.id}`,
          signature: hashData({
            id: c.id,
            fullname: courseTitle,
            hidden: Boolean(c.hidden),
            sectionSignatures: sections.map(s => s.signature),
          }),
          sections,
        });
      } catch (err) {
        // If course fetch failed (e.g. transient timeout), preserve previous valid snapshot data
        if (prevCourse && Array.isArray(prevCourse.sections) && prevCourse.sections.length > 0) {
          courseDataList.push({
            ...prevCourse,
            stale: true,
            fetchError: err.message,
          });
        } else {
          courseDataList.push({
            id: c.id,
            fullname: c.fullname || `Course ${c.id}`,
            fetchError: err.message,
            sections: [],
          });
        }
      }
    }

    if (onProgress) onProgress({ phase: 'assignments', message: 'Fetching assignments and submission statuses...' });
    let assignments = [];
    try {
      if (courseId) {
        assignments = await client.getAssignments(courseId, { strict: true });
      } else {
        assignments = await client.getAssignments(null, { strict: true });
      }
      assignments = assignments.map(a => ({
        id: a.id,
        courseid: parseInt(a.courseid, 10),
        coursename: a.coursename || '',
        name: a.name,
        link: a.link,
        duedate: a.duedate,
        submissionStatus: a.submissionStatus,
        grade: a.grade,
        signature: hashData({
          id: a.id,
          name: a.name,
          duedate: a.duedate,
          submissionStatus: a.submissionStatus,
          grade: a.grade,
        }),
      }));
    } catch {
      // Do not turn an unavailable or partial collection into authoritative removals.
      throw new Error('Unable to fetch all assignments. Snapshot not updated; please retry.');
    }

    if (onProgress) onProgress({ phase: 'timeline', message: 'Fetching upcoming timeline deadlines...' });
    let timeline = [];
    try {
      timeline = await client.getTimeline(30, { strict: true });
      timeline = timeline.map(t => ({
        id: t.id,
        name: t.name,
        activityname: t.activityname,
        coursename: t.coursename,
        courseid: t.courseid ? parseInt(t.courseid, 10) : null,
        timestart: t.timestart,
        formattedtime: t.formattedtime,
        actionurl: t.actionurl,
        overdue: Boolean(t.overdue),
        signature: hashData({
          id: t.id,
          name: t.name,
          timestart: t.timestart,
          formattedtime: t.formattedtime,
        }),
      }));
    } catch {
      throw new Error('Unable to fetch the timeline. Snapshot not updated; please retry.');
    }

    // If single course was specified and we have an existing baseline snapshot, merge!
    if (courseId && effectiveBaseSnapshot && Array.isArray(effectiveBaseSnapshot.courses)) {
      const cIdNum = parseInt(courseId, 10);
      const updatedCourse = courseDataList[0];

      const mergedCourses = effectiveBaseSnapshot.courses.map(oldC => {
        if (oldC.id === cIdNum) {
          return updatedCourse || oldC;
        }
        return oldC;
      });

      if (!mergedCourses.some(c => c.id === cIdNum) && updatedCourse) {
        mergedCourses.push(updatedCourse);
      }

      // Merge assignments: retain other courses, replace this course
      const mergedAssignments = [
        ...(effectiveBaseSnapshot.assignments || []).filter(a => parseInt(a.courseid, 10) !== cIdNum),
        ...assignments,
      ];

      const mergedModules = mergedCourses.reduce(
        (acc, c) => acc + (c.sections || []).reduce((sAcc, s) => sAcc + (s.activities || []).length, 0),
        0
      );

      const mergedSnapshot = {
        version: 1,
        timestamp,
        user: status.user || effectiveBaseSnapshot.user || { id: null, fullname: 'Student' },
        classification: effectiveBaseSnapshot.classification || classification,
        courseCount: mergedCourses.length,
        totalModules: mergedModules,
        courses: mergedCourses,
        assignments: mergedAssignments,
        timeline,
      };

      mergedSnapshot.signature = hashData({
        courses: mergedCourses.map(c => c.signature),
        assignments: mergedAssignments.map(a => a.signature),
      });

      return mergedSnapshot;
    }

    const totalModules = courseDataList.reduce(
      (acc, c) => acc + (c.sections || []).reduce((sAcc, s) => sAcc + (s.activities || []).length, 0),
      0
    );

    const snapshot = {
      version: 1,
      timestamp,
      user: status.user || { id: null, fullname: 'Student' },
      classification,
      courseCount: courseDataList.length,
      totalModules,
      courses: courseDataList,
      assignments,
      timeline,
    };

    snapshot.signature = hashData({
      courses: courseDataList.map(c => c.signature),
      assignments: assignments.map(a => a.signature),
    });

    return snapshot;
  }

  /**
   * Compares two snapshots and produces an actionable, structured difference report
   */
  diffSnapshots(oldSnapshot, newSnapshot, options = {}) {
    if (!newSnapshot) {
      throw new Error('New snapshot is required to calculate diff.');
    }

    if (!oldSnapshot) {
      // Initial snapshot — no baseline to compare against
      const totalActivities = (newSnapshot.courses || []).reduce((acc, c) => {
        return acc + (c.sections || []).reduce((sAcc, s) => sAcc + (s.activities || []).length, 0);
      }, 0);

      return {
        isInitial: true,
        hasChanges: false,
        summary: `Baseline snapshot established with ${newSnapshot.courseCount} courses and ${totalActivities} activities.`,
        timestamp: newSnapshot.timestamp,
        changes: {
          coursesAdded: (newSnapshot.courses || []).map(c => ({ id: c.id, fullname: c.fullname })),
          coursesRemoved: [],
          coursesUnhidden: [],
          coursesHidden: [],
          sectionsAdded: [],
          sectionsRemoved: [],
          sectionsUnhidden: [],
          sectionsHidden: [],
          sectionsRenamed: [],
          sectionsSummaryUpdated: [],
          sectionsReordered: [],
          modulesAdded: [],
          modulesRemoved: [],
          modulesUpdated: [],
          modulesUnhidden: [],
          modulesHidden: [],
          assignmentsAdded: [],
          assignmentsRemoved: [],
          deadlinesChanged: [],
          gradesUpdated: [],
          submissionStatusChanged: [],
          timelineAdded: [],
          timelineChanged: [],
          timelineRemoved: [],
        },
      };
    }

    const filterCourseId = options.courseId ? parseInt(options.courseId, 10) : null;

    const oldCoursesMap = new Map((oldSnapshot.courses || []).map(c => [c.id, c]));
    const newCoursesMap = new Map((newSnapshot.courses || []).map(c => [c.id, c]));

    const coursesAdded = [];
    const coursesRemoved = [];
    const coursesUnhidden = [];
    const coursesHidden = [];
    const sectionsAdded = [];
    const sectionsRemoved = [];
    const sectionsUnhidden = [];
    const sectionsHidden = [];
    const sectionsRenamed = [];
    const sectionsSummaryUpdated = [];
    const sectionsReordered = [];
    const modulesAdded = [];
    const modulesRemoved = [];
    const modulesUpdated = [];
    const modulesUnhidden = [];
    const modulesHidden = [];

    // 1. Detect course-level additions, removals, and hidden state transitions
    for (const [id, newC] of newCoursesMap.entries()) {
      if (filterCourseId && id !== filterCourseId) continue;
      const oldC = oldCoursesMap.get(id);
      if (!oldC) {
        coursesAdded.push({ id, fullname: newC.fullname, url: newC.url, hidden: Boolean(newC.hidden) });
      } else {
        if (oldC.hidden && !newC.hidden) {
          coursesUnhidden.push({ id, fullname: newC.fullname, url: newC.url });
        } else if (!oldC.hidden && newC.hidden) {
          coursesHidden.push({ id, fullname: newC.fullname, url: newC.url });
        }
      }
    }

    for (const [id, oldC] of oldCoursesMap.entries()) {
      if (filterCourseId && id !== filterCourseId) continue;
      if (!newCoursesMap.has(id)) {
        coursesRemoved.push({ id, fullname: oldC.fullname });
      }
    }

    // 2. Detect section and module differences within overlapping courses
    for (const [id, newC] of newCoursesMap.entries()) {
      if (filterCourseId && id !== filterCourseId) continue;
      const oldC = oldCoursesMap.get(id);

      if (!oldC) {
        // All sections and modules in newly added course are considered newly available
        for (const sec of newC.sections || []) {
          sectionsAdded.push({
            courseId: id,
            courseName: newC.fullname,
            sectionNumber: sec.number,
            sectionName: sec.name,
          });
          for (const act of sec.activities || []) {
            modulesAdded.push({
              courseId: id,
              courseName: newC.fullname,
              sectionNumber: sec.number,
              sectionName: sec.name,
              id: act.id,
              type: act.type,
              name: act.name,
              link: act.link,
              fileType: act.fileType,
              hidden: act.hidden,
              description: act.description,
            });
          }
        }
        continue;
      }

      // If new course had a fetch error and zero sections, do NOT treat sections as deleted
      if (newC.fetchError && (!newC.sections || newC.sections.length === 0)) {
        continue;
      }

      // Both snapshots have this course
      const getSecKey = (s) => (s.id !== undefined && s.id !== null ? `id_${s.id}` : `num_${s.number}`);
      const oldSecMap = new Map((oldC.sections || []).map(s => [getSecKey(s), s]));
      const newSecMap = new Map((newC.sections || []).map(s => [getSecKey(s), s]));

      // Check section additions/removals/status/reordering
      for (const [secKey, newSec] of newSecMap.entries()) {
        const oldSec = oldSecMap.get(secKey);
        if (!oldSec) {
          sectionsAdded.push({
            courseId: id,
            courseName: newC.fullname,
            sectionNumber: newSec.number,
            sectionName: newSec.name,
          });
        } else {
          if (oldSec.number !== newSec.number) {
            sectionsReordered.push({
              courseId: id,
              courseName: newC.fullname,
              sectionName: newSec.name,
              oldNumber: oldSec.number,
              newNumber: newSec.number,
            });
          }
          if (oldSec.hidden && !newSec.hidden) {
            sectionsUnhidden.push({
              courseId: id,
              courseName: newC.fullname,
              sectionNumber: newSec.number,
              sectionName: newSec.name,
            });
          } else if (!oldSec.hidden && newSec.hidden) {
            sectionsHidden.push({
              courseId: id,
              courseName: newC.fullname,
              sectionNumber: newSec.number,
              sectionName: newSec.name,
            });
          }
          if (oldSec.name !== newSec.name) {
            sectionsRenamed.push({
              courseId: id,
              courseName: newC.fullname,
              sectionNumber: newSec.number,
              oldName: oldSec.name,
              newName: newSec.name,
            });
          }
          if (oldSec.summary !== newSec.summary && (oldSec.summary || newSec.summary)) {
            sectionsSummaryUpdated.push({
              courseId: id,
              courseName: newC.fullname,
              sectionNumber: newSec.number,
              sectionName: newSec.name,
              oldSummary: oldSec.summary,
              newSummary: newSec.summary,
            });
          }
        }
      }

      for (const [secKey, oldSec] of oldSecMap.entries()) {
        if (!newSecMap.has(secKey)) {
          sectionsRemoved.push({
            courseId: id,
            courseName: newC.fullname,
            sectionNumber: oldSec.number,
            sectionName: oldSec.name,
          });
        }
      }

      // Check module level differences
      const oldActMap = new Map();
      for (const s of oldC.sections || []) {
        for (const a of s.activities || []) {
          oldActMap.set(a.id, { ...a, sectionName: s.name, sectionNumber: s.number });
        }
      }

      const newActMap = new Map();
      for (const s of newC.sections || []) {
        for (const a of s.activities || []) {
          newActMap.set(a.id, { ...a, sectionName: s.name, sectionNumber: s.number });
        }
      }

      for (const [modId, newAct] of newActMap.entries()) {
        const oldAct = oldActMap.get(modId);
        if (!oldAct) {
          modulesAdded.push({
            courseId: id,
            courseName: newC.fullname,
            sectionNumber: newAct.sectionNumber,
            sectionName: newAct.sectionName,
            id: modId,
            type: newAct.type,
            name: newAct.name,
            link: newAct.link,
            fileType: newAct.fileType,
            hidden: newAct.hidden,
            description: newAct.description,
          });
        } else {
          // Check for unhidden / hidden transitions
          if (oldAct.hidden && !newAct.hidden) {
            modulesUnhidden.push({
              courseId: id,
              courseName: newC.fullname,
              sectionNumber: newAct.sectionNumber,
              sectionName: newAct.sectionName,
              id: modId,
              type: newAct.type,
              name: newAct.name,
              link: newAct.link,
              fileType: newAct.fileType,
            });
          } else if (!oldAct.hidden && newAct.hidden) {
            modulesHidden.push({
              courseId: id,
              courseName: newC.fullname,
              sectionNumber: newAct.sectionNumber,
              sectionName: newAct.sectionName,
              id: modId,
              type: newAct.type,
              name: newAct.name,
            });
          }

          // Check for content/signature updates
          const changes = [];
          if (oldAct.name !== newAct.name) {
            changes.push(`Renamed: "${oldAct.name}" → "${newAct.name}"`);
          }
          if (oldAct.link !== newAct.link) {
            changes.push(`Link updated`);
          }
          if (oldAct.fileType !== newAct.fileType) {
            changes.push(`File type: ${oldAct.fileType || 'none'} → ${newAct.fileType || 'none'}`);
          }
          if (oldAct.availability !== newAct.availability) {
            changes.push(`Availability: "${oldAct.availability || 'none'}" → "${newAct.availability || 'none'}"`);
          }
          if (oldAct.description !== newAct.description && (oldAct.description || newAct.description)) {
            changes.push(`Instructions/notes updated`);
          }
          if (oldAct.details !== newAct.details && (oldAct.details || newAct.details)) {
            changes.push(`Resource details: "${oldAct.details || 'none'}" → "${newAct.details || 'none'}"`);
          }
          if (oldAct.sectionNumber !== newAct.sectionNumber) {
            changes.push(`Moved from Section ${oldAct.sectionNumber} ("${oldAct.sectionName}") to Section ${newAct.sectionNumber} ("${newAct.sectionName}")`);
          }
          if (oldAct.completed !== newAct.completed) {
            changes.push(`Completion status: ${oldAct.completed ? 'Completed' : 'Incomplete'} → ${newAct.completed ? 'Completed' : 'Incomplete'}`);
          }
          if (changes.length === 0 && oldAct.signature !== newAct.signature) {
            changes.push(`Content/metadata updated`);
          }

          if (changes.length > 0) {
            modulesUpdated.push({
              courseId: id,
              courseName: newC.fullname,
              sectionNumber: newAct.sectionNumber,
              sectionName: newAct.sectionName,
              id: modId,
              type: newAct.type,
              name: newAct.name,
              link: newAct.link,
              fileType: newAct.fileType,
              changes,
            });
          }
        }
      }

      for (const [modId, oldAct] of oldActMap.entries()) {
        if (!newActMap.has(modId)) {
          modulesRemoved.push({
            courseId: id,
            courseName: newC.fullname,
            sectionNumber: oldAct.sectionNumber,
            sectionName: oldAct.sectionName,
            id: modId,
            type: oldAct.type,
            name: oldAct.name,
          });
        }
      }
    }

    // 3. Detect assignment, grade & deadline changes
    const oldAssignMap = new Map((oldSnapshot.assignments || []).map(a => [a.id, a]));
    const newAssignMap = new Map((newSnapshot.assignments || []).map(a => [a.id, a]));

    const assignmentsAdded = [];
    const assignmentsRemoved = [];
    const deadlinesChanged = [];
    const gradesUpdated = [];
    const submissionStatusChanged = [];

    for (const [assignId, newA] of newAssignMap.entries()) {
      if (filterCourseId && parseInt(newA.courseid, 10) !== filterCourseId) continue;
      const oldA = oldAssignMap.get(assignId);
      if (!oldA) {
        assignmentsAdded.push({
          id: assignId,
          courseId: newA.courseid,
          courseName: newA.coursename,
          name: newA.name,
          duedate: newA.duedate,
          submissionStatus: newA.submissionStatus,
          grade: newA.grade,
          link: newA.link,
        });
      } else {
        if (oldA.duedate !== newA.duedate) {
          deadlinesChanged.push({
            id: assignId,
            courseName: newA.coursename || oldA.coursename,
            name: newA.name,
            oldDate: oldA.duedate,
            newDate: newA.duedate,
            link: newA.link,
          });
        }
        if (oldA.grade !== newA.grade) {
          gradesUpdated.push({
            id: assignId,
            courseName: newA.coursename || oldA.coursename,
            name: newA.name,
            oldGrade: oldA.grade || 'No grade',
            newGrade: newA.grade || 'No grade',
            link: newA.link,
          });
        }
        if (oldA.submissionStatus !== newA.submissionStatus) {
          submissionStatusChanged.push({
            id: assignId,
            courseName: newA.coursename || oldA.coursename,
            name: newA.name,
            oldStatus: oldA.submissionStatus,
            newStatus: newA.submissionStatus,
            grade: newA.grade,
            link: newA.link,
          });
        }
      }
    }

    for (const [assignId, oldA] of oldAssignMap.entries()) {
      if (filterCourseId && parseInt(oldA.courseid, 10) !== filterCourseId) continue;
      if (!newAssignMap.has(assignId)) {
        assignmentsRemoved.push({
          id: assignId,
          courseName: oldA.coursename,
          name: oldA.name,
        });
      }
    }

    // 4. Detect upcoming timeline changes (new quizzes or calendar events)
    const oldTimelineMap = new Map((oldSnapshot.timeline || []).map(t => [t.id, t]));
    const newTimelineMap = new Map((newSnapshot.timeline || []).map(t => [t.id, t]));
    const timelineAdded = [];
    const timelineChanged = [];
    const timelineRemoved = [];

    for (const [tId, newT] of newTimelineMap.entries()) {
      if (filterCourseId && newT.courseid && parseInt(newT.courseid, 10) !== filterCourseId) continue;
      const oldT = oldTimelineMap.get(tId);
      if (!oldT) {
        timelineAdded.push({
          id: tId,
          name: newT.name,
          coursename: newT.coursename,
          formattedtime: newT.formattedtime,
          timestart: newT.timestart,
          actionurl: newT.actionurl,
        });
      } else if (oldT.formattedtime !== newT.formattedtime || oldT.timestart !== newT.timestart) {
        timelineChanged.push({
          id: tId,
          name: newT.name,
          coursename: newT.coursename,
          oldTime: oldT.formattedtime || oldT.timestart,
          newTime: newT.formattedtime || newT.timestart,
          actionurl: newT.actionurl,
        });
      }
    }

    // Absence only means an event left the fetched timeline, not cancellation.
    for (const [tId, oldT] of oldTimelineMap.entries()) {
      if (filterCourseId && oldT.courseid && parseInt(oldT.courseid, 10) !== filterCourseId) continue;
      if (!newTimelineMap.has(tId)) {
        timelineRemoved.push({
          id: tId,
          name: oldT.name,
          coursename: oldT.coursename,
          formattedtime: oldT.formattedtime,
          timestart: oldT.timestart,
          actionurl: oldT.actionurl,
        });
      }
    }

    const totalChangeCount =
      coursesAdded.length +
      coursesRemoved.length +
      coursesUnhidden.length +
      coursesHidden.length +
      sectionsAdded.length +
      sectionsRemoved.length +
      sectionsUnhidden.length +
      sectionsHidden.length +
      sectionsRenamed.length +
      sectionsSummaryUpdated.length +
      sectionsReordered.length +
      modulesAdded.length +
      modulesRemoved.length +
      modulesUpdated.length +
      modulesUnhidden.length +
      modulesHidden.length +
      assignmentsAdded.length +
      assignmentsRemoved.length +
      deadlinesChanged.length +
      gradesUpdated.length +
      submissionStatusChanged.length +
      timelineAdded.length +
      timelineChanged.length +
      timelineRemoved.length;

    const hasChanges = totalChangeCount > 0;

    return {
      isInitial: false,
      hasChanges,
      totalChangeCount,
      oldTimestamp: oldSnapshot.timestamp,
      newTimestamp: newSnapshot.timestamp,
      timeElapsedMs: new Date(newSnapshot.timestamp).getTime() - new Date(oldSnapshot.timestamp).getTime(),
      changes: {
        coursesAdded,
        coursesRemoved,
        coursesUnhidden,
        coursesHidden,
        sectionsAdded,
        sectionsRemoved,
        sectionsUnhidden,
        sectionsHidden,
        sectionsRenamed,
        sectionsSummaryUpdated,
        sectionsReordered,
        modulesAdded,
        modulesRemoved,
        modulesUpdated,
        modulesUnhidden,
        modulesHidden,
        assignmentsAdded,
        assignmentsRemoved,
        deadlinesChanged,
        gradesUpdated,
        submissionStatusChanged,
        timelineAdded,
        timelineChanged,
        timelineRemoved,
      },
    };
  }

  /**
   * Save snapshot to disk (moves current latest to previous)
   */
  async saveSnapshot(newSnapshot) {
    await this.init();

    // 1. If latest exists, rotate it to previous
    if (fsSync.existsSync(this.latestFile)) {
      try {
        const currentLatest = await fs.readFile(this.latestFile, 'utf8');
        await fs.writeFile(this.previousFile, currentLatest, { mode: 0o600 });
      } catch {
        // non-fatal
      }
    }

    // 2. Write new latest
    await fs.writeFile(this.latestFile, JSON.stringify(newSnapshot, null, 2), { mode: 0o600 });

    // 3. Write summary manifest
    const manifest = {
      lastSyncTime: newSnapshot.timestamp,
      user: newSnapshot.user,
      courseCount: newSnapshot.courseCount,
      totalModules: newSnapshot.totalModules,
      courses: (newSnapshot.courses || []).map(c => ({
        id: c.id,
        name: c.fullname,
        sectionsCount: (c.sections || []).length,
        modulesCount: (c.sections || []).reduce((acc, s) => acc + (s.activities || []).length, 0),
      })),
      signature: newSnapshot.signature,
    };
    await fs.writeFile(this.manifestFile, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  }

  /**
   * Generates a readable, formatted text summary of changes
   */
  formatDiffReport(diffResult, { showUnchanged = false, verbose = false, context = 'sync' } = {}) {
    if (!diffResult) return 'No diff result provided.';

    if (diffResult.isInitial) {
      if (context === 'diff') {
        return `\n[VSUEE Diff] No previous snapshot available to compare against.\n${diffResult.summary}\nRun \`vsuee sync\` to record fresh baseline or \`vsuee diff --live\` to compare against live portal.\n`;
      }
      return `\n[VSUEE Sync] Initial baseline snapshot recorded (${diffResult.summary}).\nFuture syncs will compare against this baseline to report newly posted lessons, files, or deadlines.\n`;
    }

    if (!diffResult.hasChanges) {
      const elapsedMins = diffResult.timeElapsedMs ? Math.round(diffResult.timeElapsedMs / 60000) : 0;
      const elapsedStr = elapsedMins > 0 ? ` (last checked ${elapsedMins} minute${elapsedMins === 1 ? '' : 's'} ago)` : '';
      return `\n✓ Everything is up to date. No changes detected across your courses${elapsedStr}.\n`;
    }

    const { changes } = diffResult;
    const lines = [];

    const elapsedMins = diffResult.timeElapsedMs ? Math.round(diffResult.timeElapsedMs / 60000) : null;
    const timeStr = elapsedMins !== null ? `since ${elapsedMins}m ago` : `since ${diffResult.oldTimestamp}`;

    lines.push('\n======================================================');
    lines.push(` VSUEE COURSE UPDATES — ${diffResult.totalChangeCount} CHANGE(S) DETECTED`);
    lines.push(` Window: ${timeStr} (${new Date(diffResult.newTimestamp).toLocaleString()})`);
    lines.push('======================================================\n');

    // 1. DEADLINE CHANGES (Highest urgency)
    if (changes.deadlinesChanged.length > 0) {
      lines.push('🚨 DEADLINE / DUE DATE CHANGES:');
      for (const d of changes.deadlinesChanged) {
        const courseStr = d.courseName ? ` [${d.courseName}]` : '';
        lines.push(`  • ${d.name}${courseStr}`);
        lines.push(`    WAS: ${d.oldDate}`);
        lines.push(`    NOW: ${d.newDate}`);
        if (d.link) lines.push(`    URL: ${d.link}`);
      }
      lines.push('');
    }

    if (changes.timelineChanged && changes.timelineChanged.length > 0) {
      lines.push('🚨 CALENDAR EVENT & QUIZ WINDOW TIME CHANGES:');
      for (const t of changes.timelineChanged) {
        const courseStr = t.coursename ? ` [${t.coursename}]` : '';
        lines.push(`  • ${t.name}${courseStr}`);
        lines.push(`    WAS: ${t.oldTime ?? 'Unknown'}`);
        lines.push(`    NOW: ${t.newTime ?? 'Unknown'}`);
        if (t.actionurl) lines.push(`    URL: ${t.actionurl}`);
      }
      lines.push('');
    }

    // 2. NEW ASSIGNMENTS
    if (changes.assignmentsAdded.length > 0) {
      lines.push('📝 NEW ASSIGNMENTS POSTED:');
      for (const a of changes.assignmentsAdded) {
        const courseStr = a.courseName ? ` [${a.courseName}]` : '';
        lines.push(`  • ${a.name}${courseStr}`);
        lines.push(`    Due Date: ${a.duedate || 'No due date'}`);
        if (a.link) lines.push(`    Link:     ${a.link}`);
      }
      lines.push('');
    }

    // 3. GRADE UPDATES
    if (changes.gradesUpdated && changes.gradesUpdated.length > 0) {
      lines.push('📊 NEW GRADES POSTED BY INSTRUCTORS:');
      for (const g of changes.gradesUpdated) {
        const courseStr = g.courseName ? ` [${g.courseName}]` : '';
        lines.push(`  • ${g.name}${courseStr}`);
        lines.push(`    Grade: ${g.oldGrade} → ${g.newGrade}`);
        if (g.link) lines.push(`    Link:  ${g.link}`);
      }
      lines.push('');
    }

    // 4. TIMELINE / CALENDAR EVENTS
    if (changes.timelineAdded && changes.timelineAdded.length > 0) {
      lines.push('⏰ NEW CALENDAR EVENTS & QUIZ WINDOWS:');
      for (const t of changes.timelineAdded) {
        const courseStr = t.coursename ? ` [${t.coursename}]` : '';
        lines.push(`  • ${t.name}${courseStr}`);
        lines.push(`    Time: ${t.formattedtime || t.timestart}`);
        if (t.actionurl) lines.push(`    URL:  ${t.actionurl}`);
      }
      lines.push('');
    }

    if (changes.timelineRemoved && changes.timelineRemoved.length > 0) {
      lines.push('EVENTS NO LONGER IN THE FETCHED TIMELINE:');
      lines.push('  This does not confirm cancellation; events may expire, complete, or leave the result limit.');
      for (const t of changes.timelineRemoved) {
        const courseStr = t.coursename ? ` [${t.coursename}]` : '';
        lines.push(`  • ${t.name}${courseStr}`);
        if (t.actionurl) lines.push(`    URL:  ${t.actionurl}`);
      }
      lines.push('');
    }

    // 5. NEW LESSONS / FILES / ACTIVITIES
    if (changes.modulesAdded.length > 0) {
      lines.push('📢 NEW LESSONS & MATERIALS ADDED:');
      for (const m of changes.modulesAdded) {
        const typeBadge = `[${m.type.toUpperCase()}]`.padEnd(12);
        lines.push(`  • ${typeBadge} ${m.name}`);
        lines.push(`    Course:  ${m.courseName}`);
        lines.push(`    Section: ${m.sectionName}`);
        if (m.fileType) lines.push(`    Format:  ${m.fileType.toUpperCase()}`);
        if (m.description) lines.push(`    Note:    ${m.description}`);
        if (m.link) lines.push(`    Link:    ${m.link}`);
      }
      lines.push('');
    }

    // 6. UNHIDDEN / REVEALED SECTIONS & MODULES
    if (changes.sectionsUnhidden.length > 0 || changes.modulesUnhidden.length > 0) {
      lines.push('👁️ PREVIOUSLY HIDDEN CONTENT REVEALED:');
      for (const s of changes.sectionsUnhidden) {
        lines.push(`  • [SECTION UNHIDDEN] "${s.sectionName}" in ${s.courseName}`);
      }
      for (const m of changes.modulesUnhidden) {
        lines.push(`  • [MODULE UNHIDDEN] [${m.type.toUpperCase()}] "${m.name}" in ${m.courseName} > ${m.sectionName}`);
        if (m.link) lines.push(`    Link: ${m.link}`);
      }
      lines.push('');
    }

    // 7. HIDDEN ITEMS
    if (changes.sectionsHidden.length > 0 || changes.modulesHidden.length > 0) {
      lines.push('🔒 CONTENT HIDDEN BY INSTRUCTORS:');
      for (const s of changes.sectionsHidden) {
        lines.push(`  • [SECTION CONCEALED] "${s.sectionName}" in ${s.courseName}`);
      }
      for (const m of changes.modulesHidden) {
        lines.push(`  • [MODULE CONCEALED] [${m.type.toUpperCase()}] "${m.name}" in ${m.courseName} > ${m.sectionName}`);
      }
      lines.push('');
    }

    // 8. NEW SECTIONS
    if (changes.sectionsAdded.length > 0) {
      lines.push('📂 NEW COURSE SECTIONS / TOPICS ADDED:');
      for (const s of changes.sectionsAdded) {
        lines.push(`  • [Section ${s.sectionNumber}] "${s.sectionName}" in ${s.courseName}`);
      }
      lines.push('');
    }

    // 9. SECTION RENAMED
    if (changes.sectionsRenamed.length > 0) {
      lines.push('✏️ RENAMED SECTIONS:');
      for (const s of changes.sectionsRenamed) {
        lines.push(`  • [Section ${s.sectionNumber} in ${s.courseName}] "${s.oldName}" → "${s.newName}"`);
      }
      lines.push('');
    }

    // 10. SECTION SUMMARY UPDATES
    if (changes.sectionsSummaryUpdated && changes.sectionsSummaryUpdated.length > 0) {
      lines.push('📋 SECTION SUMMARY & ANNOUNCEMENT UPDATES:');
      for (const s of changes.sectionsSummaryUpdated) {
        lines.push(`  • [Section ${s.sectionNumber}: ${s.sectionName} in ${s.courseName}]`);
        if (s.newSummary) {
          lines.push(`    Updated text: ${s.newSummary}`);
        } else {
          lines.push(`    Summary cleared.`);
        }
      }
      lines.push('');
    }

    // 10.5 REORDERED SECTIONS
    if (changes.sectionsReordered && changes.sectionsReordered.length > 0) {
      lines.push('🔀 REORDERED SECTIONS:');
      for (const s of changes.sectionsReordered) {
        lines.push(`  • "${s.sectionName}" in ${s.courseName} (moved: Section ${s.oldNumber} → Section ${s.newNumber})`);
      }
      lines.push('');
    }

    // 11. UPDATED MODULES
    if (changes.modulesUpdated.length > 0) {
      lines.push('🔄 UPDATED LESSONS / FILES / DESCRIPTIONS:');
      for (const m of changes.modulesUpdated) {
        lines.push(`  • [${m.type.toUpperCase()}] ${m.name} [${m.courseName} > ${m.sectionName}]`);
        for (const ch of m.changes) {
          lines.push(`    - ${ch}`);
        }
        if (m.link) lines.push(`    Link: ${m.link}`);
      }
      lines.push('');
    }

    // 12. ENROLLMENT & COURSE STATUS CHANGES
    if (changes.coursesUnhidden && changes.coursesUnhidden.length > 0) {
      lines.push('🎉 COURSES ACTIVATED / UNHIDDEN BY INSTRUCTOR:');
      for (const c of changes.coursesUnhidden) {
        lines.push(`  • [ID: ${c.id}] ${c.fullname}`);
        if (c.url) lines.push(`    URL: ${c.url}`);
      }
      lines.push('');
    }

    if (changes.coursesHidden && changes.coursesHidden.length > 0) {
      lines.push('🔒 COURSES CONCEALED / ARCHIVED:');
      for (const c of changes.coursesHidden) {
        lines.push(`  • [ID: ${c.id}] ${c.fullname}`);
      }
      lines.push('');
    }

    if (changes.coursesAdded.length > 0) {
      lines.push('🎓 NEW COURSE ENROLLMENTS:');
      for (const c of changes.coursesAdded) {
        lines.push(`  • [ID: ${c.id}] ${c.fullname}`);
        if (c.url) lines.push(`    URL: ${c.url}`);
      }
      lines.push('');
    }

    if (changes.coursesRemoved.length > 0) {
      lines.push('⚠️ COURSES UNENROLLED OR REMOVED:');
      for (const c of changes.coursesRemoved) {
        lines.push(`  • [ID: ${c.id}] ${c.fullname}`);
      }
      lines.push('');
    }

    // 13. SUBMISSION STATUS CHANGES
    if (changes.submissionStatusChanged.length > 0) {
      lines.push('📊 SUBMISSION & GRADE UPDATES:');
      for (const s of changes.submissionStatusChanged) {
        lines.push(`  • ${s.name} [${s.courseName}]`);
        lines.push(`    Status: ${s.oldStatus} → ${s.newStatus} | Grade: ${s.grade || '-'}`);
      }
      lines.push('');
    }

    // 14. REMOVED ITEMS
    if (changes.modulesRemoved.length > 0 || changes.assignmentsRemoved.length > 0 || changes.sectionsRemoved.length > 0) {
      lines.push('🗑️ REMOVED ITEMS:');
      for (const s of changes.sectionsRemoved) {
        lines.push(`  • [SECTION REMOVED] "${s.sectionName}" in ${s.courseName}`);
      }
      for (const m of changes.modulesRemoved) {
        lines.push(`  • [MODULE REMOVED] [${m.type.toUpperCase()}] "${m.name}" in ${m.courseName} > ${m.sectionName}`);
      }
      for (const a of changes.assignmentsRemoved) {
        lines.push(`  • [ASSIGNMENT REMOVED] "${a.name}" in ${a.courseName}`);
      }
      lines.push('');
    }

    lines.push('------------------------------------------------------\n');
    return lines.join('\n');
  }

  /**
   * Automatically download newly added, unhidden, or updated file resources
   */
  async autoDownloadNewMaterials(client, diffResult, destDir = path.join(os.homedir(), 'Downloads', 'VSUEE'), options = {}) {
    if (!diffResult || !diffResult.hasChanges || !diffResult.changes) {
      return { downloaded: 0, files: [] };
    }

    const resolvedDest = expandHome(destDir);
    const { changes } = diffResult;
    const candidates = [];
    const candidatesByUrl = new Map();

    const addCandidate = (item, isUpdate = false) => {
      if ((item.type === 'resource' || item.type === 'folder') && item.link) {
        const existing = candidatesByUrl.get(item.link);
        if (existing) {
          // One file can be both revealed and changed in the same snapshot.
          // Deduplicate its download without dropping the required refresh.
          existing.isUpdate ||= isUpdate;
        } else {
          const candidate = { ...item, isUpdate };
          candidatesByUrl.set(item.link, candidate);
          candidates.push(candidate);
        }
      }
    };

    // 1. Newly added files
    for (const m of changes.modulesAdded || []) {
      addCandidate(m, false);
    }

    // 2. Unhidden files
    for (const m of changes.modulesUnhidden || []) {
      addCandidate(m, false);
    }

    // 3. Updated files (where link, fileType, name, or resource details changed)
    for (const m of changes.modulesUpdated || []) {
      const isFileChange = m.changes.some(c =>
        c.includes('Link updated') ||
        c.includes('File type:') ||
        c.includes('Renamed:') ||
        c.includes('Resource details:')
      );
      if (isFileChange) {
        addCandidate(m, true);
      }
    }

    if (candidates.length === 0) {
      return { downloaded: 0, files: [] };
    }

    const concurrency = Math.max(1, Math.min(16, parseInt(options.concurrency, 10) || 4));
    const downloadedFiles = [];

    const settled = await asyncPool(concurrency, candidates, async (item) => {
      const sanitizedCourse = (item.courseName || `Course_${item.courseId}`).replace(/[\/\\:*?"<>|]/g, '_').trim();
      const secNum = item.sectionNumber ?? 0;
      const secName = (item.sectionName || `Section_${secNum}`).replace(/[\/\\:*?"<>|]/g, '_').trim();
      const sanitizedSecFolder = `${secNum}_${secName}`;
      const sanitizedName = (item.name || `File_${item.id}`).replace(/[\/\\:*?"<>|]/g, '_').trim();

      const targetPath = path.join(resolvedDest, sanitizedCourse, sanitizedSecFolder, sanitizedName);

      try {
        const result = await client.downloadResource(item.link, targetPath, { ...options, force: item.isUpdate || Boolean(options.force) });
        return {
          module: item.name,
          course: item.courseName,
          path: result.savedPath,
          size: result.size,
          skipped: result.skipped || false,
          isUpdate: item.isUpdate,
        };
      } catch (err) {
        return {
          module: item.name,
          course: item.courseName,
          error: err.message,
        };
      }
    }, {
      onStart: options.onStart,
      onProgress: options.onProgress,
    });

    for (const res of settled) {
      if (res.status === 'fulfilled' && res.value) {
        downloadedFiles.push(res.value);
      } else if (res.status === 'rejected') {
        downloadedFiles.push({ module: 'Task error', error: res.reason?.message || String(res.reason) });
      }
    }

    return {
      downloaded: downloadedFiles.filter(f => !f.error && !f.skipped).length,
      files: downloadedFiles,
    };
  }

  /**
   * Deliver desktop notification via macOS osascript, Linux notify-send, or Windows PowerShell
   */
  notifySystem(title, message) {
    if (process.platform === 'darwin') {
      const script = `display notification ${JSON.stringify(String(message))} with title ${JSON.stringify(String(title))}`;
      execFile('osascript', ['-e', script], () => {
        // fire and forget
      });
    } else if (process.platform === 'linux') {
      execFile('notify-send', [String(title), String(message)], () => {
        // fire and forget
      });
    } else if (process.platform === 'win32') {
      const psCmd = `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null; $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02); $xml = [xml]$template.GetXml(); $textNodes = $xml.GetElementsByTagName('text'); $textNodes[0].AppendChild($xml.CreateTextNode(${JSON.stringify(String(title))})) > $null; $textNodes[1].AppendChild($xml.CreateTextNode(${JSON.stringify(String(message))})) > $null; $toast = [Windows.UI.Notifications.ToastNotification]::new($xml); [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('VSUEE').Show($toast);`;
      execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', psCmd], () => {
        // fire and forget
      });
    }
  }
}
