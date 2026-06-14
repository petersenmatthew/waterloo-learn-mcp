import { BASE_URL, LOGIN_HELP } from '../config.js';
import { apiGet, apiVersion, AuthError, newPage } from '../session.js';
import { stripHtml } from './text.js';

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
