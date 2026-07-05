import express from 'express';
import { createAdminAuthMiddleware } from './adminAuth';
import { RuntimeConfigService } from './runtimeConfigService';

export interface CreateAdminRouterOptions {
  runtimeConfigService: RuntimeConfigService;
  env?: NodeJS.ProcessEnv;
}

export function createAdminRouter(options: CreateAdminRouterOptions): express.Router {
  const router = express.Router();
  const { runtimeConfigService } = options;

  router.use(createAdminAuthMiddleware(options.env || process.env));

  router.get('/status', (_req, res) => {
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      version: '1.0.0',
      configLoaded: runtimeConfigService.isLoaded(),
      timestamp: new Date().toISOString(),
    });
  });

  router.get('/config', (_req, res) => {
    res.json(runtimeConfigService.getPublicConfig());
  });

  router.put('/config', async (req, res, next) => {
    try {
      const result = await runtimeConfigService.updateConfig(req.body, 'admin');
      res.json({
        config: runtimeConfigService.getPublicConfig(),
        requiresRestart: result.requiresRestart,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/config/reload', async (_req, res, next) => {
    try {
      await runtimeConfigService.reload();
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.post('/test/gitlab', (_req, res) => {
    const config = runtimeConfigService.getConfig();
    res.json({
      provider: 'gitlab',
      ok: Boolean(config.gitlab.baseUrl && config.gitlab.token),
      message: config.gitlab.token ? 'GitLab token is configured' : 'GitLab token is missing',
    });
  });

  router.post('/test/claude', (_req, res) => {
    const config = runtimeConfigService.getConfig();
    res.json({
      provider: 'claude',
      ok: Boolean(config.claude.baseUrl && config.claude.authToken),
      message: config.claude.authToken ? 'Claude token is configured' : 'Claude token is missing',
    });
  });

  router.post('/test/codex', (_req, res) => {
    const config = runtimeConfigService.getConfig();
    res.json({
      provider: 'codex',
      ok: Boolean(config.codex.baseUrl && config.codex.apiKey),
      message: config.codex.apiKey ? 'Codex API key is configured' : 'Codex API key is missing',
    });
  });

  router.use(
    (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: message });
    }
  );

  return router;
}
