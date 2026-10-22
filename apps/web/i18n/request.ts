import { getRequestConfig } from 'next-intl/server';
import { headers } from 'next/headers';
import { getInstallSettings } from '@/lib/install';
import { resolveLocale } from '@/lib/locale';

// The reader's Accept-Language when a translation exists, else the install's default.
export default getRequestConfig(async () => {
  const [accept, settings] = await Promise.all([
    headers().then((h) => h.get('accept-language')),
    getInstallSettings(),
  ]);
  const locale = resolveLocale(accept, settings.interfaceLanguage);
  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
  };
});
