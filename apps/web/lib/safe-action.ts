import type { ActionResult } from '@/app/(app)/meetings/actions';

/** A server action that never throws: a dropped connection is a failure like any other, so the screen rolls back. */
export async function safely(run: () => Promise<ActionResult>): Promise<ActionResult> {
  try {
    return await run();
  } catch {
    return { ok: false, code: 'server' };
  }
}
