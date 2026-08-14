import fs from 'fs/promises';
import os from 'os';
import logger, { setLogLevel } from '../utils/logger';
import path from 'path';

function fileTransportPaths(loggerInstance: typeof logger): string[] {
  return loggerInstance.transports
    .map(transport => {
      const fileTransport = transport as { dirname?: string; filename?: string };
      return fileTransport.dirname && fileTransport.filename
        ? path.join(fileTransport.dirname, fileTransport.filename)
        : undefined;
    })
    .filter((value): value is string => Boolean(value));
}

async function closeLoggerTransports(loggerInstance: typeof logger): Promise<void> {
  loggerInstance.close();
  await Promise.all(
    loggerInstance.transports.map(
      transport =>
        new Promise<void>(resolve => {
          const closableTransport = transport as typeof transport & {
            close?: (callback?: () => void) => void;
          };
          if (closableTransport.close) {
            closableTransport.close(resolve);
          } else {
            transport.destroy();
            resolve();
          }
        })
    )
  );
}

describe('logger runtime configuration', () => {
  it('updates the active Winston level', () => {
    const original = logger.level;
    setLogLevel('debug');
    expect(logger.level).toBe('debug');
    setLogLevel(original);
  });

  it('writes file transports below the configured logs directory', () => {
    const filenames = fileTransportPaths(logger);

    expect(filenames).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/logs\/error\.log$/),
        expect.stringMatching(/logs\/combined\.log$/),
      ])
    );
  });

  it('creates and uses the LOG_DIR override in an isolated module load', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'logger-'));
    const logDir = path.join(tempRoot, 'configured-logs');
    const originalLogDir = process.env.LOG_DIR;
    let isolatedLogger: typeof logger | undefined;

    try {
      await expect(fs.access(logDir)).rejects.toThrow();
      process.env.LOG_DIR = logDir;
      jest.isolateModules(() => {
        // Jest's synchronous module isolation requires a synchronous load here.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        isolatedLogger = require('../utils/logger').default as typeof logger;
      });

      expect((await fs.stat(logDir)).isDirectory()).toBe(true);
      expect(fileTransportPaths(isolatedLogger!)).toEqual(
        expect.arrayContaining([
          path.join(logDir, 'error.log'),
          path.join(logDir, 'combined.log'),
        ])
      );
    } finally {
      if (isolatedLogger) {
        await closeLoggerTransports(isolatedLogger);
      }
      if (originalLogDir === undefined) {
        delete process.env.LOG_DIR;
      } else {
        process.env.LOG_DIR = originalLogDir;
      }
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
