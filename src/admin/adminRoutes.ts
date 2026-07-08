import express from 'express';
import { createAdminAuthMiddleware } from './adminAuth';
import { ReviewCustomizationService } from './reviewCustomizationService';
import { RuntimeConfigService } from './runtimeConfigService';
import type { RuntimeConfig } from './adminTypes';
import { reviewCustomizationService as defaultReviewCustomizationService } from '../utils/reviewCustomization';

export interface CreateAdminRouterOptions {
  runtimeConfigService: RuntimeConfigService;
  reviewCustomizationService?: ReviewCustomizationService;
  env?: NodeJS.ProcessEnv;
  onRuntimeConfigUpdated?: (config: RuntimeConfig) => void | Promise<void>;
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

function isReviewCustomizationValidationError(message: string): boolean {
  if (message.includes('already exists') || message === 'proposal is not open') {
    return true;
  }

  return /^(prompt|skill|feedback)\.[a-zA-Z0-9.]+ (?:must|is required|is invalid)\b/.test(
    message
  );
}

function isNotFoundError(message: string): boolean {
  return [
    'prompt not found',
    'prompt version not found',
    'skill not found',
    'proposal not found',
  ].includes(message);
}

function renderPromptPreview(prompt: ReturnType<ReviewCustomizationService['getPrompt']>): string {
  const lines = [`Review pass: ${prompt.label}`, ...prompt.draft.focus.map((line, index) => `${index + 1}. ${line}`)];
  if (prompt.draft.systemInstructions) {
    lines.push('', 'Admin system instructions:', prompt.draft.systemInstructions);
  }
  return lines.join('\n');
}

export function createAdminRouter(options: CreateAdminRouterOptions): express.Router {
  const router = express.Router();
  const { runtimeConfigService } = options;
  const reviewCustomizationService =
    options.reviewCustomizationService || defaultReviewCustomizationService;

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
      await options.onRuntimeConfigUpdated?.(runtimeConfigService.getConfig());
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
      await options.onRuntimeConfigUpdated?.(runtimeConfigService.getConfig());
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

  router.get('/prompts', (_req, res) => {
    res.json({ prompts: reviewCustomizationService.listPrompts() });
  });

  router.post('/prompts', async (req, res, next) => {
    try {
      res.json({ prompt: await reviewCustomizationService.createPrompt(req.body) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/prompts/render', (req, res, next) => {
    try {
      const promptId = typeof req.body?.promptId === 'string' ? req.body.promptId : '';
      const prompt = reviewCustomizationService.getPrompt(promptId);
      res.json({ rendered: renderPromptPreview(prompt), prompt });
    } catch (error) {
      next(error);
    }
  });

  router.get('/prompts/:id', (req, res, next) => {
    try {
      res.json({ prompt: reviewCustomizationService.getPrompt(req.params.id) });
    } catch (error) {
      next(error);
    }
  });

  router.put('/prompts/:id', async (req, res, next) => {
    try {
      res.json({ prompt: await reviewCustomizationService.updatePrompt(req.params.id, req.body) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/prompts/:id/publish', async (req, res, next) => {
    try {
      const changelog = typeof req.body?.changelog === 'string' ? req.body.changelog : undefined;
      res.json({
        prompt: await reviewCustomizationService.publishPrompt(req.params.id, changelog),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/prompts/:id/rollback', async (req, res, next) => {
    try {
      const version = req.body?.version;
      if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
        throw new Error('prompt.version must be at least 1');
      }
      const changelog = typeof req.body?.changelog === 'string' ? req.body.changelog : undefined;
      res.json({
        prompt: await reviewCustomizationService.rollbackPrompt(req.params.id, version, changelog),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/skills', (_req, res) => {
    res.json({ skills: reviewCustomizationService.listSkills() });
  });

  router.post('/skills', async (req, res, next) => {
    try {
      res.json({ skill: await reviewCustomizationService.createSkill(req.body) });
    } catch (error) {
      next(error);
    }
  });

  router.put('/skills/:id', async (req, res, next) => {
    try {
      res.json({ skill: await reviewCustomizationService.updateSkill(req.params.id, req.body) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/skills/:id/enable', async (req, res, next) => {
    try {
      res.json({ skill: await reviewCustomizationService.setSkillEnabled(req.params.id, true) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/skills/:id/disable', async (req, res, next) => {
    try {
      res.json({ skill: await reviewCustomizationService.setSkillEnabled(req.params.id, false) });
    } catch (error) {
      next(error);
    }
  });

  router.get('/feedback', (_req, res) => {
    res.json({ feedback: reviewCustomizationService.listFeedback() });
  });

  router.post('/feedback', async (req, res, next) => {
    try {
      res.json({ feedback: await reviewCustomizationService.createFeedback(req.body) });
    } catch (error) {
      next(error);
    }
  });

  router.get('/prompt-optimizer/proposals', (_req, res) => {
    res.json({ proposals: reviewCustomizationService.listProposals() });
  });

  router.post('/prompt-optimizer/analyze', async (_req, res, next) => {
    try {
      res.json({ proposals: await reviewCustomizationService.analyzeFeedback() });
    } catch (error) {
      next(error);
    }
  });

  router.post('/prompt-optimizer/proposals/:id/apply', async (req, res, next) => {
    try {
      res.json({ proposal: await reviewCustomizationService.applyProposal(req.params.id) });
    } catch (error) {
      next(error);
    }
  });

  router.use(
    (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      void _next;
      const message = error instanceof Error ? error.message : String(error);
      const status = isNotFoundError(message)
        ? 404
        : isRuntimeConfigValidationError(message) ||
            isReviewCustomizationValidationError(message)
          ? 400
          : 500;
      res.status(status).json({ error: message });
    }
  );

  return router;
}
