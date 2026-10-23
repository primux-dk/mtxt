/*
  What the recap panel and the API answer with: versions as the browser
  sees them. Shared by the server page and the routes.
*/
import type { VersionInfo } from './store';

export interface VersionView {
  id: string;
  number: number;
  /** Null for an AI version. */
  author: string | null;
  createdAt: string;
  note: string | null;
}

export const versionView = (v: VersionInfo): VersionView => ({
  id: v.id,
  number: v.number,
  author: v.authorId ? (v.authorName ?? '') : null,
  createdAt: v.createdAt.toISOString(),
  note: v.note,
});

/** A version as the REST API answers with it (lib/rest/meetings.ts, recapVersionView). */
export interface ApiVersion {
  id: string;
  number: number;
  author: { id: string; name: string } | null;
  created_at: string;
  note: string | null;
}

/** The API's version as the editor holds it. */
export const fromApiVersion = (v: ApiVersion): VersionView => ({
  id: v.id,
  number: v.number,
  author: v.author ? v.author.name : null,
  createdAt: v.created_at,
  note: v.note,
});
