import logger from './logger';

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

/** Find the next envelope boundary without treating fences inside JSON strings as boundaries. */
function findClosingFence(text: string, start: number): number {
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      // A raw newline is invalid in a JSON string; still allow the malformed block to end.
      if (char === '\n' || char === '\r') {
        inString = false;
        escaped = false;
      } else if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
    } else if (char === '"') {
      inString = true;
    } else if (text.startsWith('```', index)) {
      return index;
    }
  }
  return -1;
}

/** Parse raw JSON first, then legacy fenced envelopes (which can include explanatory prose). */
export function parseReviewJsonPayload(output: string): JsonRecord | null {
  const text = output.trim();
  if (!text) {
    return null;
  }

  try {
    return asRecord(JSON.parse(text));
  } catch {
    // Parse disjoint blocks once each, keeping both scan and total JSON parsing work linear.
    const openingFencePattern = /```(?:json)?\s*/gi;
    let openingFence: RegExpExecArray | null;
    while ((openingFence = openingFencePattern.exec(text)) !== null) {
      const contentStart = openingFence.index + openingFence[0].length;
      const closingFence = findClosingFence(text, contentStart);
      if (closingFence === -1) {
        break;
      }
      openingFencePattern.lastIndex = closingFence + 3;
      try {
        return asRecord(JSON.parse(text.slice(contentStart, closingFence)));
      } catch {
        // Continue after this block instead of retrying combinations of earlier fences.
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
