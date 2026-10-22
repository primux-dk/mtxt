import 'server-only';
import { redirect } from 'next/navigation';
import { getCurrentUser, type CurrentUser } from './auth';
import { HttpError } from './http-error';

/** The signed-in user for a page; without one, the login page (packet 2). */
export async function pageUser(): Promise<CurrentUser> {
  try {
    return await getCurrentUser();
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) redirect('/login');
    throw error;
  }
}
