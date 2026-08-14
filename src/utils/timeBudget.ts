export interface TimeBudget {
  timeoutMinutes: number;
  softDeadlineMinutes: number;
  wrapUpMinutes: number;
}

export function createTimeBudget(timeoutMs: number): TimeBudget {
  const timeoutMinutes = Math.max(1, Math.ceil(timeoutMs / 60_000));
  return {
    timeoutMinutes,
    softDeadlineMinutes: Math.max(1, Math.floor(timeoutMinutes * 0.8)),
    wrapUpMinutes: Math.max(1, Math.min(3, Math.floor(timeoutMinutes * 0.2))),
  };
}
