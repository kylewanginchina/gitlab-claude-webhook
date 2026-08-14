import fs from 'fs';
import path from 'path';
import winston from 'winston';
import { config } from './config';

const logDir = process.env.LOG_DIR || path.resolve(process.cwd(), 'logs');
fs.mkdirSync(logDir, { recursive: true });

const logger = winston.createLogger({
  level: config.logLevel,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'gitlab-claude-webhook' },
  transports: [
    new winston.transports.File({
      filename: path.join(logDir, 'error.log'),
      level: 'error',
    }),
    new winston.transports.File({ filename: path.join(logDir, 'combined.log') }),
    new winston.transports.Console({
      format: winston.format.combine(winston.format.colorize(), winston.format.simple()),
    }),
  ],
});

export function setLogLevel(level: string): void {
  logger.level = level;
}

export default logger;
