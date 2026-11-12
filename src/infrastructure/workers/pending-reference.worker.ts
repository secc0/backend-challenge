import type { ResolvePendingReferences } from '../../application/resolve-pending-references';
import type { JsonLogger } from '../observability/logger';

/** Periodically runs the pending-reference resolution; safe to run on every instance. */
export class PendingReferenceWorker {
  private running = false;
  private loop: Promise<void> | null = null;

  constructor(
    private readonly resolver: ResolvePendingReferences,
    private readonly pollIntervalMs: number,
    private readonly logger: JsonLogger,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
    this.logger.info('pending reference worker started');
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
    this.logger.info('pending reference worker stopped');
  }

  private async run(): Promise<void> {
    while (this.running) {
      let handled = 0;
      try {
        handled = await this.resolver.runOnce();
      } catch (error) {
        this.logger.error('pending reference cycle failed', error as Error);
      }
      if (handled === 0) await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
  }
}
