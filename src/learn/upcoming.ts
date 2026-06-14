import { apiGet, apiVersion } from '../session.js';
import { stripHtml } from './text.js';

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
