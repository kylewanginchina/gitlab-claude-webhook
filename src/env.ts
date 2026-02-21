// Load environment variables first, before any other imports
import dotenv from 'dotenv';
import path from 'path';

// Load .env file with explicit path resolution
const envPath = path.resolve(process.cwd(), '.env');

// Support searching in parent directory as a fallback
const searchPaths = [envPath, path.resolve(process.cwd(), '..', '.env')];
let loaded = false;

for (const p of searchPaths) {
  const result = dotenv.config({ path: p });
  if (!result.error) {
    // eslint-disable-next-line no-console
    console.log(`[env] Successfully loaded environment variables from ${p}`);
    loaded = true;
    break;
  }
}

if (!loaded) {
  // eslint-disable-next-line no-console
  console.log(`[env] No .env file found in search paths, using environment variables only.`);
}
