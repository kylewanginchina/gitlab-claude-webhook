import express from 'express';
import request from 'supertest';
import { createAdminAuthMiddleware } from '../admin/adminAuth';

function appWithAuth(env: NodeJS.ProcessEnv) {
  const app = express();
  app.use(createAdminAuthMiddleware(env));
  app.get('/private', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('admin auth middleware', () => {
  it('fails closed when ADMIN_TOKEN is missing', async () => {
    const app = appWithAuth({});

    await request(app).get('/private').expect(503, {
      error: 'Admin API is disabled because ADMIN_TOKEN is not configured',
    });
  });

  it('rejects missing admin key', async () => {
    const app = appWithAuth({ ADMIN_TOKEN: 'secret-key' });

    await request(app).get('/private').expect(401, { error: 'Unauthorized' });
  });

  it('rejects invalid admin key', async () => {
    const app = appWithAuth({ ADMIN_TOKEN: 'secret-key' });

    await request(app).get('/private').set('X-Admin-Key', 'wrong').expect(401, {
      error: 'Unauthorized',
    });
  });

  it('allows valid admin key', async () => {
    const app = appWithAuth({ ADMIN_TOKEN: 'secret-key' });

    await request(app).get('/private').set('X-Admin-Key', 'secret-key').expect(200, {
      ok: true,
    });
  });
});
