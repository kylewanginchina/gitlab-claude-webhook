import crypto from 'crypto';
import { RequestHandler } from 'express';

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function createAdminAuthMiddleware(env: NodeJS.ProcessEnv = process.env): RequestHandler {
  return (req, res, next) => {
    const expected = env.ADMIN_TOKEN;

    if (!expected) {
      res.status(503).json({
        error: 'Admin API is disabled because ADMIN_TOKEN is not configured',
      });
      return;
    }

    const provided = req.header('X-Admin-Key') || '';
    if (!provided || !timingSafeStringEqual(provided, expected)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    next();
  };
}
