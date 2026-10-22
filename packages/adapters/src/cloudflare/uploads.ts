import type { UploadSession, UploadSessions } from '../uploads';

/**
 * Upload sessions in Durable Objects, one object per recording id, created
 * in the EU jurisdiction so session state stays in the EU. The class that
 * implements UploadSession over RPC is in apps/web/workers/upload-session.ts.
 */
export function durableObjectUploadSessions(namespace: DurableObjectNamespace): UploadSessions {
  const eu = namespace.jurisdiction('eu');
  return {
    get(recordingId) {
      return eu.get(eu.idFromName(recordingId)) as unknown as UploadSession;
    },
  };
}
