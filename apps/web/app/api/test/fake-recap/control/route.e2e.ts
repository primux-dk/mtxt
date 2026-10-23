// Exists only in an MTXT_E2E_BUILD=1 build. See lib/recap/fake-llm.ts.
import { fakeRecapControl } from '@/lib/recap/fake-llm';

export const GET = fakeRecapControl;
export const POST = fakeRecapControl;
