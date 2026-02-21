// Load environment variables first, before any other imports
import dotenv from 'dotenv';
import path from 'path';

// Load .env file with explicit path resolution
const envPath = path.resolve(process.cwd(), '.env');
const result = dotenv.config({ path: envPath });

if (result.error) {
  // eslint-disable-next-line no-console
  console.log('No .env file found at', envPath, 'using environment variables only');
} else {
  // eslint-disable-next-line no-console
  console.log('Loaded environment variables from', envPath);
}
