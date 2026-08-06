import api from './api/routes';
import { handleEmail } from './email-handler';
import type { EmailHandlerEnv } from './email-handler';
import type { ApiEnv } from './api/routes';

/**
 * Tempik - Disposable Temp Mail on Cloudflare Workers
 *
 * Handles:
 * - fetch()  → API routes (static files served via Cloudflare Assets)
 * - email()  → inbound email processing via Cloudflare Email Worker
 */

// Combined env bindings
export interface Env extends ApiEnv, EmailHandlerEnv {
  ASSETS: Fetcher;
}

export default {
  /**
   * HTTP fetch handler - serves API routes.
   * Static files (src/web/) are served via Cloudflare [assets].
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);

      // Route API calls to Hono router
      if (url.pathname.startsWith('/api/')) {
        const apiUrl = new URL(request.url);
        apiUrl.pathname = url.pathname.replace(/^\/api/, '');
        const apiRequest = new Request(apiUrl, request);
        return api.fetch(apiRequest, env, ctx);
      }

      // Serve static assets
      return env.ASSETS.fetch(request);
    } catch (e) {
      return new Response('Not Found', { status: 404 });
    }
  },

  /**
   * Email handler - called by Cloudflare for every inbound email
   * at any @<MAIL_DOMAIN> address.
   */
  async email(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext): Promise<void> {
    await handleEmail(message, env);
  },
};
