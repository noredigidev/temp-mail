import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { D1Database } from '@cloudflare/workers-types';
import { swaggerUI } from '@hono/swagger-ui';
import {
  getInbox,
  createInbox,
  inboxExists,
  getSessionInboxes,
  getMessages,
  ensureSession,
  linkInboxToSession,
  unlinkInboxFromSession,
  isInboxInSession,
  getDomains,
  addDomain,
  deleteDomain,
} from '../db/queries';
import { generateUniqueAddress } from '../utils/random-address';

export interface ApiEnv {
  DB: D1Database;
  APP_NAME: string;
  MAIL_DOMAIN: string;
  WEB_HOST: string;
}

const api = new OpenAPIHono<{ Bindings: ApiEnv }>();

// Reusable Headers/Parameters
const SessionIdHeader = z.object({
  'x-session-id': z.string().openapi({
    description: 'The unique session identifier (UUID v4)',
    example: 'ddeeeef3-e415-4c6c-b5b3-0652b88fa8d5',
  }),
});

// Reusable Schemas
const ErrorSchema = z.object({
  error: z.string().openapi({ description: 'Error message' }),
});

const SessionSchema = z.object({
  sessionId: z.string().uuid().openapi({ description: 'Session identifier (UUID v4)' }),
});

const InboxSchema = z.object({
  address: z.string().email().openapi({ description: 'Full email address' }),
  created_at: z.string().openapi({ description: 'Creation timestamp' }),
  expires_at: z.string().nullable().openapi({ description: 'Expiration timestamp or null if never expires' }),
});

const MessageSchema = z.object({
  id: z.string().openapi({ description: 'Message ID' }),
  inbox_address: z.string().email().openapi({ description: 'Destination email address' }),
  from_address: z.string().openapi({ description: 'Sender email address' }),
  from_name: z.string().nullable().openapi({ description: 'Sender name or null' }),
  to_address: z.string().email().openapi({ description: 'Recipient email address' }),
  subject: z.string().nullable().openapi({ description: 'Email subject or null' }),
  body_text: z.string().nullable().openapi({ description: 'Plain text body or null' }),
  body_html: z.string().nullable().openapi({ description: 'HTML body or null' }),
  received_at: z.string().openapi({ description: 'Receipt timestamp' }),
});

function getEnvDomains(env: ApiEnv): string[] {
  return env.MAIL_DOMAIN.split(',').map(d => d.trim().toLowerCase()).filter(Boolean);
}

async function getAllDomains(env: ApiEnv): Promise<string[]> {
  const envDomains = getEnvDomains(env);
  const dbDomains = (await getDomains(env.DB)).map(d => d.domain.toLowerCase());
  return [...new Set([...envDomains, ...dbDomains])];
}

function defaultDomain(domains: string[]): string {
  return domains[0] || 'example.com';
}

function sessionId(c: any): string | null {
  return (c.req.header('x-session-id') || '').trim() || null;
}

// ==================== ROUTES ====================

const configRoute = createRoute({
  method: 'get',
  path: '/config',
  tags: ['Configuration'],
  responses: {
    200: {
      description: 'Get application configuration',
      content: {
        'application/json': {
          schema: z.object({
            appName: z.string().openapi({ description: 'Application name' }),
            mailDomain: z.string().openapi({ description: 'Default mail domain (first in list)' }),
            mailDomains: z.array(z.string()).openapi({ description: 'All configured mail domains' }),
            webHost: z.string().openapi({ description: 'Web frontend hostname' }),
          }),
        },
      },
    },
  },
});

const sessionRoute = createRoute({
  method: 'get',
  path: '/session',
  tags: ['Session'],
  responses: {
    200: {
      description: 'Get or create a session',
      content: {
        'application/json': { schema: SessionSchema },
      },
    },
  },
});

const getInboxesRoute = createRoute({
  method: 'get',
  path: '/inboxes',
  tags: ['Inboxes'],
  request: {
    headers: SessionIdHeader,
  },
  responses: {
    200: {
      description: 'Get all inboxes in the session',
      content: {
        'application/json': { schema: z.array(InboxSchema) },
      },
    },
    400: {
      description: 'Missing session ID header',
      content: {
        'application/json': { schema: ErrorSchema },
      },
    },
  },
});

const createInboxRoute = createRoute({
  method: 'post',
  path: '/inboxes',
  tags: ['Inboxes'],
  request: {
    headers: SessionIdHeader,
    body: {
      content: {
        'application/json': {
          schema: z.object({
            domain: z.string().optional().openapi({ description: 'Domain override (must be in mailDomains)' }),
            localPart: z.string().optional().openapi({ description: 'Custom local part (username)' }),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Inbox successfully created',
      content: {
        'application/json': { schema: InboxSchema },
      },
    },
    400: {
      description: 'Missing session ID header or invalid domain',
      content: {
        'application/json': { schema: ErrorSchema },
      },
    },
  },
});

const deleteInboxRoute = createRoute({
  method: 'delete',
  path: '/inboxes/{address}',
  tags: ['Inboxes'],
  request: {
    headers: SessionIdHeader,
    params: z.object({
      address: z.string().openapi({
        description: 'Email address to unlink (URI encoded)',
        example: 'test%40example.com',
      }),
    }),
  },
  responses: {
    200: {
      description: 'Inbox successfully unlinked from session',
      content: {
        'application/json': { schema: z.object({ ok: z.boolean().openapi({ description: 'Operation success status' }) }) },
      },
    },
    400: {
      description: 'Missing session ID header',
      content: {
        'application/json': { schema: ErrorSchema },
      },
    },
  },
});

const getMessagesRoute = createRoute({
  method: 'get',
  path: '/inboxes/{address}/messages',
  tags: ['Messages'],
  request: {
    headers: SessionIdHeader,
    params: z.object({
      address: z.string().openapi({
        description: 'Email address to fetch messages from (URI encoded)',
        example: 'test%40example.com',
      }),
    }),
  },
  responses: {
    200: {
      description: 'List of messages for the inbox',
      content: {
        'application/json': { schema: z.array(MessageSchema) },
      },
    },
    400: {
      description: 'Missing session ID header',
      content: {
        'application/json': { schema: ErrorSchema },
      },
    },
    403: {
      description: 'Inbox not linked to this session',
      content: {
        'application/json': { schema: ErrorSchema },
      },
    },
  },
});

const getDomainsRoute = createRoute({
  method: 'get',
  path: '/domains',
  tags: ['Domains'],
  responses: {
    200: {
      description: 'List all available domains',
      content: {
        'application/json': {
          schema: z.array(z.string().openapi({ description: 'Domain name' })),
        },
      },
    },
  },
});

const addDomainRoute = createRoute({
  method: 'post',
  path: '/domains',
  tags: ['Domains'],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            domain: z.string().openapi({ description: 'Domain to add (e.g. example.com)' }),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Domain added successfully',
      content: {
        'application/json': { schema: z.object({ ok: z.boolean().openapi({ description: 'Success' }) }) },
      },
    },
    400: {
      description: 'Invalid domain or already exists',
      content: {
        'application/json': { schema: ErrorSchema },
      },
    },
  },
});

const deleteDomainRoute = createRoute({
  method: 'delete',
  path: '/domains/{domain}',
  tags: ['Domains'],
  request: {
    params: z.object({
      domain: z.string().openapi({ description: 'Domain to remove' }),
    }),
  },
  responses: {
    200: {
      description: 'Domain removed successfully',
      content: {
        'application/json': { schema: z.object({ ok: z.boolean().openapi({ description: 'Success' }) }) },
      },
    },
    400: {
      description: 'Domain not found',
      content: {
        'application/json': { schema: ErrorSchema },
      },
    },
  },
});

// ==================== HANDLERS ====================

api.openapi(configRoute, async (c) => {
  const domains = await getAllDomains(c.env);
  return c.json({
    appName: c.env.APP_NAME || 'Tempik',
    mailDomain: domains[0] || 'example.com',
    mailDomains: domains,
    webHost: c.env.WEB_HOST || 'tempik.example.com',
  });
});

api.openapi(sessionRoute, async (c) => {
  let sid = sessionId(c);
  if (!sid) {
    sid = crypto.randomUUID();
  }
  await ensureSession(c.env.DB, sid);
  return c.json({ sessionId: sid });
});

api.openapi(getInboxesRoute, async (c) => {
  const sid = sessionId(c);
  if (!sid) return c.json({ error: 'Missing x-session-id' }, 400);
  const inboxes = await getSessionInboxes(c.env.DB, sid);
  return c.json(inboxes as any);
});

api.openapi(createInboxRoute, async (c) => {
  const sid = sessionId(c);
  if (!sid) return c.json({ error: 'Missing x-session-id' }, 400);

  const body = await c.req.json().catch(() => ({}));
  const domains = await getAllDomains(c.env);
  const requestedDomain: string = (body.domain || '').trim().toLowerCase();
  const domain = requestedDomain && domains.includes(requestedDomain) ? requestedDomain : defaultDomain(domains);

  if (requestedDomain && !domains.includes(requestedDomain)) {
    return c.json({ error: `Invalid domain: ${requestedDomain}. Allowed: ${domains.join(', ')}` }, 400);
  }

  const requested: string = (body.localPart || '').trim().toLowerCase();

  let address: string;
  if (requested) {
    address = `${requested}@${domain}`;
  } else {
    address = await generateUniqueAddress(
      (addr) => inboxExists(c.env.DB, addr),
      domain
    );
  }

  await createInbox(c.env.DB, address);
  await linkInboxToSession(c.env.DB, sid, address);

  const inbox = await getInbox(c.env.DB, address);
  return c.json(inbox as any, 201);
});

api.openapi(deleteInboxRoute, async (c) => {
  const sid = sessionId(c);
  if (!sid) return c.json({ error: 'Missing x-session-id' }, 400);

  const address = decodeURIComponent(c.req.param('address'));
  await unlinkInboxFromSession(c.env.DB, sid, address);
  return c.json({ ok: true } as any);
});

api.openapi(getMessagesRoute, async (c) => {
  const sid = sessionId(c);
  if (!sid) return c.json({ error: 'Missing x-session-id' }, 400);

  const address = decodeURIComponent(c.req.param('address'));

  if (!(await isInboxInSession(c.env.DB, sid, address))) {
    return c.json({ error: 'Inbox not in this session' }, 403);
  }

  const messages = await getMessages(c.env.DB, address);
  return c.json(messages as any);
});

api.openapi(getDomainsRoute, async (c) => {
  const domains = await getAllDomains(c.env);
  return c.json(domains);
});

api.openapi(addDomainRoute, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const domain = (body.domain || '').trim().toLowerCase();
  if (!domain) return c.json({ error: 'Domain is required' }, 400);

  const domains = await getAllDomains(c.env);
  if (domains.includes(domain)) {
    return c.json({ error: `Domain ${domain} already exists` }, 400);
  }

  await addDomain(c.env.DB, domain);
  return c.json({ ok: true }, 201);
});

api.openapi(deleteDomainRoute, async (c) => {
  const domain = c.req.param('domain');
  if (!domain) return c.json({ error: 'Domain is required' }, 400);

  const domains = await getAllDomains(c.env);
  if (!domains.includes(domain)) {
    return c.json({ error: `Domain ${domain} not found` }, 400);
  }

  await deleteDomain(c.env.DB, domain);
  return c.json({ ok: true });
});

// ==================== SWAGGER CONFIG ====================

// Fix: point to correct path
api.get('/ui', swaggerUI({ url: '/api/doc' }));

api.doc('/doc', (c) => {
  const host = c.env.WEB_HOST || 'tempmail.noredigital.web.id';
  return {
    openapi: '3.0.0',
    info: {
      title: 'Tempik API',
      version: '1.0.0',
      description: 'Disposable temporary email service (Temp Mail) for Cloudflare Workers',
      contact: {
        name: 'Tempik Team',
        email: 'support@tempik.app',
      },
      license: {
        name: 'MIT',
      },
    },
    servers: [
      {
        url: '/api',
        description: 'Current server',
      },
      {
        url: `https://${host}/api`,
        description: 'Production server',
      },
    ],
    tags: [
      { name: 'Session', description: 'Session management and authentication' },
      { name: 'Inboxes', description: 'Inbox creation, listing, and management' },
      { name: 'Messages', description: 'Email message retrieval' },
      { name: 'Domains', description: 'Domain management (list, add, delete)' },
      { name: 'Configuration', description: 'Application configuration' },
    ],
    components: {
      securitySchemes: {
        session: {
          type: 'apiKey',
          in: 'header',
          name: 'x-session-id',
          description: 'Session identifier (UUID v4) obtained from /api/session',
        },
      },
    },
  } as any;
});

export default api;