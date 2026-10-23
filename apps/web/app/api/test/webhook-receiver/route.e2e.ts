// Exists only in an MTXT_E2E_BUILD=1 build. See lib/webhooks/fake-receiver.ts.
import { fakeReceiverRoute } from '@/lib/webhooks/fake-receiver';

export const GET = fakeReceiverRoute;
export const POST = fakeReceiverRoute;
export const PUT = fakeReceiverRoute;
