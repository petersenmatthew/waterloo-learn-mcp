import { apiGet, apiVersion, AuthError } from '../session.js';
import { stripHtml } from './text.js';

interface RawDropboxFolder {
  Id: number;
  Name: string;
  CustomInstructions: { Text: string; Html: string } | null;
  Attachments: { FileId: number; FileName: string; Size: number }[];
  Availability: { StartDate: string | null; EndDate: string | null } | null;
  DueDate: string | null;
  IsHidden: boolean;
  Assessment: { ScoreDenominator: number | null } | null;
  GradeItemId: number | null;
}

interface RawEntityDropbox {
  Entity: { EntityId: number; EntityType: string };
  Status: number;
  Feedback: {
    Score: number | null;
    Feedback: { Text: string; Html: string } | null;
    Files?: { FileName: string }[];
  } | null;
  Submissions: {
    Id: number;
    SubmissionDate: string;
    Comment: { Text: string; Html: string } | null;
    Files: { FileName: string; Size: number }[];
  }[];
  CompletionDate: string | null;
}

const DROPBOX_STATUS: Record<number, string> = { 0: 'unsubmitted', 1: 'submitted', 2: 'draft' };

/**
 * Assignments (dropbox folders) with the caller's own submission status and
 * any released feedback. Called as a student, the submissions endpoint returns
 * only your own entity; a folder whose submissions can't be read still appears
 * with submissionStatus "unknown".
 */
export async function getAssignments(courseId: number) {
  const le = await apiVersion('le');
  const folders = await apiGet<RawDropboxFolder[]>(`/d2l/api/le/${le}/${courseId}/dropbox/folders/`);

  return Promise.all(
    folders
      .filter((f) => !f.IsHidden)
      .map(async (f) => {
        // An empty array means no submission record yet (unsubmitted); only a
        // failed call leaves the status truly unknown.
        let entity: RawEntityDropbox | undefined;
        let status = 'unknown';
        try {
          const entities = await apiGet<RawEntityDropbox[]>(
            `/d2l/api/le/${le}/${courseId}/dropbox/folders/${f.Id}/submissions/`,
          );
          entity = entities[0];
          status = entity ? (DROPBOX_STATUS[entity.Status] ?? `status ${entity.Status}`) : 'unsubmitted';
        } catch (err) {
          if (err instanceof AuthError) throw err;
          console.error(`Submissions unavailable for dropbox ${f.Id} (${err}).`);
        }

        const feedback = entity?.Feedback;
        return {
          id: f.Id,
          name: f.Name.trim(),
          dueDate: f.DueDate,
          availableUntil: f.Availability?.EndDate ?? null,
          instructions:
            f.CustomInstructions?.Text?.trim() ||
            (f.CustomInstructions?.Html ? stripHtml(f.CustomInstructions.Html) : null) ||
            null,
          attachments: f.Attachments?.map((a) => a.FileName) ?? [],
          outOf: f.Assessment?.ScoreDenominator ?? null,
          submissionStatus: status,
          submittedAt: entity?.CompletionDate ?? null,
          submissions:
            entity?.Submissions.map((s) => ({
              date: s.SubmissionDate,
              files: s.Files.map((file) => file.FileName),
              comment: s.Comment?.Text?.trim() || null,
            })) ?? [],
          feedback: feedback
            ? {
                score: feedback.Score,
                comment:
                  feedback.Feedback?.Text?.trim() ||
                  (feedback.Feedback?.Html ? stripHtml(feedback.Feedback.Html) : null) ||
                  null,
                files: feedback.Files?.map((file) => file.FileName) ?? [],
              }
            : null,
        };
      }),
  );
}
