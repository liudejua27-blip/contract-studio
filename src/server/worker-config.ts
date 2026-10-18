export function integerSetting(env: Record<string,string|undefined>, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

export function workerConfig(env: Record<string,string|undefined> = process.env) {
  const globalConcurrency = integerSetting(env, 'CONTRACT_AI_GLOBAL_CONCURRENCY', 120, 1, 500);
  return {
    concurrency: integerSetting(env, 'CONTRACT_WORKER_CONCURRENCY', 30, 1, 100),
    globalConcurrency,
    intakeReserve: integerSetting(env, 'CONTRACT_AI_INTAKE_RESERVE', Math.min(20, globalConcurrency - 1), 0, globalConcurrency - 1),
    maxQueued: integerSetting(env, 'CONTRACT_AI_MAX_QUEUED', 1000, 1, 100000),
    pollMs: integerSetting(env, 'CONTRACT_WORKER_POLL_MS', 1000, 100, 30000),
    leaseMs: 30000,
  };
}

export function autoscaleConfig(env: Record<string,string|undefined> = process.env) {
  const maxWorkers = integerSetting(env, 'CONTRACT_WORKERS_MAX', 4, 1, 50);
  return {
    minWorkers: integerSetting(env, 'CONTRACT_WORKERS_MIN', 1, 0, maxWorkers),
    maxWorkers,
    intervalMs: integerSetting(env, 'CONTRACT_AUTOSCALE_INTERVAL_MS', 5000, 1000, 60000),
    cooldownMs: integerSetting(env, 'CONTRACT_AUTOSCALE_COOLDOWN_MS', 60000, 5000, 600000),
  };
}

/** One replica can use its local slots; all replicas still share the database cap. */
export function desiredWorkers(ready: number, running: number, localSlots: number, globalSlots: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.ceil(Math.min(globalSlots, ready + running) / localSlots)));
}
