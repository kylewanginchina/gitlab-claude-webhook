import { detectReviewLanguages, normalizeReviewLanguageHint } from '../admin/reviewLanguages';

describe('review language detection', () => {
  it('detects canonical languages from paths and Dockerfile names', () => {
    expect(
      [
        ...detectReviewLanguages([
          'src/app.tsx',
          'agent/src/main.rs',
          'proto/service.proto',
          'Dockerfile.deepflow',
        ]),
      ].sort()
    ).toEqual(['dockerfile', 'protobuf', 'rust', 'typescript']);
  });

  it.each([
    ['TS', 'typescript'],
    ['javascript', 'javascript'],
    ['Py', 'python'],
    ['c++', 'cpp'],
    ['proto', 'protobuf'],
    ['unknown-language', null],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeReviewLanguageHint(input)).toBe(expected);
  });
});
