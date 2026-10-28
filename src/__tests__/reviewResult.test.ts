import { parseReviewJsonPayload } from '../utils/reviewResult';

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn() },
}));

describe('parseReviewJsonPayload', () => {
  const payload = {
    summary: 'Checked',
    findings: [
      {
        title: 'Bug',
        body: 'Read ```json {"sample":true} ``` and escaped "quotes" at C:\\repo.',
        confidence: 90,
        path: 'src/a.ts',
      },
    ],
  };

  it('prefers the entire raw JSON document over fences inside its strings', () => {
    expect(parseReviewJsonPayload(JSON.stringify(payload))).toEqual(payload);
  });

  it.each(['json', 'JSON', ''])(
    'keeps fences inside strings in a prose-wrapped %s envelope',
    language => {
      const output = `Result:\n\`\`\`${language}\n${JSON.stringify(payload, null, 2)}\n\`\`\`\nDone.`;
      expect(parseReviewJsonPayload(output)).toEqual(payload);
    }
  );

  it('finds the result after unrelated and malformed fenced blocks', () => {
    const output = [
      '```text\nNot JSON\n```',
      '```json\n{"summary": }\n```',
      '```json\n{"summary": "unterminated\n```',
      `\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``,
    ].join('\n');
    expect(parseReviewJsonPayload(output)).toEqual(payload);
  });

  it.each(['```text\nx\n```\n', '```json\n{"incomplete":\n```\n'])(
    'bounds parsing work for repeated invalid blocks: %s',
    block => {
      const blockCount = 40;
      const output = block.repeat(blockCount);
      const parseSpy = jest.spyOn(JSON, 'parse');
      let result;
      let parsedLengths: number[];
      try {
        result = parseReviewJsonPayload(output);
        parsedLengths = parseSpy.mock.calls.map(([input]) => input.length);
      } finally {
        parseSpy.mockRestore();
      }

      expect(result).toBeNull();
      expect(parsedLengths.length).toBeLessThanOrEqual(blockCount + 1);
      expect(parsedLengths.reduce((sum, length) => sum + length, 0)).toBeLessThanOrEqual(
        output.length * 2
      );
    }
  );
});
