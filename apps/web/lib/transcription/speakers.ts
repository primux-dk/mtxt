/** Speaker rows for a finished transcript: reuse what the meeting has, add what it lacks. */
import type { SttSpeaker } from '../stt/types';

export interface ExistingSpeaker {
  id: string;
  speakerIndex: number | null;
}

/**
 * Which speaker rows a result needs. A meeting keeps one row per provider
 * speaker number, so a second recording of it, or a transcript made again,
 * lands on the row the owner may have renamed. New rows are "Speaker n"
 * unless the provider named the speaker.
 */
export function planSpeakers(
  existing: readonly ExistingSpeaker[],
  wanted: readonly SttSpeaker[],
): { reuse: Map<number, string>; create: { speakerIndex: number; label: string }[] } {
  const byIndex = new Map<number, string>();
  for (const s of existing) if (s.speakerIndex !== null) byIndex.set(s.speakerIndex, s.id);
  const reuse = new Map<number, string>();
  const create: { speakerIndex: number; label: string }[] = [];
  for (const s of wanted) {
    const id = byIndex.get(s.index);
    if (id) reuse.set(s.index, id);
    else create.push({ speakerIndex: s.index, label: s.label?.trim() || defaultLabel(s.index) });
  }
  return { reuse, create };
}

/** The stored label of a speaker nobody has named. The page shows it in the reader's language. */
export const defaultLabel = (index: number) => `Speaker ${index + 1}`;

/** The number in a default label, or null when the speaker has a name. */
export function unnamedNumber(label: string): number | null {
  const match = /^Speaker (\d{1,3})$/.exec(label);
  return match ? Number(match[1]) : null;
}
