import type { UploadSession, UploadSessions } from '../uploads';

/**
 * Upload sessions in Durable Objects, one object per recording id, created
 * in the EU jurisdiction so session state stays in the EU. The class that
 * implements UploadSession over RPC is in apps/web/workers/upload-session.ts.
 *
 * Local workerd (`wrangler dev`) throws "Jurisdiction restrictions are not
 * implemented in workerd"; only that error falls back to the plain
 * namespace, so a deployed install never runs outside the EU jurisdiction.
 */
export function durableObjectUploadSessions(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  namespace: DurableObjectNamespace<any>,
): UploadSessions {
  let scoped: DurableObjectNamespace | undefined;
  const eu = () => {
    if (!scoped) {
      try {
        scoped = namespace.jurisdiction('eu') as DurableObjectNamespace;
      } catch (error) {
        if (!String(error).includes('not implemented in workerd')) throw error;
        scoped = namespace as DurableObjectNamespace;
      }
    }
    return scoped;
  };
  return {
    get(recordingId) {
      const ns = eu();
      const stub: unknown = ns.get(ns.idFromName(recordingId));
      return stub as UploadSession;
    },
  };
}
