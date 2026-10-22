'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

/**
 * A date or time in the reader's own time zone and the locale's own format
 * (`locale.intl`: en-GB or da-DK, docs/design/README.md). The server does
 * not know the reader's zone, so it renders UTC and the browser corrects it
 * after hydration.
 */
export function LocalTime({
  date,
  options,
  className,
}: {
  date: Date | string;
  options: Intl.DateTimeFormatOptions;
  className?: string;
}) {
  const intl = useTranslations('locale')('intl');
  const [timeZone, setTimeZone] = useState<string | undefined>('UTC');
  useEffect(() => setTimeZone(undefined), []);
  const value = typeof date === 'string' ? new Date(date) : date;
  return (
    <time dateTime={value.toISOString()} className={className} suppressHydrationWarning>
      {new Intl.DateTimeFormat(intl, { ...options, timeZone }).format(value)}
    </time>
  );
}
