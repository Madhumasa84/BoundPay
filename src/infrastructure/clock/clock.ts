export interface Clock {
  now(): Date;
  nowIso(): string;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
  nowIso(): string {
    return this.now().toISOString();
  }
}

export class TestClock implements Clock {
  private currentTime: Date;

  constructor(initialTime: Date | string = new Date('2026-09-03T01:30:00.000Z')) {
    this.currentTime = typeof initialTime === 'string' ? new Date(initialTime) : initialTime;
  }

  now(): Date {
    return new Date(this.currentTime.getTime());
  }

  nowIso(): string {
    return this.currentTime.toISOString();
  }

  setTime(time: Date | string): void {
    this.currentTime = typeof time === 'string' ? new Date(time) : time;
  }

  advanceSeconds(seconds: number): void {
    this.currentTime = new Date(this.currentTime.getTime() + seconds * 1000);
  }

  advanceMinutes(minutes: number): void {
    this.advanceSeconds(minutes * 60);
  }

  advanceDays(days: number): void {
    this.advanceSeconds(days * 86400);
  }
}

export const defaultClock: Clock = new SystemClock();
