export interface Course {
  name: string;
  ou: number;
  url: string;
  /** Official course title from outline.uwaterloo.ca, e.g. "Matrices and Linear Systems". */
  title?: string | null;
}

export interface CourseOutline {
  url: string;
  title: string;
  text: string;
}

export interface OutlineCacheRefreshResult {
  fetched: number;
  skipped: number;
  failed: number;
  results: {
    courseId: number;
    courseName: string;
    status: 'fetched' | 'skipped' | 'failed';
    message?: string;
  }[];
}

export interface TopicFileResult {
  filename: string;
  totalPages: number;
  /** Pages actually rendered (1-based numbers matching slide numbers). */
  pages: { page: number; png: Buffer }[];
  /** Set when more pages exist than were rendered. */
  note?: string;
}
