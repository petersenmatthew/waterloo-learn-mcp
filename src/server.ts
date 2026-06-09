import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getAnnouncements, getContent, getGrades, getTopicFile, getUpcoming, listCourses } from './d2l.js';

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string };
type ToolResult = { content: ContentBlock[]; isError?: boolean };

function errorResult(err: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
    isError: true,
  };
}

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const result = await fn();
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return errorResult(err);
  }
}

const courseId = z.number().int().describe('The course org unit (ou) ID from list_courses, e.g. 123456');

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
    },
    async () => run(() => listCourses()),
  );

  server.registerTool(
    'get_announcements',
    {
      title: 'Get Announcements',
      description:
        'Get announcements/news posted by instructors for a course. Returns title, body, posted date, ' +
        'and attachments. Use to answer: "Any new announcements?", "What did the professor post?"',
      inputSchema: z.object({ courseId }),
    },
    async ({ courseId }) => run(() => getAnnouncements(courseId)),
  );

  server.registerTool(
    'get_content',
    {
      title: 'Get Course Content',
      description:
        'List the content modules and materials (lectures, slides, files, links) for a course as a ' +
        'nested table of contents. Use to answer: "What materials are in week 3?", "Where are the lecture slides?"',
      inputSchema: z.object({ courseId }),
    },
    async ({ courseId }) => run(() => getContent(courseId)),
  );

  server.registerTool(
    'get_topic_file',
    {
      title: 'Get Topic File as Slide Images',
      description:
        'Download a lecture file (PDF or PowerPoint) from course content and return each page/slide ' +
        'as an image you can read — including diagrams and figures. topicId is the `id` of a topic from ' +
        'get_content. Slide N = page N; pass pages like "4" or "2-6" to fetch specific slides instead of ' +
        'the whole deck. Use to answer: "Summarize lesson 2", "What is the diagram on slide 4?"',
      inputSchema: z.object({
        courseId,
        topicId: z.string().describe('The topic `id` from get_content, e.g. "1234567"'),
        pages: z
          .string()
          .optional()
          .describe('Pages/slides to render, e.g. "4", "1-5", or "2,4,7-9". Default: all (capped at 25).'),
      }),
    },
    async ({ courseId, topicId, pages }) => {
      try {
        const result = await getTopicFile(courseId, topicId, pages);
        const header =
          `${result.filename} — ${result.totalPages} page(s); showing ` +
          `${result.pages.map((p) => p.page).join(', ')}.` +
          (result.note ? ` ${result.note}` : '');
        return {
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
    },
    async ({ courseId }) => run(() => getGrades(courseId)),
  );

  server.registerTool(
    'get_upcoming',
    {
      title: 'Get Upcoming Due Dates',
      description:
        'Get upcoming calendar events and due dates (assignments, quizzes, exams) for a course. ' +
        'Use to answer: "What is due this week?", "When is the next deadline?"',
      inputSchema: z.object({
        courseId,
        daysAhead: z.number().int().min(1).max(365).optional()
          .describe('How many days ahead to look (default 30)'),
      }),
    },
    async ({ courseId, daysAhead }) => run(() => getUpcoming(courseId, daysAhead)),
  );

  return server;
}
