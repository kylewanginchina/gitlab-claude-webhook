import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';

export class JsonStore<T> {
  constructor(private readonly filePath: string) {}

  public async read(defaultValue: T): Promise<T> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      return JSON.parse(raw) as T;
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') {
        return defaultValue;
      }

      if (error instanceof SyntaxError) {
        throw new Error(`Failed to parse JSON store ${this.filePath}: ${error.message}`);
      }

      throw error;
    }
  }

  public async write(value: T): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });

    const tempPath = `${this.filePath}.${randomUUID()}.tmp`;
    const serialized = `${JSON.stringify(value, null, 2)}\n`;

    await fs.writeFile(tempPath, serialized, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tempPath, this.filePath);
  }
}
