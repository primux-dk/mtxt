import { defineCloudflareConfig } from '@opennextjs/cloudflare';

// No incremental cache yet: every page reads per-request data.
export default defineCloudflareConfig({});
