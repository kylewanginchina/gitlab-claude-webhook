export interface SecretStatus {
  configured: boolean;
  masked: string;
}

export function maskSecret(value: string | undefined): string {
  if (!value) {
    return '';
  }

  if (value.length <= 4) {
    return '***';
  }

  return `${'*'.repeat(Math.max(8, value.length - 4))}${value.slice(-4)}`;
}

export function secretStatus(value: string | undefined): SecretStatus {
  return {
    configured: Boolean(value && value.length > 0),
    masked: maskSecret(value),
  };
}
