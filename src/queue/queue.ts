import { Queue, Worker, type Processor } from 'bullmq';
import { Redis } from 'ioredis';
import type { JobData } from './job.js';

export const QUEUE_NAME = 'codex-jobs';

/** BullMQ требует maxRetriesPerRequest=null для блокирующих операций воркера. */
export function createConnection(redisUrl: string): Redis {
  return new Redis(redisUrl, { maxRetriesPerRequest: null });
}

export function createQueue(connection: Redis): Queue<JobData> {
  return new Queue<JobData>(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: 100,
      removeOnFail: 200,
    },
  });
}

/**
 * `concurrency` вынесена в конфиг: сиат подписки общий с живым разработчиком, поэтому
 * при учащении rate-limit её откатывают одной env-переменной. Параллельные джобы по
 * одному репозиторию безопасны — операции над bare-кэшем сериализует `KeyedMutex`.
 */
export function createWorker(
  connection: Redis,
  processor: Processor<JobData>,
  concurrency: number,
): Worker<JobData> {
  return new Worker<JobData>(QUEUE_NAME, processor, { connection, concurrency });
}
