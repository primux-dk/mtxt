import { getRequestConfig } from 'next-intl/server';
import { headers } from 'next/headers';
import { resolveLocale, type Locale } from '@/lib/locale';

// TODO(packet 2): read the default from the settings row's interface_language.
const INSTALL_DEFAULT_LOCALE: Locale = 'en';

export default getRequestConfig(async () => {
  const locale = resolveLocale((await headers()).get('accept-language'), INSTALL_DEFAULT_LOCALE);
  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
  };
});
