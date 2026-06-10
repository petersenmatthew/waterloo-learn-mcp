import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  getAnnouncements,
  getAssignments,
  getContent,
  getCourseOutline,
  getGrades,
  getTopicFile,
  getUpcoming,
  listCourses,
} from './d2l.js';

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string };
type ToolResult = { content: ContentBlock[]; structuredContent?: Record<string, unknown>; isError?: boolean };

function errorResult(err: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
    isError: true,
  };
}

async function runStructured<T>(
  fn: () => Promise<T>,
  wrap: (result: T) => Record<string, unknown>,
): Promise<ToolResult> {
  try {
    const result = await fn();
    return {
      structuredContent: wrap(result),
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return errorResult(err);
  }
}

const courseId = z.number().int().describe('The course org unit (ou) ID from list_courses, e.g. 123456');

const courseOutput = z.object({
  name: z.string(),
  ou: z.number().int(),
  url: z.string(),
});
const listCoursesOutput = z.object({ courses: z.array(courseOutput) });

const announcementsOutput = z.object({
  announcements: z.array(
    z.object({
      id: z.number().int(),
      title: z.string(),
      body: z.string(),
      postedDate: z.string().nullable(),
      lastModified: z.string().nullable(),
      attachments: z.array(z.string()),
    }),
  ),
});

const contentTopicOutput = z.object({
  title: z.string(),
  type: z.string(),
  url: z.string().nullable(),
  id: z.string(),
});
const contentModuleOutput: z.ZodType<{
  title: string;
  moduleId: number;
  topics: z.infer<typeof contentTopicOutput>[];
  modules: unknown[];
}> = z.lazy(() =>
  z.object({
    title: z.string(),
    moduleId: z.number().int(),
    topics: z.array(contentTopicOutput),
    modules: z.array(contentModuleOutput),
  }),
);
const contentOutput = z.object({ modules: z.array(contentModuleOutput) });

const topicFileOutput = z.object({
  filename: z.string(),
  totalPages: z.number().int(),
  pages: z.array(z.object({ page: z.number().int() })),
  note: z.string().optional(),
});

const gradesOutput = z.object({
  grades: z.array(
    z.object({
      item: z.string(),
      type: z.string().nullable().optional(),
      grade: z.string().nullable(),
      points: z.string().nullable().optional(),
      weight: z.string().nullable().optional(),
      feedback: z.string().nullable().optional(),
    }),
  ),
});

const assignmentsOutput = z.object({
  assignments: z.array(
    z.object({
      id: z.number().int(),
      name: z.string(),
      dueDate: z.string().nullable(),
      availableUntil: z.string().nullable(),
      instructions: z.string().nullable(),
      attachments: z.array(z.string()),
      outOf: z.number().nullable(),
      submissionStatus: z.string(),
      submittedAt: z.string().nullable(),
      submissions: z.array(
        z.object({
          date: z.string(),
          files: z.array(z.string()),
          comment: z.string().nullable(),
        }),
      ),
      feedback: z
        .object({
          score: z.number().nullable(),
          comment: z.string().nullable(),
          files: z.array(z.string()),
        })
        .nullable(),
    }),
  ),
});

const outlineOutput = z.object({
  url: z.string(),
  title: z.string(),
  text: z.string(),
});

const upcomingOutput = z.object({
  events: z.array(
    z.object({
      title: z.string(),
      start: z.string(),
      end: z.string().nullable(),
      allDay: z.boolean(),
      description: z.string().nullable(),
    }),
  ),
});

/** Build a fresh McpServer with all LEARN tools registered. */
export function createServer(): McpServer {
  const server = new McpServer({ name: 'waterloo-learn', version: '0.1.0' });

  server.registerTool(
    'list_courses',
    {
      title: 'List Courses',
      description:
        'List the courses you are enrolled in on Waterloo LEARN. Returns course names and their ou ' +
        '(org unit) IDs, which the other tools take as courseId. Use to answer: "What courses am I taking?"',
      inputSchema: z.object({}),
      outputSchema: listCoursesOutput,
    },
    async () => runStructured(() => listCourses(), (courses) => ({ courses })),
  );

  server.registerTool(
    'get_announcements',
    {
      title: 'Get Announcements',
      description:
        'Get announcements/news posted by instructors for a course. Returns title, body, posted date, ' +
        'and attachments. Use to answer: "Any new announcements?", "What did the professor post?" ' +
        'Announcements are not a complete record of lectures, tutorials, labs, or weekly work; for ' +
        '"what did we do today/in class/this week?" also call get_content, then get_topic_file for relevant files.',
      inputSchema: z.object({ courseId }),
      outputSchema: announcementsOutput,
    },
    async ({ courseId }) => runStructured(() => getAnnouncements(courseId), (announcements) => ({ announcements })),
  );

  server.registerTool(
    'get_content',
    {
      title: 'Get Course Content',
      description:
        'List the content modules and materials (lectures, slides, files, links) for a course as a ' +
        'nested table of contents. Use this as the primary source for course activity questions like ' +
        '"what did we do today?", "what was in today\'s tutorial/lab/lecture?", "what is this week\'s work?", ' +
        '"what materials are in week 3?", or "where are the lecture slides?". After identifying relevant topics, ' +
        'call get_topic_file to inspect PDFs or PowerPoints.',
      inputSchema: z.object({ courseId }),
      outputSchema: contentOutput,
    },
    async ({ courseId }) => runStructured(() => getContent(courseId), (modules) => ({ modules })),
  );

  server.registerTool(
    'get_topic_file',
    {
      title: 'Get Topic File as Slide Images',
      description:
        'Download a lecture file (PDF or PowerPoint) from course content and return each page/slide ' +
        'as an image you can read — including diagrams and figures. topicId is the `id` of a topic from ' +
        'get_content. Slide N = page N; pass pages like "4" or "2-6" to fetch specific slides instead of ' +
        'the whole deck. Use after get_content to answer: "Summarize lesson 2", "What is the diagram on slide 4?"',
      inputSchema: z.object({
        courseId,
        topicId: z.string().describe('The topic `id` from get_content, e.g. "1234567"'),
        pages: z
          .string()
          .optional()
          .describe('Pages/slides to render, e.g. "4", "1-5", or "2,4,7-9". Default: the whole document (capped at 30 per call; the response notes how to fetch the rest).'),
      }),
      outputSchema: topicFileOutput,
    },
    async ({ courseId, topicId, pages }) => {
      try {
        const result = await getTopicFile(courseId, topicId, pages);
        const structuredContent = {
          filename: result.filename,
          totalPages: result.totalPages,
          pages: result.pages.map((p) => ({ page: p.page })),
          ...(result.note ? { note: result.note } : {}),
        };
        const header =
          `${result.filename} — ${result.totalPages} page(s); showing ` +
          `${result.pages.map((p) => p.page).join(', ')}.` +
          (result.note ? ` ${result.note}` : '');
        return {
          structuredContent,
          content: [
            { type: 'text' as const, text: header },
            ...result.pages.map((p) => ({
              type: 'image' as const,
              mimeType: 'image/png',
              data: p.png.toString('base64'),
            })),
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_grades',
    {
      title: 'Get Grades',
      description:
        'Get your grades for a course: each grade item with displayed grade, points, weight, and feedback. ' +
        'Use to answer: "What are my grades?", "How did I do on the midterm?"',
      inputSchema: z.object({ courseId }),
      outputSchema: gradesOutput,
    },
    async ({ courseId }) => runStructured(() => getGrades(courseId), (grades) => ({ grades })),
  );

  server.registerTool(
    'get_assignments',
    {
      title: 'Get Assignments',
      description:
        'Get assignments (dropbox folders) for a course: due date, instructions, attached problem sheets, ' +
        'your submission status (submitted/unsubmitted), submitted files, and released feedback/score. ' +
        'Use to answer: "Have I submitted Assignment 5?", "What is still due?", "What feedback did I get?"',
      inputSchema: z.object({ courseId }),
      outputSchema: assignmentsOutput,
    },
    async ({ courseId }) => runStructured(() => getAssignments(courseId), (assignments) => ({ assignments })),
  );

  server.registerTool(
    'get_upcoming',
    {
      title: 'Get Upcoming Due Dates',
      description:
        'Get upcoming calendar events and due dates (assignments, quizzes, exams) for a course. ' +
        'Use to answer: "What is due this week?", "When is the next deadline?", or "what work is due today?". ' +
        'This does not list lecture/tutorial materials; pair it with get_content for "what did we do today/this week?"',
      inputSchema: z.object({
        courseId,
        daysAhead: z.number().int().min(1).max(365).optional()
          .describe('How many days ahead to look (default 30)'),
      }),
      outputSchema: upcomingOutput,
    },
    async ({ courseId, daysAhead }) => runStructured(() => getUpcoming(courseId, daysAhead), (events) => ({ events })),
  );

  server.registerTool(
    'get_course_outline',
    {
      title: 'Get Course Outline',
      description:
        'Fetch the official course outline (syllabus) and return its full text. ' +
        'Use to answer: "What is the grading scheme?", "How much is the midterm worth?", "What is the late policy?", ' +
        '"When are office hours?". Outlines include a week-by-week schedule, use it to orient ' +
        'chronologically — "What are we covering this week?", "What did we do last week in calc?"'+
        'then call get_content/get_topic_file to pull the matching lecture materials. This is ' +
        'the authoritative syllabus document, separate from the lecture materials in get_content. If no outline ' +
        'link exists, check get_content for an uploaded PDF outline instead.',
      inputSchema: z.object({ courseId }),
      outputSchema: outlineOutput,
    },
    async ({ courseId }) =>
      runStructured(() => getCourseOutline(courseId), (outline) => ({ ...outline })),
  );

  return server;
}
