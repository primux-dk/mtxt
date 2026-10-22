import { type NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth/session';
import { designAsset, guidelinesPage } from '@/lib/design-assets';
import { getInstallSettings } from '@/lib/install';

/*
  /design serves docs/design: the guidelines rendered with the install's own
  theme, plus the files they link to (tokens.css, fonts, mockups, locales).
  Signed-in users only: the middleware gates it, and this checks again.
*/
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path?: string[] }> },
) {
  const { path = [] } = await params;
  if (!(await getSessionUser())) {
    const login = new URL('/login', request.url);
    login.searchParams.set('callbackUrl', '/design/');
    return NextResponse.redirect(login);
  }

  // The guidelines link relative to their own folder, so the page lives at /design/.
  if (request.nextUrl.pathname === '/design') {
    return NextResponse.redirect(new URL('/design/', request.url), 308);
  }

  const file = path.join('/');
  if (file === '' || file === 'guidelines.html') {
    const settings = await getInstallSettings();
    return new Response(
      guidelinesPage({ accent: settings.themeAccent, primary: settings.themePrimary }),
      { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
    );
  }

  const asset = designAsset(file);
  if (!asset) return new Response('Not found', { status: 404 });
  return new Response(asset.body, {
    headers: { 'content-type': asset.type, 'cache-control': 'private, max-age=300' },
  });
}
