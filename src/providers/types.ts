export type PaymentStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'EXPIRED' | 'CANCELED';
export type Payment = {
  id: string;
  reference: string;
  amount: number;
  currency: string;
  status: PaymentStatus;
  qr?: string;
  expiresAt?: string;
};
export interface Payments {
  create(order: { id: string; amount: number }): Promise<Payment>;
  get(id: string): Promise<Payment>;
  find?(reference: string): Promise<Payment | null>;
  cancel(id: string): Promise<void>;
}
export type SupplierInput = { reference: string; sku: string; target: string; maxPrice: number };
export type SupplierResult = { reference: string; status: 'PENDING' | 'SUCCEEDED' | 'FAILED'; result: string };
export type SupplierProduct = { sku: string; name: string; category: string; cost: number; available: boolean };
export interface Supplier {
  fulfill(input: SupplierInput): Promise<SupplierResult>;
  catalog(): Promise<SupplierProduct[]>;
}
export type OutgoingMessage = { text: string; qr?: string; imagePath?: string };
export interface Messenger {
  send(customer: string, message: OutgoingMessage, messageId: string): Promise<void>;
}

export class ProviderError extends Error {
  constructor(public readonly provider: string, public readonly code: string) {
    super(`${provider}: ${code}`);
  }
}
