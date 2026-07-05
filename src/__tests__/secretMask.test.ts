import { maskSecret, secretStatus } from '../admin/secretMask';

describe('secretMask', () => {
  it('masks missing secrets as empty strings', () => {
    expect(maskSecret(undefined)).toBe('');
    expect(secretStatus(undefined)).toEqual({ configured: false, masked: '' });
  });

  it('masks short secrets without leaking characters', () => {
    expect(maskSecret('abc')).toBe('***');
    expect(secretStatus('abc')).toEqual({ configured: true, masked: '***' });
  });

  it('keeps only the last four characters for longer secrets', () => {
    expect(maskSecret('glpat-1234567890')).toBe('************7890');
    expect(secretStatus('glpat-1234567890')).toEqual({
      configured: true,
      masked: '************7890',
    });
  });
});
