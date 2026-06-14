import { BASE_URL } from '../config.js';
import { apiGet, apiVersion } from '../session.js';

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

export interface MarshalledModule {
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
