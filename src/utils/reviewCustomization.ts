import { ReviewCustomizationService } from '../admin/reviewCustomizationService';

export const reviewCustomizationService = new ReviewCustomizationService();

export function getReviewCustomizationService(): ReviewCustomizationService {
  return reviewCustomizationService;
}
