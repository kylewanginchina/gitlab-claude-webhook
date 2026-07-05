import express from 'express';
import { createAdminAuthMiddleware } from './adminAuth';
import { RuntimeConfigService } from './runtimeConfigService';

export interface CreateAdminRouterOptions {
  runtimeConfigService: RuntimeConfigService;
  env?: NodeJS.ProcessEnv;
}

function providerTestResult(
  provider: 'gitlab' | 'claude' | 'codex',
  configured: boolean,
  baseUrl: string
) {
  return {
    provider,
    ok: Boolean(baseUrl && configured),
    message: configured
      ? `${provider === 'gitlab' ? 'GitLab' : provider === 'claude' ? 'Claude' : 'Codex'} ${
          provider === 'gitlab' ? 'token' : provider === 'claude' ? 'token' : 'API key'
        } is configured`
      : `${provider === 'gitlab' ? 'GitLab' : provider === 'claude' ? 'Claude' : 'Codex'} ${
          provider === 'gitlab' ? 'token' : provider === 'claude' ? 'token' : 'API key'
        } is missing`,
  };
}

function isRuntimeConfigValidationError(message: string): boolean {
  if (/^[A-Z0-9_]+(?:\s+or\s+[A-Z0-9_]+)* is required$/.test(message)) {
    return true;
  }

  if (message === 'runtime config patch must be an object') {
    return true;
  }

  if (/^[a-z][a-zA-Z0-9]* section must be an object$/.test(message)) {
    return true;
  }

  return /^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)? (?:must|is required)\b/.test(message);
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
    const config = runtimeConfigService.getPublicConfig();
    res.json(providerTestResult('gitlab', config.gitlab.token.configured, config.gitlab.baseUrl));
  });

  router.post('/test/claude', (_req, res) => {
    const config = runtimeConfigService.getPublicConfig();
    res.json(providerTestResult('claude', config.claude.authToken.configured, config.claude.baseUrl));
  });

  router.post('/test/codex', (_req, res) => {
    const config = runtimeConfigService.getPublicConfig();
    res.json(providerTestResult('codex', config.codex.apiKey.configured, config.codex.baseUrl));
  });

  router.use(
    (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const message = error instanceof Error ? error.message : String(error);
      res.status(isRuntimeConfigValidationError(message) ? 400 : 500).json({ error: message });
    }
  );

  return router;
}
