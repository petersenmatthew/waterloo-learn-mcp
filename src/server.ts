import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getAnnouncements, getContent, getGrades, getUpcoming, listCourses } from './d2l.js';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const result = await fn();
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
      isError: true,
    };
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
