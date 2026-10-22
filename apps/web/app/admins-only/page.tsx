import { Forbidden } from '@/components/forbidden';

// The middleware rewrites /settings here, with status 403, for a signed-in user who is not an admin.
export default Forbidden;
