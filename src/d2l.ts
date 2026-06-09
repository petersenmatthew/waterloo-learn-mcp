import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pdfToPng } from 'pdf-to-png-converter';
import { BASE_URL, LOGIN_HELP } from './config.js';
import { apiGet, apiGetBinary, apiVersion, AuthError, newPage } from './session.js';

const execFileAsync = promisify(execFile);

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

    // Best-effort: the My Courses widget tag varies by instance, so don't hard
    // fail if it's absent — just give the course-card links a chance to render.
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

const MAX_PAGES = 25;
const VIEWPORT_SCALE = 2;

export interface TopicFileResult {
  filename: string;
  totalPages: number;
  /** Pages actually rendered (1-based numbers matching slide numbers). */
  pages: { page: number; png: Buffer }[];
  /** Set when more pages exist than were rendered. */
  note?: string;
}

/** Parse "4", "1-5", or "2,4,7-9" into a sorted list of unique 1-based page numbers. */
function parsePages(spec: string): number[] {
  const pages = new Set<number>();
  for (const part of spec.split(',')) {
    const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) throw new Error(`Invalid pages value "${spec}" — use forms like "4", "1-5", or "2,4,7-9".`);
    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : start;
    if (start < 1 || end < start) throw new Error(`Invalid page range "${part.trim()}" in "${spec}".`);
    for (let p = start; p <= end && pages.size <= MAX_PAGES; p++) pages.add(p);
  }
  return [...pages].sort((a, b) => a - b);
}

/** Find a LibreOffice binary for PPTX→PDF conversion, or null if not installed. */
async function findSoffice(): Promise<string | null> {
  const candidates = [
    'soffice',
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    '/usr/bin/soffice',
    '/usr/local/bin/soffice',
    '/opt/homebrew/bin/soffice',
  ];
  for (const bin of candidates) {
    try {
      await execFileAsync(bin, ['--version'], { timeout: 15_000 });
      return bin;
    } catch {
      // not found / not executable — try the next candidate
    }
  }
  return null;
}

async function pptxToPdf(pptx: Buffer, filename: string): Promise<Buffer> {
  const soffice = await findSoffice();
  if (!soffice) {
    throw new Error(
      'This topic is a PowerPoint file, and rendering it needs LibreOffice. ' +
        'Install it with `brew install --cask libreoffice` (macOS) and retry.',
    );
  }
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'learn-mcp-'));
  try {
    const inputPath = path.join(tmpDir, filename.replace(/[/\\]/g, '_') || 'slides.pptx');
    await fs.writeFile(inputPath, pptx);
    await execFileAsync(soffice, ['--headless', '--convert-to', 'pdf', '--outdir', tmpDir, inputPath], {
      timeout: 120_000,
    });
    const pdfPath = inputPath.replace(/\.[^.]+$/, '') + '.pdf';
    return await fs.readFile(pdfPath);
  } catch (err) {
    throw new Error(`LibreOffice failed to convert ${filename} to PDF: ${err instanceof Error ? err.message : err}`);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Download a topic's file and render it to one PNG per page/slide, so the
 * model can read both the text and the diagrams. PDFs render directly;
 * PPT/PPTX go through LibreOffice → PDF first.
 */
export async function getTopicFile(
  courseId: number,
  topicId: string,
  pagesSpec?: string,
): Promise<TopicFileResult> {
  const le = await apiVersion('le');
  let file;
  try {
    file = await apiGetBinary(`/d2l/api/le/${le}/${courseId}/content/topics/${topicId}/file`);
  } catch (err) {
    if (err instanceof AuthError) throw err;
    // Some topic types 404 on the API route; the legacy direct-download route
    // covers them with the same session cookies.
    file = await apiGetBinary(`/d2l/le/content/${courseId}/topics/files/download/${topicId}/DirectFileTopicDownload`);
  }

  const filename = file.filename ?? 'file';
  const ext = path.extname(filename).toLowerCase();
  const isPdf = ext === '.pdf' || file.contentType.includes('application/pdf') || file.body.subarray(0, 4).toString() === '%PDF';
  const isPpt = ext === '.pptx' || ext === '.ppt' || file.contentType.includes('presentation');

  let pdf: Buffer;
  if (isPdf) {
    pdf = file.body;
  } else if (isPpt) {
    pdf = await pptxToPdf(file.body, filename);
  } else {
    throw new Error(
      `Topic file "${filename}" (${file.contentType || 'unknown type'}) is not a PDF or PowerPoint — ` +
        'only those can be rendered to images. Use get_content for its URL instead.',
    );
  }

  const meta = await pdfToPng(pdf, { returnMetadataOnly: true });
  const totalPages = meta.length;

  let pagesToProcess = pagesSpec ? parsePages(pagesSpec) : Array.from({ length: totalPages }, (_, i) => i + 1);
  pagesToProcess = pagesToProcess.filter((p) => p <= totalPages);
  if (pagesToProcess.length === 0) {
    throw new Error(`No pages to render: "${pagesSpec}" is outside this document's range (1-${totalPages}).`);
  }
  let note: string | undefined;
  if (pagesToProcess.length > MAX_PAGES) {
    pagesToProcess = pagesToProcess.slice(0, MAX_PAGES);
    note =
      `Rendered the first ${MAX_PAGES} of ${totalPages} pages. ` +
      `Call again with pages="${pagesToProcess[MAX_PAGES - 1] + 1}-${totalPages}" for the rest.`;
  }

  const rendered = await pdfToPng(pdf, { viewportScale: VIEWPORT_SCALE, pagesToProcess });
  return {
    filename,
    totalPages,
    pages: rendered
      .filter((p) => p.content)
      .map((p) => ({ page: p.pageNumber, png: p.content as Buffer })),
    note,
  };
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
