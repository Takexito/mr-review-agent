import { pino } from 'pino';

export type Logger = ReturnType<typeof pino>;

export function createLogger(level: string): Logger {
  return pino({
    level,
    // pino-pretty подключается только если явно выставлен человекочитаемый режим
    transport:
      process.env.LOG_PRETTY === 'true'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
  });
}
