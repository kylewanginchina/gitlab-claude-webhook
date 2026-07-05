import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { JsonStore } from '../storage/jsonStore';

interface SampleRecord {
  name: string;
  count: number;
}

async function tempFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'json-store-'));
  return path.join(dir, 'record.json');
}

describe('JsonStore', () => {
  it('returns the default value when the file does not exist', async () => {
    const filePath = await tempFile();
    const store = new JsonStore<SampleRecord>(filePath);

    await expect(store.read({ name: 'default', count: 1 })).resolves.toEqual({
      name: 'default',
      count: 1,
    });
  });

  it('writes and reads JSON values', async () => {
    const filePath = await tempFile();
    const store = new JsonStore<SampleRecord>(filePath);

    await store.write({ name: 'saved', count: 2 });

    await expect(store.read({ name: 'default', count: 1 })).resolves.toEqual({
      name: 'saved',
      count: 2,
    });
  });

  it('throws a helpful error for invalid JSON', async () => {
    const filePath = await tempFile();
    await fs.writeFile(filePath, '{bad json', 'utf8');
    const store = new JsonStore<SampleRecord>(filePath);

    await expect(store.read({ name: 'default', count: 1 })).rejects.toThrow(
      `Failed to parse JSON store ${filePath}`
    );
  });
});
