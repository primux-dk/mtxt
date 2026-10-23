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
