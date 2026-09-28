/** Relógio injetável: permite testes e simulações determinísticas sem olhar para o futuro. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export class ManualClock implements Clock {
  constructor(private t: Date) {}
  now() {
    return new Date(this.t.getTime());
  }
  set(t: Date | string) {
    this.t = new Date(t);
  }
  advanceMinutes(m: number) {
    this.t = new Date(this.t.getTime() + m * 60_000);
  }
}
