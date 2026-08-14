import { RuntimeConfigService } from '../admin/runtimeConfigService';
import { setLogLevel } from './logger';

export const runtimeConfigService = new RuntimeConfigService();
runtimeConfigService.subscribe(config => setLogLevel(config.logLevel));

export function getRuntimeConfigService(): RuntimeConfigService {
  return runtimeConfigService;
}
