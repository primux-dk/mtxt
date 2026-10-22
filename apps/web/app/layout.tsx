import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale } from 'next-intl/server';
import { getInstallSettings } from '@/lib/install';
import './globals.css';

export async function generateMetadata(): Promise<Metadata> {
  const { productName } = await getInstallSettings();
  return { title: productName };
}

// Dark mode follows the operating system (docs/design/README.md): tokens.css
// switches on `.dark` on <html>. Runs before paint so there is no flash.
const followSystemTheme = `(()=>{const m=matchMedia('(prefers-color-scheme: dark)');const s=()=>document.documentElement.classList.toggle('dark',m.matches);s();m.addEventListener('change',s)})()`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const [locale, settings] = await Promise.all([getLocale(), getInstallSettings()]);
  // The install's two theme values; every other colour derives from them in
  // tokens.css. `html:root` outranks tokens.css's `:root`. Values are checked
  // to be #rrggbb by readSettings.
  const theme = `html:root{--theme-accent:${settings.themeAccent};--theme-primary:${settings.themePrimary}}`;

  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        <meta name="color-scheme" content="light dark" />
        <style>{theme}</style>
        <script dangerouslySetInnerHTML={{ __html: followSystemTheme }} />
      </head>
      <body>
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
