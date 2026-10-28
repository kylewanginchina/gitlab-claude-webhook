import logger from './logger';

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

/** Try the full document first: finding text can itself contain Markdown code fences. */
export function parseReviewJsonPayload(
  output: string,
  allowSurroundingProse = false
): JsonRecord | null {
  const text = output.trim();
  if (!text) {
    return null;
  }

  try {
    return asRecord(JSON.parse(text));
  } catch {
    const fence = allowSurroundingProse
      ? text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/)
      : text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fence) {
      try {
        return asRecord(JSON.parse(fence[1]));
      } catch {
        // Report the original document below.
      }
    }
  }

  logger.warn('Failed to parse review JSON payload', { outputPreview: output.slice(0, 300) });
  return null;
}

/** Validate core finding fields while allowing optional metadata from legacy JSON responses. */
export function isReviewFindingPayload(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) {
    return false;
  }

  if (
    !['title', 'body', 'path'].every(
      key => typeof record[key] === 'string' && (record[key] as string).trim().length > 0
    ) ||
    typeof record.confidence !== 'number' ||
    !Number.isInteger(record.confidence) ||
    record.confidence < 0 ||
    record.confidence > 100
  ) {
    return false;
  }

  if (
    record.line !== undefined &&
    record.line !== null &&
    (typeof record.line !== 'number' || !Number.isInteger(record.line) || record.line < 1)
  ) {
    return false;
  }

  return (
    (record.line_type === undefined || record.line_type === 'new' || record.line_type === 'old') &&
    ['category', 'verdict'].every(
      key => record[key] === undefined || typeof record[key] === 'string'
    ) &&
    ['old_path', 'new_path'].every(
      key => record[key] === undefined || record[key] === null || typeof record[key] === 'string'
    )
  );
}

export function isReviewPassPayload(value: unknown): boolean {
  const record = asRecord(value);
  return Boolean(
    record &&
      typeof record.summary === 'string' &&
      Array.isArray(record.findings) &&
      record.findings.every(isReviewFindingPayload)
  );
}
