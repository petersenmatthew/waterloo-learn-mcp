import { BASE_URL, LOGIN_HELP } from './config.js';
import { apiGet, apiVersion, AuthError, newPage } from './session.js';

export interface Course {
  name: string;
  ou: number;
  url: string;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

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

    await page.waitForSelector('d2l-my-courses', { timeout: 20_000 });
    // The cards load asynchronously inside the widget; wait for the first link.
    await page
      .waitForSelector('a[href*="/d2l/home/"]', { timeout: 20_000 })
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
  try {
    const scraped = await scrapeCourses();
    if (scraped.length > 0) return scraped;
    console.error('Homepage scrape found no course cards; falling back to enrollments API.');
  } catch (err) {
    if (err instanceof AuthError) throw err;
    console.error(`Homepage scrape failed (${err}); falling back to enrollments API.`);
  }
  return coursesFromApi();
}

interface RawAnnouncement {
  Id: number;
  Title: string;
  Body: { Text: string; Html: string };
  StartDate: string | null;
  CreatedDate?: string | null;
  LastModifiedDate?: string | null;
  IsHidden?: boolean;
  Attachments?: { FileName: string }[];
}

export async function getAnnouncements(courseId: number) {
  const le = await apiVersion('le');
  const news = await apiGet<RawAnnouncement[]>(`/d2l/api/le/${le}/${courseId}/news/`);
  return news.map((item) => ({
    id: item.Id,
    title: item.Title,
    body: item.Body?.Text?.trim() || stripHtml(item.Body?.Html ?? ''),
    postedDate: item.StartDate ?? item.CreatedDate ?? null,
    lastModified: item.LastModifiedDate ?? null,
    attachments: item.Attachments?.map((a) => a.FileName) ?? [],
  }));
}

interface TocTopic {
  Identifier: string;
  Title: string;
  TypeIdentifier: string;
  Url: string | null;
  IsBroken?: boolean;
}

interface TocModule {
  ModuleId: number;
  Title: string;
  Modules: TocModule[];
  Topics: TocTopic[];
}

interface MarshalledModule {
  title: string;
  moduleId: number;
  topics: { title: string; type: string; url: string | null; id: string }[];
  modules: MarshalledModule[];
}

function marshalModule(mod: TocModule): MarshalledModule {
  return {
    title: mod.Title,
    moduleId: mod.ModuleId,
    topics: (mod.Topics ?? []).map((t) => ({
      title: t.Title,
      type: t.TypeIdentifier,
      url: t.Url ? new URL(t.Url, BASE_URL).href : null,
      id: t.Identifier,
    })),
    modules: (mod.Modules ?? []).map(marshalModule),
  };
}

export async function getContent(courseId: number) {
  const le = await apiVersion('le');
  const toc = await apiGet<{ Modules: TocModule[] }>(`/d2l/api/le/${le}/${courseId}/content/toc`);
  return (toc.Modules ?? []).map(marshalModule);
}

interface RawGradeValue {
  GradeObjectName: string;
  GradeObjectTypeName?: string;
  DisplayedGrade: string | null;
  PointsNumerator: number | null;
  PointsDenominator: number | null;
  WeightedNumerator?: number | null;
  WeightedDenominator?: number | null;
  Comments?: { Text: string; Html: string } | null;
}

/** Fallback: scrape the My Grades page table when the grades API is restricted. */
async function scrapeGrades(courseId: number) {
  const page = await newPage();
  try {
    await page.goto(`${BASE_URL}/d2l/lms/grades/my_grades/main.d2l?ou=${courseId}`, {
      waitUntil: 'domcontentloaded',
    });
    if (page.url().includes('login') || page.url().includes('error')) {
      throw new AuthError(`Could not open My Grades for course ${courseId}. ${LOGIN_HELP}`);
    }
    await page.waitForSelector('table.d2l-table', { timeout: 15_000 });
    const rows = await page.locator('table.d2l-table tr').all();
    const grades: { item: string; grade: string }[] = [];
    for (const row of rows) {
      const cells = (await row.locator('th, td').allTextContents()).map((c) =>
        c.replace(/\s+/g, ' ').trim(),
      );
      const [item, ...rest] = cells;
      const grade = rest.filter(Boolean).join(' | ');
      if (item && grade) grades.push({ item, grade });
    }
    return grades;
  } finally {
    await page.close();
  }
}

export async function getGrades(courseId: number) {
  const le = await apiVersion('le');
  try {
    const values = await apiGet<RawGradeValue[]>(
      `/d2l/api/le/${le}/${courseId}/grades/values/myGradeValues/`,
    );
    return values.map((g) => ({
      item: g.GradeObjectName,
      type: g.GradeObjectTypeName ?? null,
      grade: g.DisplayedGrade,
      points:
        g.PointsNumerator != null && g.PointsDenominator != null
          ? `${g.PointsNumerator}/${g.PointsDenominator}`
          : null,
      weight:
        g.WeightedNumerator != null && g.WeightedDenominator != null
          ? `${g.WeightedNumerator}/${g.WeightedDenominator}`
          : null,
      feedback: g.Comments?.Text?.trim() || (g.Comments?.Html ? stripHtml(g.Comments.Html) : null) || null,
    }));
  } catch (err) {
    if (err instanceof AuthError) throw err;
    console.error(`Grades API failed (${err}); scraping the My Grades page instead.`);
    return scrapeGrades(courseId);
  }
}

interface RawCalendarEvent {
  EventId: number;
  OrgUnitId: number;
  Title: string;
  Description: string | null;
  StartDateTime: string;
  EndDateTime: string | null;
  IsAllDayEvent: boolean;
  HasVisited?: boolean;
}

export async function getUpcoming(courseId: number, daysAhead = 30) {
  const le = await apiVersion('le');
  const start = new Date();
  const end = new Date(start.getTime() + daysAhead * 24 * 60 * 60 * 1000);
  const qs = new URLSearchParams({
    startDateTime: start.toISOString(),
    endDateTime: end.toISOString(),
  });
  const data = await apiGet<RawCalendarEvent[] | { Objects: RawCalendarEvent[] }>(
    `/d2l/api/le/${le}/${courseId}/calendar/events/myEvents/?${qs}`,
  );
  const events = Array.isArray(data) ? data : (data.Objects ?? []);
  return events
    .map((e) => ({
      title: e.Title,
      start: e.StartDateTime,
      end: e.EndDateTime,
      allDay: e.IsAllDayEvent,
      description: e.Description ? stripHtml(e.Description) : null,
    }))
    .sort((a, b) => a.start.localeCompare(b.start));
}
