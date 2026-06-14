import { apiGet, apiVersion } from '../session.js';
import { stripHtml } from './text.js';

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
