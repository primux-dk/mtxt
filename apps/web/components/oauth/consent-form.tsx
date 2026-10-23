'use client';

import { TriangleAlert } from 'lucide-react';
import { useActionState, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { approveMcp, cancelMcp, type ConsentState } from '@/app/oauth/authorize/actions';
import { Button } from '@/components/ui/button';

/**
 * The access to give, Approve (the one primary) and Cancel, as server
 * actions on one form, so the page is CSRF-safe. The answer is where the
 * browser goes next, the client's own redirect URI, which may be an app's
 * scheme rather than a web address, so the page goes there itself. An
 * error stays at the buttons and says what to do next (behaviour.md rule 9).
 */
export function ConsentForm({
  query,
  scope,
  full,
  max,
}: {
  query: string;
  scope: 'read' | 'read_write';
  full: boolean;
  max: number;
}) {
  const t = useTranslations('oauth');
  const [chosen, setChosen] = useState(scope);
  const [approved, approve, approving] = useActionState<ConsentState, FormData>(approveMcp, null);
  const [cancelled, cancel, cancelling] = useActionState<ConsentState, FormData>(cancelMcp, null);
  const answer = approving || cancelling ? null : (approved ?? cancelled);
  const redirectTo = answer && 'redirectTo' in answer ? answer.redirectTo : null;
  const error = answer && 'error' in answer ? answer.error : full ? 'too_many' : null;
  const busy = approving || cancelling || redirectTo !== null;

  useEffect(() => {
    if (redirectTo) window.location.assign(redirectTo);
  }, [redirectTo]);

  return (
    <form className="grid gap-5">
      <input type="hidden" name="query" value={query} />
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-[550]">{t('scope.legend')}</legend>
        {(['read', 'read_write'] as const).map((value) => (
          <label key={value} className="flex items-start gap-2 text-sm max-shell:min-h-11">
            <input
              type="radio"
              name="scope"
              value={value}
              checked={chosen === value}
              onChange={() => setChosen(value)}
              className="mt-0.5 size-4 accent-[var(--accent-strong)]"
            />
            <span>
              <span className="block font-[550]">
                {value === 'read' ? t('scope.read') : t('scope.readWrite')}
              </span>
              <span className="block text-xs text-muted-foreground">
                {value === 'read' ? t('scope.readHelp') : t('scope.readWriteHelp')}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      {redirectTo && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('returning')}
        </p>
      )}
      {error && (
        <p role="alert" className="flex gap-2 text-sm text-destructive">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" strokeWidth={1.5} />
          <span>{t(`error.${error}`, { max })}</span>
        </p>
      )}
      <div className="flex flex-wrap gap-2 max-shell:flex-col">
        <Button
          type="submit"
          variant="primary"
          formAction={approve}
          disabled={busy || full}
          aria-busy={approving}
          className="min-w-32 max-shell:w-full"
        >
          {approving ? t('approving') : t('approve')}
        </Button>
        <Button
          type="submit"
          formAction={cancel}
          disabled={busy}
          aria-busy={cancelling}
          className="max-shell:w-full"
        >
          {t('cancel')}
        </Button>
      </div>
    </form>
  );
}
