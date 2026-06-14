import fs from 'node:fs/promises';
import path from 'node:path';
import { LOGIN_HELP, OUTLINE_CACHE_DIR } from '../config.js';
import { AuthError, sessionGet } from '../session.js';
import { getContent, type MarshalledModule } from './content.js';
import { listCourses } from './courses.js';
import { htmlToText, stripHtml } from './text.js';
import type { Course, CourseOutline, OutlineCacheRefreshResult } from './types.js';

const OUTLINE_HOST = 'outline.uwaterloo.ca';
const OUTLINE_VIEWER_URL = `https://${OUTLINE_HOST}/viewer/`;
const TERM_RE = /\b(Winter|Spring|Fall)\s+(\d{4})\b/i;
const COURSE_CODE_RE = /\b[A-Z]{2,}\s*\d{2,4}[A-Z]?\b/g;

interface CourseOutlineSnapshot extends CourseOutline {
  html: string;
  /** Revision date shown on the outline page ("May 12, 2026"); null if not found. */
  publishedAt: string | null;
}

interface CachedCourseOutline extends CourseOutlineSnapshot {
  schemaVersion: 2;
  courseId: number;
  courseName: string | null;
  fetchedAt: string;
}

interface CourseOutlineLookup {
  codes: string[];
  term: string | null;
}

export interface ViewerOutlineRow {
  term: string;
  course: string;
  title: string;
  sections: string;
  url: string;
}

interface CachedViewerOutlines {
  schemaVersion: 1;
  rows: ViewerOutlineRow[];
  fetchedAt: string;
}

function outlineCachePath(courseId: number): string {
  return path.join(OUTLINE_CACHE_DIR, `${courseId}.json`);
}

function viewerOutlinesCachePath(): string {
  return path.join(OUTLINE_CACHE_DIR, 'viewer-outlines.json');
}

function cachedOutlineToResult(outline: CachedCourseOutline): CourseOutline {
  return { url: outline.url, title: outline.title, text: outline.text };
}

function isCachedCourseOutline(value: unknown, courseId: number): value is CachedCourseOutline {
  if (!value || typeof value !== 'object') return false;
  const outline = value as Partial<CachedCourseOutline>;
  return (
    outline.schemaVersion === 2 &&
    outline.courseId === courseId &&
    typeof outline.url === 'string' &&
    typeof outline.title === 'string' &&
    typeof outline.text === 'string' &&
    typeof outline.html === 'string' &&
    typeof outline.fetchedAt === 'string' &&
    (typeof outline.publishedAt === 'string' || outline.publishedAt === null)
  );
}

async function readCachedOutline(courseId: number): Promise<CachedCourseOutline | null> {
  try {
    const raw = await fs.readFile(outlineCachePath(courseId), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isCachedCourseOutline(parsed, courseId)) {
      console.warn(`Ignoring invalid cached outline for course ${courseId}.`);
      return null;
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`Could not read cached outline for course ${courseId}: ${err}`);
    }
    return null;
  }
}

async function writeCachedOutline(
  courseId: number,
  courseName: string | null,
  outline: CourseOutlineSnapshot,
): Promise<void> {
  await fs.mkdir(OUTLINE_CACHE_DIR, { recursive: true });
  const cache: CachedCourseOutline = {
    schemaVersion: 2,
    courseId,
    courseName,
    url: outline.url,
    title: outline.title,
    text: outline.text,
    html: outline.html,
    publishedAt: outline.publishedAt,
    fetchedAt: new Date().toISOString(),
  };
  const file = outlineCachePath(courseId);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
  await fs.chmod(file, 0o600).catch(() => {});
}

function isViewerOutlineRow(value: unknown): value is ViewerOutlineRow {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<ViewerOutlineRow>;
  return (
    typeof row.term === 'string' &&
    typeof row.course === 'string' &&
    typeof row.title === 'string' &&
    typeof row.sections === 'string' &&
    typeof row.url === 'string'
  );
}

function isCachedViewerOutlines(value: unknown): value is CachedViewerOutlines {
  if (!value || typeof value !== 'object') return false;
  const cache = value as Partial<CachedViewerOutlines>;
  return (
    cache.schemaVersion === 1 &&
    Array.isArray(cache.rows) &&
    cache.rows.every(isViewerOutlineRow) &&
    typeof cache.fetchedAt === 'string'
  );
}

async function readCachedViewerOutlines(): Promise<ViewerOutlineRow[] | null> {
  try {
    const raw = await fs.readFile(viewerOutlinesCachePath(), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isCachedViewerOutlines(parsed)) {
      console.warn('Ignoring invalid cached outline viewer metadata.');
      return null;
    }
    return parsed.rows;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`Could not read cached outline viewer metadata: ${err}`);
    }
    return null;
  }
}

async function writeCachedViewerOutlines(rows: ViewerOutlineRow[]): Promise<void> {
  await fs.mkdir(OUTLINE_CACHE_DIR, { recursive: true });
  const cache: CachedViewerOutlines = {
    schemaVersion: 1,
    rows,
    fetchedAt: new Date().toISOString(),
  };
  const file = viewerOutlinesCachePath();
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
  await fs.chmod(file, 0o600).catch(() => {});
}

function normalizeCourseCode(code: string): string {
  return code.toUpperCase().replace(/\s+/g, '');
}

export function parseCourseOutlineLookup(courseName: string): CourseOutlineLookup {
  const termMatch = courseName.match(TERM_RE);
  const codeMatches = courseName.toUpperCase().match(COURSE_CODE_RE) ?? [];
  return {
    codes: [...new Set(codeMatches.map(normalizeCourseCode))],
    term: termMatch ? `${termMatch[1][0].toUpperCase()}${termMatch[1].slice(1).toLowerCase()} ${termMatch[2]}` : null,
  };
}

/** Depth-first search of the TOC for the first link into outline.uwaterloo.ca. */
function findOutlineUrl(modules: MarshalledModule[]): string | null {
  for (const mod of modules) {
    for (const topic of mod.topics) {
      if (!topic.url) continue;
      try {
        if (new URL(topic.url).host === OUTLINE_HOST) return topic.url;
      } catch {
        // unparseable URL - skip
      }
    }
    const nested = findOutlineUrl(mod.modules);
    if (nested) return nested;
  }
  return null;
}

async function findCourse(courseId: number): Promise<Course | null> {
  const courses = await listCourses();
  return courses.find((course) => course.ou === courseId) ?? null;
}

/** UWaterloo term codes: "1" + 2-digit year + month digit (1=Jan, 5=May, 9=Sep). */
const TERM_SEASONS: Record<string, string> = { '1': 'Winter', '5': 'Spring', '9': 'Fall' };

function termCodeToLabel(code: string): string {
  const m = code.match(/^1(\d\d)([159])$/);
  if (!m) return code;
  return `${TERM_SEASONS[m[2]]} ${2000 + Number(m[1])}`;
}

interface ViewerSearchRow {
  term: string;
  courses: string;
  sections: string;
  title: string;
  url: string;
}

/**
 * The viewer page is an SPA whose data comes from /viewer/api/search/ - a
 * plain cookie-authed GET returns every outline as JSON, so no browser render
 * is needed. An expired outline session redirects the request to SSO.
 */
async function fetchViewerOutlines(): Promise<ViewerOutlineRow[]> {
  const res = await sessionGet(`${OUTLINE_VIEWER_URL}api/search/?q=`, {
    headers: { Accept: 'application/json' },
  });
  if (res.status >= 300 && res.status < 400) {
    throw new AuthError(
      `Redirected from ${OUTLINE_VIEWER_URL} - the outline.uwaterloo.ca session is missing or expired. ${LOGIN_HELP}`,
    );
  }
  if (res.status !== 200 || !(res.headers.get('content-type') ?? '').includes('json')) {
    throw new Error(`Outline viewer search failed (${res.status}): ${res.text.slice(0, 200)}`);
  }
  const rows = JSON.parse(res.text) as ViewerSearchRow[];
  return rows.map((row) => ({
    term: termCodeToLabel(row.term),
    course: row.courses,
    title: row.title,
    sections: row.sections,
    url: new URL(row.url, OUTLINE_VIEWER_URL).href,
  }));
}

let viewerOutlineCache: { rows: ViewerOutlineRow[]; at: number } | null = null;
let viewerOutlineFailureAt = 0;
const VIEWER_CACHE_TTL_MS = 30 * 60 * 1000;

/** Viewer rows, cached so list_courses and get_course_outline share one fetch. */
export async function getViewerOutlines(): Promise<ViewerOutlineRow[]> {
  if (viewerOutlineCache && Date.now() - viewerOutlineCache.at < VIEWER_CACHE_TTL_MS) {
    return viewerOutlineCache.rows;
  }
  try {
    const rows = await fetchViewerOutlines();
    viewerOutlineCache = { rows, at: Date.now() };
    viewerOutlineFailureAt = 0;
    await writeCachedViewerOutlines(rows).catch((err) => {
      console.warn(`Could not cache outline viewer metadata: ${err}`);
    });
    return rows;
  } catch (err) {
    const cachedRows = await readCachedViewerOutlines();
    if (cachedRows) {
      viewerOutlineCache = { rows: cachedRows, at: Date.now() };
      console.warn(`Outline viewer unavailable (${err}); using cached outline titles.`);
      return cachedRows;
    }
    viewerOutlineFailureAt = Date.now();
    throw err;
  }
}

export async function getViewerOutlinesForTitles(): Promise<ViewerOutlineRow[]> {
  if (Date.now() - viewerOutlineFailureAt < VIEWER_CACHE_TTL_MS) {
    return [];
  }
  return getViewerOutlines();
}

async function findOutlineUrlFromViewer(course: Course): Promise<string | null> {
  const lookup = parseCourseOutlineLookup(course.name);
  if (lookup.codes.length === 0 || !lookup.term) return null;

  const rows = await getViewerOutlines();
  const match = rows.find(
    (row) =>
      row.term.toLowerCase() === lookup.term?.toLowerCase() &&
      lookup.codes.includes(normalizeCourseCode(row.course)),
  );
  return match?.url ?? null;
}

export function findViewerRow(
  rows: ViewerOutlineRow[],
  lookup: CourseOutlineLookup,
): ViewerOutlineRow | undefined {
  const byCode = rows.filter((row) => lookup.codes.includes(normalizeCourseCode(row.course)));
  // Titles are stable across terms, so any term's row will do when the LEARN
  // name's term is absent or doesn't match a viewer section.
  return byCode.find((row) => row.term.toLowerCase() === lookup.term?.toLowerCase()) ?? byCode[0];
}

/**
 * Revision date from the outline page, e.g. 'Published May 12, 2026 (latest)'
 * -> "May 12, 2026". Single-revision outlines omit the "(latest)" suffix, so
 * match the date shape itself.
 */
function parsePublishedDate(html: string): string | null {
  const m = html.match(/revision-current[^>]*>\s*Published\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})/);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

/**
 * The outline page is server-rendered, so a plain GET with the session cookies
 * is enough to read the current revision date. Returns null when the check is
 * impossible (expired session redirects to SSO, network error), so callers
 * fall back to the cached copy.
 */
async function fetchPublishedDate(outlineUrl: string): Promise<string | null> {
  try {
    const resp = await sessionGet(outlineUrl);
    if (resp.status !== 200) return null;
    return parsePublishedDate(resp.text);
  } catch {
    return null;
  }
}

/**
 * Outline pages are server-rendered, so a plain cookie-authed GET returns the
 * full content. An expired outline session answers 200 with a redirect shell
 * that bounces to SSO via JavaScript, so detect that marker rather than relying
 * on an HTTP redirect.
 */
async function fetchOutlinePageSnapshot(outlineUrl: string): Promise<CourseOutlineSnapshot> {
  const res = await sessionGet(outlineUrl, { maxRedirects: 5 });
  if (new URL(res.url).host !== OUTLINE_HOST) {
    throw new AuthError(
      `Redirected to ${res.url} - the outline.uwaterloo.ca session is missing or expired. ${LOGIN_HELP}`,
    );
  }
  const html = res.text;
  if (res.status !== 200) {
    throw new Error(`Outline page ${outlineUrl} returned HTTP ${res.status}.`);
  }
  if (html.includes('data-redirect-url')) {
    throw new AuthError(
      `${outlineUrl} served an SSO redirect page - the outline.uwaterloo.ca session is missing or expired. ${LOGIN_HELP}`,
    );
  }
  const title = stripHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '');
  return {
    url: res.url,
    title,
    text: htmlToText(html),
    html,
    publishedAt: parsePublishedDate(html),
  };
}

async function fetchLiveCourseOutline(courseId: number, course: Course | null): Promise<CourseOutlineSnapshot> {
  let viewerError: unknown = null;
  if (course) {
    try {
      const viewerOutlineUrl = await findOutlineUrlFromViewer(course);
      if (viewerOutlineUrl) return fetchOutlinePageSnapshot(viewerOutlineUrl);
    } catch (err) {
      if (err instanceof AuthError) throw err;
      viewerError = err;
      console.error(`Outline viewer lookup failed for ${course.name} (${courseId}): ${err}`);
    }
  }

  const modules = await getContent(courseId);
  const outlineUrl = findOutlineUrl(modules);
  if (outlineUrl) return fetchOutlinePageSnapshot(outlineUrl);

  const viewerNote =
    viewerError instanceof Error ? ` Outline viewer lookup also failed: ${viewerError.message}` : '';
  throw new Error(
    `No outline.uwaterloo.ca outline found for course ${course?.name ?? courseId}. ` +
      'The course may not use Outline.uwaterloo.ca, or it may upload the outline as a PDF instead. ' +
      `Use get_content to look for an outline/syllabus file.${viewerNote}`,
  );
}

// Cached outlines never expire on their own; instead each read is allowed one
// cheap revision-date probe per interval, and a full refetch only happens when
// the outline page reports a new published revision.
const REVISION_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const revisionCheckedAt = new Map<number, number>();

/**
 * Fetch the official course outline from outline.uwaterloo.ca. The outline
 * site is SSO-gated separately from LEARN; its session cookie is captured by
 * `npm run login`, so a redirect off-host means that session has expired.
 */
export async function getCourseOutline(courseId: number): Promise<CourseOutline> {
  const cached = await readCachedOutline(courseId);
  if (cached) {
    const lastChecked = revisionCheckedAt.get(courseId) ?? 0;
    if (Date.now() - lastChecked < REVISION_CHECK_INTERVAL_MS) {
      return cachedOutlineToResult(cached);
    }
    const published = await fetchPublishedDate(cached.url);
    revisionCheckedAt.set(courseId, Date.now());
    if (published === null || published === cached.publishedAt) {
      return cachedOutlineToResult(cached);
    }
    console.error(
      `Outline for course ${courseId} has a new revision (published ${published}); refetching.`,
    );
  }

  const course = await findCourse(courseId);
  let outline: CourseOutlineSnapshot;
  try {
    outline = await fetchLiveCourseOutline(courseId, course);
  } catch (err) {
    if (cached) {
      console.warn(`Refetch of updated outline for course ${courseId} failed (${err}); serving cached copy.`);
      return cachedOutlineToResult(cached);
    }
    throw err;
  }
  await writeCachedOutline(courseId, course?.name ?? null, outline).catch((err) => {
    console.warn(`Could not cache outline for course ${courseId}: ${err}`);
  });
  return { url: outline.url, title: outline.title, text: outline.text };
}

export async function refreshOutlineCache(): Promise<OutlineCacheRefreshResult> {
  const courses = await listCourses();
  const results: OutlineCacheRefreshResult['results'] = [];

  for (const course of courses) {
    try {
      const outline = await fetchLiveCourseOutline(course.ou, course);
      await writeCachedOutline(course.ou, course.name, outline);
      results.push({ courseId: course.ou, courseName: course.name, status: 'fetched' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.includes('No outline.uwaterloo.ca outline found') ? 'skipped' : 'failed';
      results.push({ courseId: course.ou, courseName: course.name, status, message });
    }
  }

  return {
    fetched: results.filter((result) => result.status === 'fetched').length,
    skipped: results.filter((result) => result.status === 'skipped').length,
    failed: results.filter((result) => result.status === 'failed').length,
    results,
  };
}
