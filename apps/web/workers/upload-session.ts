import { DurableObject } from 'cloudflare:workers';

/**
 * One resumable upload session per recording (docs/spec.md "How a recording
 * reaches the library"). Tracks which 8 MB chunks arrived. Created with
 * `env.UPLOAD_SESSIONS.jurisdiction('eu')` so session state stays in the EU.
 *
 * Packet 1 declares the class so the binding exists; the upload packet fills it in.
 */
export class UploadSession extends DurableObject<CloudflareEnv> {
  override async fetch(): Promise<Response> {
    return Response.json(
      { error: { code: 'not_implemented', message: 'Upload sessions arrive in a later packet.' } },
      { status: 501 },
    );
  }
}
