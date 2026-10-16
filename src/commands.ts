import type { Config } from './config.js';
import { Store, UserError, type Product } from './store.js';
import type { ShopService } from './service.js';
import type { OutgoingMessage } from './providers/types.js';

type BotOptions = Pick<Config, 'owner' | 'botName' | 'ownerName' | 'timezone' | 'mode'> & { logoPath?: string };
const ownerCommands = new Set(['addproduct', 'addsupplier', 'editproduct', 'addstock', 'listproduct', 'liststock', 'syncproduk', 'orders', 'rekap', 'kirimulang', 'cekbayar', 'hostmenu']);
const rupiah = (value: number) => `Rp${value.toLocaleString('id-ID')}`;

export class CommandRouter {
  constructor(private store: Store, private service: ShopService, private options: BotOptions) {}

  async handle(customer: string, input: string, messageId: string): Promise<OutgoingMessage> {
    const cached = await this.store.cachedReply(customer, messageId);
    if (cached) return cached;
    if (!await this.store.commandRateAllowed(customer)) return { text: 'Terlalu banyak pesan. Coba lagi sebentar.' };
    let reply: OutgoingMessage;
    try {
      if (input.length > 12000) throw new UserError('Pesan terlalu panjang');
      const text = input.trim().replace(/^[.!]/, '');
      const separator = text.indexOf(' ');
      const command = (separator < 0 ? text : text.slice(0, separator)).toLowerCase();
      const args = separator < 0 ? '' : text.slice(separator + 1).trim();
      if (ownerCommands.has(command) && customer !== this.options.owner) throw new UserError('Perintah ini hanya untuk owner');
      reply = await this.dispatch(customer, command, args, messageId);
      if (ownerCommands.has(command)) await this.store.audit(customer, command, args.split('|')[0].slice(0, 64));
    } catch (error) {
      if (!(error instanceof UserError)) throw error;
      reply = { text: error.message };
    }
    await this.store.recordReply(customer, messageId, reply);
    return reply;
  }

  private productLine(product: Product) {
    const availability = product.kind === 'OWN_STOCK' ? `Stok ${product.stock}` : product.supplier_available ? 'Supplier tersedia' : 'Supplier offline';
    return `• ${product.code} — ${product.name}\n  ${rupiah(product.price)} | ${availability}${product.target_type !== 'NONE' ? ` | Tujuan: ${product.target_type}` : ''}`;
  }

  private async dispatch(customer: string, command: string, args: string, messageId: string): Promise<OutgoingMessage> {
    if (command === 'menu' || command === 'stok') {
      const products = await this.store.listProducts();
      const categories = [...new Set(products.map(product => product.category))];
      await this.store.saveMenu(customer, categories);
      const summary = await this.store.summary();
      const time = new Intl.DateTimeFormat('id-ID', { timeZone: this.options.timezone, dateStyle: 'full', timeStyle: 'medium' }).format(new Date());
      return { text: `━━[ *${this.options.botName}* ✓ ]━━\nHi @${customer}, welcome! 📣\nTerjual: ${summary.delivered}\n${time}\n${this.options.mode !== 'live' ? `[${this.options.mode.toUpperCase()} — bukan transaksi live]\n` : ''}\n${categories.map((category, index) => `[${index + 1}] ${category}`).join('\n') || 'Katalog belum tersedia.'}\n\nKetik nomor kategori untuk melihat produk.\nbeli <kode> [tujuan]\nKetik bantuan untuk petunjuk.`, imagePath: this.options.logoPath };
    }
    if (/^\d{1,2}$/.test(command)) {
      const category = await this.store.menuCategory(customer, Number(command));
      if (!category) throw new UserError('Kategori tidak ditemukan. Ketik menu untuk memperbarui daftar.');
      const products = (await this.store.listProducts()).filter(product => product.category === category);
      return { text: `*${category}*\n\n${products.map(product => this.productLine(product)).join('\n\n') || 'Produk tidak tersedia.'}\n\nPesan: beli <kode> [tujuan]` };
    }
    if (command === 'beli') {
      const [code, target = '', extra] = args.split(/\s+/);
      if (!code || extra) throw new UserError('Format: beli <kode-produk> [tujuan]');
      const order = await this.service.buy(customer, code, target, messageId);
      return { text: `Order ${order.id} dibuat.\n${order.product_name} — ${rupiah(order.amount)}\nSedang menyiapkan QR. Jangan membuat pesanan ulang.\nCek: status ${order.id}` };
    }
    if (command === 'status') {
      const order = await this.store.getOrder(args, customer);
      return { text: `Order ${order.id}\nProduk: ${order.product_name}\nTotal: ${rupiah(order.amount)}\nPembayaran: ${order.payment_status}\nPengiriman: ${order.fulfillment_status}` };
    }
    if (command === 'batal') {
      await this.service.cancel(args, customer);
      const order = await this.store.getOrder(args, customer);
      return { text: `Order ${args}: ${order.payment_status}. Pembatalan hanya selesai setelah dikonfirmasi provider.` };
    }
    if (command === 'owner') return { text: `Owner: ${this.options.ownerName}\nWhatsApp: +${this.options.owner}` };
    if (command === 'addproduct') {
      const fields = args.split('|').map(field => field.trim());
      if (fields.length !== 4) throw new UserError('Format: addproduct KODE|Nama|Kategori|Harga');
      await this.store.addProduct({ code: fields[0], name: fields[1], category: fields[2], price: Number(fields[3]), kind: 'OWN_STOCK' });
      return { text: `Produk ${fields[0]} berhasil ditambahkan.` };
    }
    if (command === 'addsupplier') {
      const fields = args.split('|').map(field => field.trim());
      if (fields.length !== 7 || !['PHONE', 'ID'].includes(fields[6])) throw new UserError('Format: addsupplier KODE|Nama|Kategori|HargaJual|SKU|MaxBiaya|PHONE atau ID');
      await this.store.addProduct({ code: fields[0], name: fields[1], category: fields[2], price: Number(fields[3]), kind: 'DIGIFLAZZ', sku: fields[4], maxPrice: Number(fields[5]), targetType: fields[6] as 'PHONE' | 'ID' });
      return { text: `Produk supplier ${fields[0]} berhasil ditambahkan.` };
    }
    if (command === 'editproduct') {
      const fields = args.split('|').map(field => field.trim());
      if (![5, 6].includes(fields.length) || !['on', 'off'].includes(fields[4])) throw new UserError('Format: editproduct KODE|Nama|Kategori|Harga|on/off[|MaxBiaya]');
      await this.store.editProduct(fields[0], { name: fields[1], category: fields[2], price: Number(fields[3]), active: fields[4] === 'on', maxPrice: fields[5] ? Number(fields[5]) : undefined });
      return { text: `Produk ${fields[0]} berhasil diperbarui.` };
    }
    if (command === 'addstock') {
      const separator = args.indexOf('|');
      if (separator < 1) throw new UserError('Format: addstock KODE|Isi stok (satu unit)');
      await this.store.addStock(args.slice(0, separator).trim(), args.slice(separator + 1));
      return { text: 'Satu stok berhasil ditambahkan. Isi stok tidak ditampilkan ulang.' };
    }
    if (command === 'listproduct' || command === 'liststock') {
      const products = await this.store.listProducts(true);
      return { text: products.map(product => `${this.productLine(product)}\n  ${product.active ? 'Aktif' : 'Nonaktif'}${product.sku ? ` | SKU ${product.sku} | Max biaya ${rupiah(product.max_price!)}` : ''}`).join('\n\n') || 'Belum ada produk.' };
    }
    if (command === 'syncproduk') return { text: `${await this.service.syncCatalog()} SKU supplier disinkronkan. Produk baru nonaktif; tentukan harga sebelum aktivasi.` };
    if (command === 'orders') return { text: (await this.store.recentOrders()).map(order => `${order.id}\n${order.product_name} | ${rupiah(order.amount)}\n${order.payment_status} / ${order.fulfillment_status}`).join('\n\n') || 'Belum ada order.' };
    if (command === 'rekap') {
      const summary = await this.store.summary();
      return { text: `Pembayaran sukses: ${summary.paid}\nProduk terkirim: ${summary.delivered}\nPembayaran masuk bruto: ${rupiah(summary.revenue)}\nBelum dikurangi biaya supplier/gateway atau refund.` };
    }
    if (command === 'kirimulang') {
      await this.store.retryDelivery(args);
      return { text: `Pengiriman order ${args} dijadwalkan ulang dengan stok yang sama.` };
    }
    if (command === 'cekbayar') {
      const fields = args.split(/\s+/);
      if (fields.length !== 2) throw new UserError('Format: cekbayar <id-order> <payment-request-id-dari-dashboard>');
      await this.service.recoverPayment(fields[0], fields[1]);
      return { text: `Order ${fields[0]} dicek melalui API provider. Gunakan status/orders untuk melihat hasil.` };
    }
    if (command === 'hostmenu') return { text: `*HOST MENU ${this.options.botName}*\n${[...ownerCommands].join('\n')}\n\nFormat lengkap tersedia di README proyek.` };
    return { text: `*Bantuan ${this.options.botName}*\nmenu / stok\n<nomor kategori>\nbeli <kode> [tujuan]\nstatus <id-order>\nbatal <id-order>\nowner\n\nPembayaran diproses otomatis; jangan kirim bukti transfer sebagai konfirmasi.` };
  }
}
