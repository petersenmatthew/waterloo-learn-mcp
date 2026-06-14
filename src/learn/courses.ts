import { BASE_URL, LOGIN_HELP } from '../config.js';
import { apiGet, apiVersion, AuthError, newPage } from '../session.js';
import { findViewerRow, getViewerOutlinesForTitles, parseCourseOutlineLookup } from './outlines.js';
import type { ViewerOutlineRow } from './outlines.js';
import type { Course } from './types.js';

const OU_RE = /\/d2l\/home\/(\d+)/;

/**
 * Scrape the LEARN homepage for the My Courses widget. The course cards are
 * d2l web components (shadow DOM), but Playwright's CSS engine pierces shadow
 * roots, so `a[href*="/d2l/home/"]` finds the card links directly.
 */
async function scrapeCourses(): Promise<Course[]> {
  const page = await newPage();
  try {
    await page.goto(`${BASE_URL}/d2l/home`, { waitUntil: 'domcontentloaded' });

    if (!new URL(page.url()).pathname.startsWith('/d2l/home')) {
      throw new AuthError(`Redirected to ${page.url()} instead of the LEARN homepage. ${LOGIN_HELP}`);
    }

    // Best-effort: the My Courses widget tag varies by instance, so don't hard
    // fail if it's absent - just give the course-card links a chance to render.
    await page.waitForSelector('d2l-my-courses', { timeout: 8_000 }).catch(() => {});
    await page
      .waitForSelector('a[href*="/d2l/home/"]', { timeout: 8_000 })
      .catch(() => {});

    const links = await page.locator('a[href*="/d2l/home/"]').all();
    const byOu = new Map<number, Course>();
    for (const link of links) {
      const href = (await link.getAttribute('href')) ?? '';
      const match = href.match(OU_RE);
      if (!match) continue;
      const ou = Number(match[1]);

      let name = (
        await link.locator('.d2l-card-link-text').textContent({ timeout: 500 }).catch(() => null)
      )?.trim();
      name ||= (await link.getAttribute('title'))?.trim();
      name ||= (await link.getAttribute('aria-label'))?.trim();
      name ||= (await link.textContent())?.trim();
      if (!name || byOu.has(ou)) continue;

      byOu.set(ou, { name, ou, url: new URL(href, BASE_URL).href });
    }
    return [...byOu.values()];
  } finally {
    await page.close();
  }
}

interface Enrollment {
  OrgUnit: { Id: number; Name: string; Code: string | null; Type: { Code: string } };
  Access: { IsActive: boolean } | null;
}

interface PagedResultSet<T> {
  PagingInfo: { Bookmark: string; HasMoreItems: boolean };
  Items: T[];
}

/** Fallback when the homepage widget yields nothing: the enrollments API. */
async function coursesFromApi(): Promise<Course[]> {
  const lp = await apiVersion('lp');
  const courses: Course[] = [];
  let bookmark = '';
  for (let pageNum = 0; pageNum < 10; pageNum++) {
    const qs = `?orgUnitTypeId=3${bookmark ? `&bookmark=${encodeURIComponent(bookmark)}` : ''}`;
    const result = await apiGet<PagedResultSet<Enrollment>>(
      `/d2l/api/lp/${lp}/enrollments/myenrollments/${qs}`,
    );
    for (const item of result.Items) {
      if (item.Access && !item.Access.IsActive) continue;
      courses.push({
        name: item.OrgUnit.Name,
        ou: item.OrgUnit.Id,
        url: `${BASE_URL}/d2l/home/${item.OrgUnit.Id}`,
      });
    }
    if (!result.PagingInfo?.HasMoreItems) break;
    bookmark = result.PagingInfo.Bookmark;
  }
  return courses;
}

export async function listCourses(): Promise<Course[]> {
  // The enrollments API is fast and reliable across instances, so try it first.
  // Homepage scraping is the fallback (the My Courses widget markup varies).
  try {
    const courses = await coursesFromApi();
    if (courses.length > 0) return courses;
    console.error('Enrollments API returned no courses; falling back to homepage scrape.');
  } catch (err) {
    if (err instanceof AuthError) throw err;
    console.error(`Enrollments API failed (${err}); falling back to homepage scrape.`);
  }
  return scrapeCourses();
}

/**
 * Courses enriched with their official titles from the outline.uwaterloo.ca
 * viewer (LEARN names are just code + term, e.g. "SYDE 114 - Spring 2026").
 * If the outline session isn't configured or the scrape fails, courses are
 * returned with title: null rather than erroring.
 */
export async function listCoursesWithTitles(): Promise<Course[]> {
  const courses = await listCourses();
  let rows: ViewerOutlineRow[] = [];
  try {
    rows = await getViewerOutlinesForTitles();
  } catch (err) {
    console.error(`Outline viewer titles unavailable (${err}); returning LEARN names only.`);
  }
  return courses.map((course) => {
    const row = findViewerRow(rows, parseCourseOutlineLookup(course.name));
    return { ...course, title: row?.title.trim() || null };
  });
}
