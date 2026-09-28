import type { Ctx } from "../server/context.js";
import type { ManualClock } from "../server/lib/clock.js";
import { tick } from "../server/scheduler.js";

/** Avança o relógio manual em passos, chamando o agendador como se o sistema estivesse ligado. */
export async function runClock(ctx: Ctx, clock: ManualClock, until: Date, stepMinutes = 5, skip?: (t: Date) => boolean) {
  while (clock.now() < until) {
    if (!skip?.(clock.now())) await tick(ctx);
    clock.advanceMinutes(stepMinutes);
  }
}
