import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { RuntimeConfigService } from '../admin/runtimeConfigService';
import logger from '../utils/logger';
import { config } from '../utils/config';
import { debugConfig } from '../utils/configDebug';
import { runtimeConfigService } from '../utils/runtimeConfig';

jest.mock('../services/eventProcessor', () => ({
  EventProcessor: jest.fn().mockImplementation(() => ({
    processEvent: jest.fn().mockResolvedValue(undefined),
  })),
}));

import { WebhookServer } from '../server/webhookServer';

async function runtimeService(): Promise<RuntimeConfigService> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'server-runtime-'));
  const service = new RuntimeConfigService({
    dataDir: dir,
    env: {
      GITLAB_TOKEN: 'glpat-secret',
      WEBHOOK_SECRET: 'webhook-secret',
      ANTHROPIC_AUTH_TOKEN: 'anthropic-secret',
    } as NodeJS.ProcessEnv,
  });
  await service.initialize();
  return service;
}

describe('WebhookServer admin integration', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('starts on the persisted runtime webhook port after restart', async () => {
    const runtimeConfig = await runtimeService();
    await runtimeConfig.updateConfig({ webhook: { port: 3999 } }, 'test');

    const server = new WebhookServer({
      runtimeConfigService: runtimeConfig,
      env: { ADMIN_TOKEN: 'admin-secret' },
    });
    const app = server.getApp() as express.Application & {
      listen: (port: number, callback?: () => void) => unknown;
    };
    const listenSpy = jest
      .spyOn(app, 'listen')
      .mockImplementation((_port: number, callback?: () => void) => {
        callback?.();
        return {} as unknown;
      });

    server.start();

    expect(listenSpy).toHaveBeenCalledWith(3999, expect.any(Function));
  });

  it('keeps /health public and protects /api/admin/status', async () => {
    const server = new WebhookServer({
      runtimeConfigService: await runtimeService(),
      env: { ADMIN_TOKEN: 'admin-secret' },
    });

    await request(server.getApp()).get('/health').expect(200);
    await request(server.getApp()).get('/api/admin/status').expect(401);
    await request(server.getApp())
      .get('/api/admin/status')
      .set('X-Admin-Key', 'admin-secret')
      .expect(200);
  });

  it('serves admin static files and falls back to index.html for admin SPA routes', async () => {
    const adminDir = await fs.mkdtemp(path.join(os.tmpdir(), 'admin-static-'));
    await fs.writeFile(path.join(adminDir, 'index.html'), '<html><body>admin-app</body></html>');
    await fs.writeFile(path.join(adminDir, 'app.js'), 'console.log("admin-js");');

    const server = new WebhookServer({
      runtimeConfigService: await runtimeService(),
      env: { ADMIN_TOKEN: 'admin-secret' },
      adminStaticPath: adminDir,
    });

    await request(server.getApp())
      .get('/admin')
      .expect(200)
      .expect(/admin-app/);
    await request(server.getApp())
      .get('/admin/app.js')
      .expect(200)
      .expect('console.log("admin-js");');
    await request(server.getApp())
      .get('/admin/settings')
      .expect(200)
      .expect(/admin-app/);
  });

  it('keeps the webhook endpoint mounted and rejects unauthenticated requests', async () => {
    const server = new WebhookServer({
      runtimeConfigService: await runtimeService(),
      env: { ADMIN_TOKEN: 'admin-secret' },
    });

    await request(server.getApp())
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .send({ object_kind: 'merge_request' })
      .expect(401, { error: 'Invalid signature' });
  });

  it('uses env-backed config debug values before runtime config initialization', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const isLoadedSpy = jest.spyOn(runtimeConfigService, 'isLoaded').mockReturnValue(false);
    const getConfigSpy = jest.spyOn(runtimeConfigService, 'getConfig').mockImplementation(() => {
      throw new Error('getConfig should not be called before initialization');
    });

    expect(() => debugConfig()).not.toThrow();

    expect(isLoadedSpy).toHaveBeenCalled();
    expect(getConfigSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(`Port: ${config.webhook.port}`);
    expect(logSpy).toHaveBeenCalledWith(
      `GitLab Token: ${config.gitlab.token ? '********' : 'NOT SET'}`
    );
  });

  it('uses runtime config debug values after runtime config initialization', async () => {
    const runtimeConfig = await runtimeService();
    await runtimeConfig.updateConfig(
      {
        webhook: { port: 4555 },
        gitlab: { token: 'glpat-updated' },
      },
      'test'
    );

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(runtimeConfigService, 'isLoaded').mockReturnValue(true);
    const getConfigSpy = jest
      .spyOn(runtimeConfigService, 'getConfig')
      .mockReturnValue(runtimeConfig.getConfig());

    debugConfig();

    expect(getConfigSpy).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('Port: 4555');
    expect(logSpy).toHaveBeenCalledWith('GitLab Token: ********');
  });

  it('fails fast with a clear error when start is called before runtime config initialization', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'server-runtime-unloaded-'));
    const unloadedRuntimeConfig = new RuntimeConfigService({
      dataDir: dir,
      env: {
        GITLAB_TOKEN: 'glpat-secret',
        WEBHOOK_SECRET: 'webhook-secret',
        ANTHROPIC_AUTH_TOKEN: 'anthropic-secret',
      } as NodeJS.ProcessEnv,
    });
    const server = new WebhookServer({
      runtimeConfigService: unloadedRuntimeConfig,
      env: { ADMIN_TOKEN: 'admin-secret' },
    });
    const app = server.getApp() as express.Application & {
      listen: (port: number, callback?: () => void) => unknown;
    };
    const listenSpy = jest.spyOn(app, 'listen');
    const getConfigSpy = jest.spyOn(unloadedRuntimeConfig, 'getConfig');
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => logger);
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    server.start();

    expect(getConfigSpy).not.toHaveBeenCalled();
    expect(listenSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to start server:',
      expect.objectContaining({
        message: 'Runtime config service must be initialized before starting the server',
      })
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
