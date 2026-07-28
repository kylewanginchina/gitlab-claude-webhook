import logger, { setLogLevel } from '../utils/logger';
import path from 'path';

describe('logger runtime configuration', () => {
  it('updates the active Winston level', () => {
    const original = logger.level;
    setLogLevel('debug');
    expect(logger.level).toBe('debug');
    setLogLevel(original);
  });

  it('writes file transports below the configured logs directory', () => {
    const filenames = logger.transports
      .map(transport => {
        const fileTransport = transport as { dirname?: string; filename?: string };
        return fileTransport.dirname && fileTransport.filename
          ? path.join(fileTransport.dirname, fileTransport.filename)
          : undefined;
      })
      .filter((value): value is string => Boolean(value));

    expect(filenames).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/logs\/error\.log$/),
        expect.stringMatching(/logs\/combined\.log$/),
      ])
    );
  });
});
