'use client';

import { TriangleAlert } from 'lucide-react';
import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { approveConnection, cancelConnection, type ConnectFormState } from '@/app/connect/actions';
import { Button } from '@/components/ui/button';

/**
 * Approve (the one primary) and Cancel. Both are server actions on one form,
 * so the page works without JavaScript and is CSRF-safe. An error stays at
 * the buttons and says what to do next (behaviour.md rule 9).
 */
export function ConnectForm({ challenge, deviceName }: { challenge: string; deviceName: string }) {
  const t = useTranslations('connect');
  const [approved, approve, approving] = useActionState<ConnectFormState, FormData>(
    approveConnection,
    null,
  );
  const [cancelled, cancel, cancelling] = useActionState<ConnectFormState, FormData>(
    cancelConnection,
    null,
  );
  const error = (approving || cancelling ? null : (approved ?? cancelled))?.error;
  const busy = approving || cancelling;

  return (
    <form className="grid gap-4">
      <input type="hidden" name="challenge" value={challenge} />
      <input type="hidden" name="name" value={deviceName} />
      {error && (
        <p role="alert" className="flex gap-2 text-sm text-destructive">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" strokeWidth={1.5} />
          <span>{t(`error.${error}`)}</span>
        </p>
      )}
      <div className="flex flex-wrap gap-2 max-shell:flex-col">
        <Button
          type="submit"
          variant="primary"
          formAction={approve}
          disabled={busy}
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
