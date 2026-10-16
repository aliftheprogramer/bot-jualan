import type { Payment, Payments, Supplier, SupplierInput, SupplierProduct, SupplierResult } from './types.js';

export class SimulationPayments implements Payments {
  readonly payments = new Map<string, Payment>();
  async create(order: { id: string; amount: number }): Promise<Payment> {
    const existing = await this.find(order.id);
    if (existing) return existing;
    const payment: Payment = { id: `sim-${order.id}`, reference: order.id, amount: order.amount, currency: 'IDR', status: 'PENDING', qr: `SIMULATION-NOT-PAYABLE:${order.id}` };
    this.payments.set(payment.id, payment);
    return { ...payment };
  }
  async get(id: string): Promise<Payment> {
    const payment = this.payments.get(id);
    if (!payment) throw new Error('Simulated payment unavailable after restart; manual review required');
    return { ...payment };
  }
  async find(reference: string): Promise<Payment | null> {
    return [...this.payments.values()].find(payment => payment.reference === reference) ?? null;
  }
  async cancel(id: string): Promise<void> {
    const payment = await this.get(id);
    if (payment.status === 'PENDING') this.payments.set(id, { ...payment, status: 'CANCELED' });
  }
  settle(id: string): void {
    const payment = this.payments.get(id);
    if (!payment || payment.status !== 'PENDING') throw new Error('Payment simulation tidak pending');
    this.payments.set(id, { ...payment, status: 'SUCCEEDED' });
  }
}

export class SimulationSupplier implements Supplier {
  async fulfill(input: SupplierInput): Promise<SupplierResult> {
    return { reference: input.reference, status: 'SUCCEEDED', result: `DEMO-SUPPLIER-${input.reference}` };
  }
  async catalog(): Promise<SupplierProduct[]> {
    return [{ sku: 'DEMO10', name: 'Demo supplier 10k', category: 'Demo', cost: 9000, available: true }];
  }
}
