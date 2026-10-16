import type { Store } from './store.js';
import type { ShopService } from './service.js';
import type { Messenger, OutgoingMessage } from './providers/types.js';

export interface CommandRunner {
  handle(customer: string, text: string, messageId: string): Promise<OutgoingMessage>;
}

export class Worker {
  private stopping = false;
  constructor(private store: Store, private service: ShopService, private messenger: Messenger, private commands?: CommandRunner) {}

  async tick(): Promise<boolean> {
    const job = await this.store.claimJob();
    if (!job) return false;
    try {
      let delay: number | undefined;
      const payload = this.store.payload(job);
      if (job.type === 'CHECKOUT' && job.order_id) await this.service.checkout(job.order_id);
      else if (job.type === 'RECONCILE' && job.order_id) delay = await this.service.reconcile(job.order_id);
      else if (job.type === 'FULFILL' && job.order_id) delay = await this.service.fulfill(job.order_id);
      else if (job.type === 'PAYMENT_EVENT') await this.service.paymentEvent(payload.paymentId, payload.reference);
      else if (job.type === 'SUPPLIER_EVENT') await this.service.supplierEvent(payload.reference);
      else if (job.type === 'COMMAND' && this.commands && payload.customer && payload.text !== undefined && payload.messageKey) {
        const reply = await this.commands.handle(payload.customer, payload.text, payload.messageKey);
        await this.store.notify(`reply:${payload.customer}:${payload.messageKey}`, payload.customer, reply);
      }
      else if (job.type === 'NOTIFY' && payload.customer && payload.message) await this.messenger.send(payload.customer, payload.message, job.id.replaceAll('-', '').toUpperCase());
      else throw new Error('Invalid job');
      await this.store.finishJob(job, delay);
    } catch {
      await this.store.failJob(job);
      if (job.attempts >= 10 && job.order_id) await this.store.markReview(job.order_id, this.service.owner, 'Pekerjaan tertahan setelah retry; periksa koneksi/status provider');
    }
    return true;
  }

  async run() {
    this.stopping = false;
    while (!this.stopping) {
      try { if (!await this.tick()) await new Promise(resolve => setTimeout(resolve, 500)); }
      catch { await new Promise(resolve => setTimeout(resolve, 1000)); }
    }
  }

  stop() { this.stopping = true; }
}
