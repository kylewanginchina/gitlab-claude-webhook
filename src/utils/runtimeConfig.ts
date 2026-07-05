import { RuntimeConfigService } from '../admin/runtimeConfigService';

export const runtimeConfigService = new RuntimeConfigService();

export function getRuntimeConfigService(): RuntimeConfigService {
  return runtimeConfigService;
}
