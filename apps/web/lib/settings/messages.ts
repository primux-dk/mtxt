import 'server-only';
import { getTranslations } from 'next-intl/server';
import { formatRatio } from '../theme/contrast';
import type { EndpointError, FieldError, TemplateError } from './validate';

type T = Awaited<ReturnType<typeof getTranslations<'settings'>>>;

/** A validation code as the sentence the reader sees at the field, in their language. */
export function fieldMessage(t: T, error: FieldError | TemplateError | EndpointError): string {
  switch (error.code) {
    case 'contrast':
      return t('errors.contrast', {
        pair: t(`theme.pair.${error.pair}`),
        ratio: formatRatio(error.ratio),
        mode: t(`theme.mode.${error.mode}`),
      });
    case 'tooLong':
    case 'tooMany':
      return t(`errors.${error.code}`, { max: error.max });
    case 'hex':
    case 'email':
      return t(`errors.${error.code}`, { value: error.value });
    case 'termTooLong':
      return t('errors.termTooLong', { record: error.record, max: error.max });
    case 'badBoost':
      return t('errors.badBoost', { record: error.record, value: error.value, max: error.max });
    case 'tooManyFields':
    case 'unterminatedQuote':
      return t(`errors.${error.code}`, { record: error.record });
    case 'range':
      return t('errors.range', { min: error.min, max: error.max });
    case 'keepSelf':
      return t('errors.keepSelf', { email: error.email });
    case 'duplicate':
      return t('errors.duplicate', { name: error.name });
    default:
      return t(`errors.${error.code}`);
  }
}
