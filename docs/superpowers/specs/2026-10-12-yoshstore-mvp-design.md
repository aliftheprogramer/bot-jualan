# Desain MVP YOSHSTORE

Status: disetujui pengguna; implementasi MVP tersedia. Pairing dan pengujian provider dengan akun nyata masih diperlukan sebelum live.

## Konteks dan keputusan

- Pada saat desain dibuat, workspace kosong dan belum menjadi repository Git.
- Merchant adalah Danis di Indonesia; fokus penjualan lokal.
- Semua harga, pesanan, dan pembayaran memakai IDR, disimpan sebagai bilangan bulat rupiah.
- Koneksi WhatsApp awal memakai Baileys, dengan risiko integrasi tidak resmi yang sudah dibahas.
- Pembayaran memakai Xendit QRIS dinamis per pesanan.
- Pemenuhan produk mendukung stok sendiri dan Digiflazz Buyer.
- Transaksi pelanggan dilakukan lewat chat pribadi. Grup, rental bot, dan multi-tenant bukan lingkup MVP.
- Nama awal YOSHSTORE; informasi owner dan gambar menu configurable. Nomor dalam contoh tidak otomatis dianggap nomor WhatsApp bot atau otorisasi owner.
- Tidak ada klaim 262 fitur atau 2440 penjualan: jumlah dihitung dari fitur dan transaksi nyata.

## Pilihan implementasi

1. Rekomendasi: satu aplikasi Node.js/TypeScript modular dengan PostgreSQL, HTTP webhook, Baileys, dan worker berbasis database. Integrasi dipisahkan, deployment tetap sederhana.
2. Alternatif: SQLite untuk demonstrasi lokal. Lebih ringan tetapi bukan pilihan awal untuk aplikasi yang menerima pembayaran dan membutuhkan koordinasi worker/penguncian stok.
3. Alternatif: layanan terpisah dan antrean eksternal. Lebih banyak komponen operasional, belum diperlukan untuk satu toko.

Pilihan pertama menjadi rancangan yang diajukan. Tidak membutuhkan Redis pada MVP.

## Arsitektur

```text
WhatsApp/Baileys -> command router -> application services -> PostgreSQL
                                         |
                                         +-> Xendit payment adapter
                                         +-> Digiflazz supplier adapter

Webhook HTTP -> autentikasi + validasi -> durable events/jobs -> worker
                                                          -> fulfillment
                                                          -> WhatsApp outbox
```

Application services tidak bergantung pada Baileys sehingga Cloud API bisa ditambahkan kemudian.
Adapter pembayaran dan supplier tidak menentukan otorisasi, harga jual, atau kepemilikan order.

Stack yang diajukan:

- Node.js versi LTS yang didukung dependensi dan TypeScript.
- Fastify untuk health check dan webhook; validasi skema pada boundary.
- PostgreSQL dan migration versioned untuk penyimpanan persisten.
- Worker jobs/outbox PostgreSQL dengan lease, retry terukur, dan dead-letter/manual review.
- Test runner dan fixture provider untuk pengujian tanpa pembayaran nyata.
- Docker Compose untuk PostgreSQL lokal; aplikasi bisa berjalan langsung atau dalam container.

## Lingkup perintah

Pelanggan:

- `menu` / `stok`: banner opsional, kategori, produk aktif, harga, ketersediaan.
- Nomor kategori: daftar varian dalam konteks menu terakhir, tanpa otomatis membeli.
- `beli <kode-produk> [tujuan]`: satu unit per pesanan untuk MVP.
- `status <id-order>`: status order milik pengirim.
- `batal <id-order>`: hanya sebelum pembayaran; status pembayaran yang belum pasti masuk rekonsiliasi, bukan dilepas sembarangan.
- `owner` / `bantuan`: kontak dan petunjuk.

Owner:

- Tambah, edit, aktif/nonaktif produk dan varian.
- Tambah stok sendiri; lihat jumlah stok, bukan seluruh rahasia stok dalam respons default.
- Sinkronisasi katalog Digiflazz; SKU baru nonaktif sampai owner menentukan harga dan tujuan.
- Lihat order dan rekap penjualan.
- Retry pengiriman yang tertahan dan tandai kasus yang perlu penanganan manual.

Perintah owner hanya chat pribadi dan harus memverifikasi identitas pengirim dari allowlist konfigurasi.
Mapping identitas Baileys PN/LID perlu dilakukan secara eksplisit; identitas yang tidak bisa diverifikasi ditolak, bukan dipercaya berdasarkan display name.

## Model data minimal

- Categories dan products: kode, kategori, varian, harga IDR, aktif, mode `OWN_STOCK` atau `DIGIFLAZZ`, supplier SKU, aturan tujuan, batas harga supplier.
- Stock items: payload terenkripsi, status `AVAILABLE`, `RESERVED`, atau `SOLD`, order reservasi.
- Orders: ID unik, customer identity, snapshot produk/harga, tujuan, payment status, fulfillment status, timestamps.
- Payments: order, provider request/payment ID, reference ID, amount, currency, expiry, status dan hasil rekonsiliasi.
- Supplier transactions: order, ref_id stabil, status, harga supplier, serial/result terenkripsi jika sensitif.
- Webhook events: deduplication key, hash payload, processing status; hindari penyimpanan payload sensitif tanpa kebutuhan.
- Jobs dan message outbox: task key unik, lease, attempts, retry time, delivery status, message ID.
- Audit events: aksi owner dan perubahan status; tidak mencatat API key atau isi rahasia stok.

Database memakai foreign keys dan uniqueness untuk referensi pembayaran, transaksi supplier, dan pemenuhan order.
Harga serta biaya supplier memakai snapshot/limit: perubahan harga katalog tidak mengubah order yang sudah dibuat.

## Order dan pembayaran

1. Validasi pengirim, produk aktif, tujuan, harga, dan rate limit.
2. Buat order; untuk stok sendiri, reservasi satu item dalam transaksi database dengan penguncian baris.
3. Buat satu pembayaran Xendit dengan reference stabil. Jika request timeout, rekonsiliasi dahulu sebelum mencoba membuat pembayaran baru.
4. Render QR resmi dari action/payload provider menjadi gambar; kirim nominal, ID order, dan expiry yang sesuai provider.
5. Terima webhook melalui HTTPS, verifikasi token sesuai produk API Xendit yang digunakan, serta validasi payment ID, reference, merchant bila tersedia, amount dan currency.
6. Persist event/job sebelum mengirim respons sukses ke provider. Jangan menunggu fulfillment atau WhatsApp dalam handler webhook.
7. Worker melakukan transisi payment sukses sekali dan menjadwalkan fulfillment.
8. Expiry/cancel harus mengikuti status terminal provider. Ketidakpastian dan pembayaran terlambat masuk review/reconciliation.

Gunakan Payments API v3 sebagai kandidat utama, sesuai rekomendasi dokumentasi Xendit. Kontrak QRIS, response actions, expiry, webhook, dan kemampuan cancel/status harus diverifikasi terhadap dokumentasi produk yang sama sebelum implementasi adapter.
Jangan mencampur endpoint QR Codes legacy, payload V3, atau callback produk Bill Payments.
Jika expiry lokal tidak dapat ditegakkan pada provider, UI tidak boleh menjanjikan QR pasti tidak bisa dibayar sesudah timer lokal.

Payment states: `CREATING`, `PENDING`, `SUCCEEDED`, `FAILED`, `EXPIRED`, `CANCELED`, `REVIEW`.
Fulfillment states terpisah: `NOT_STARTED`, `QUEUED`, `PROCESSING`, `PENDING_SUPPLIER`, `READY`, `DELIVERED`, `FAILED`, `REVIEW`.
Pembayaran sukses tidak boleh diturunkan menjadi gagal karena callback terlambat atau proses pengiriman gagal.

## Pemenuhan stok sendiri

- Setelah pembayaran sah, alokasikan stok reservasi ke order sekali dalam transaksi database.
- Simpan pekerjaan pengiriman dalam transaksi yang sama; bot mati tidak boleh menghilangkan produk yang sudah dibayar.
- Payload stok dienkripsi dengan authenticated encryption dan key persisten di konfigurasi, bukan source code.
- Worker mengirim hanya ke pelanggan pemilik order di chat pribadi.
- Retry menggunakan alokasi stok yang sama, tidak mengambil stok baru.
- Tidak menjanjikan exactly-once delivery ke WhatsApp saat kegagalan jaringan ambigu. Kasus ambigu memakai message identity/reconciliation bila memungkinkan; tidak menghasilkan pemenuhan kedua.
- Pembayaran terlambat setelah reservasi dilepas: jangan mengambil stok milik order lain; coba alokasi baru secara atomik jika tersedia atau eskalasi owner.

## Pemenuhan Digiflazz Buyer

- Katalog supplier tidak otomatis menjadi katalog jual. Owner memilih SKU dan markup/harga.
- Validasi tujuan sebelum checkout; cek status produk dan limit harga supplier.
- Kirim transaksi hanya setelah pembayaran pelanggan sah.
- Gunakan ref_id stabil per order dan `max_price` agar harga supplier tidak melampaui batas yang disetujui.
- Request memakai signature sesuai dokumentasi Buyer. Respons dibaca dari objek `data`.
- Hasil `Pending`/timeout tidak dianggap gagal dan tidak membuat ref_id baru. Status dicek memakai ref_id yang sama.
- Webhook Digiflazz diverifikasi HMAC terhadap raw body dengan secret konfigurasi.
- Supplier gagal sesudah pembayaran: tandai fulfillment gagal/review dan beri tahu owner/pelanggan. Tidak melakukan refund otomatis atau retry dengan transaksi baru.

## Keamanan dan konfigurasi

- Tidak meminta API key, token, QR sesi, atau rahasia stok di chat.
- `.env.example` hanya placeholder; `.env`, auth session, file database, logs sensitif, dan backup tidak masuk Git.
- Pisahkan simulation, sandbox provider, dan live mode. Live tidak boleh aktif sebagai default.
- Simulation memakai provider palsu lokal dan data demo berlabel; tidak boleh memanggil supplier live.
- Sandbox memakai kredensial test Xendit dan testing Digiflazz, sesuai dukungan/test case provider.
- API key, webhook token, stock encryption key, owner allowlist, timezone `Asia/Jakarta`, logo, dan session path configurable.
- Basic rate limits, body-size limit, input validation, redacted logs, dan startup config validation.
- Endpoint HTTP awal hanya health check dan webhook; tidak ada dashboard atau endpoint admin publik.

## Pengujian dan acceptance criteria

- Menu hanya menampilkan produk aktif dengan stok/harga yang benar.
- Pengirim non-owner tidak bisa mengelola produk atau melihat order pelanggan lain.
- Dua order serentak tidak memperoleh stok yang sama.
- Callback token/signature salah ditolak; amount/currency/reference salah tidak mengaktifkan fulfillment.
- Callback duplikat dan callback tidak berurutan tidak menyebabkan double fulfillment atau downgrade pembayaran.
- Restart worker/bot tetap mempertahankan order, reservasi, pending supplier, dan outbox.
- Timeout pembuatan pembayaran tidak menciptakan pembayaran kedua tanpa rekonsiliasi.
- Timeout/pending Digiflazz menggunakan ref_id lama, termasuk setelah restart.
- Expiry dan pembayaran terlambat diuji; tidak ada stok hilang atau uang sukses yang diam-diam diabaikan.
- WhatsApp offline tidak memblokir penerimaan callback; order paid tetap bisa dikirim setelah reconnect.
- Local simulation lulus end-to-end tanpa uang nyata. Sandbox provider diverifikasi sebelum live.

## Di luar lingkup MVP

- Rental/hosting multi-bot, broadcast, grup toko, saldo deposit pelanggan, withdrawal otomatis, dan 262 perintah.
- Channel kartu, MYR, metode pembayaran lokal Malaysia, dan jaminan QRIS cross-border.
- Dashboard web dan refund otomatis. Kasus refund dicatat untuk tindakan owner lewat mekanisme provider.
- Menjual produk yang hak distribusinya belum sah; owner bertanggung jawab memastikan sumber dan izin produk.

## Prasyarat eksternal sebelum transaksi nyata

- Owner menetapkan nomor otorisasi dan nomor WhatsApp bot; pairing dilakukan secara lokal.
- Merchant Xendit Indonesia disetujui, channel QRIS aktif, kategori produk diterima, tarif/settlement dikonfirmasi.
- Kredensial test/live diisi lokal; webhook HTTPS publik disiapkan.
- Digiflazz Buyer disiapkan, API credentials dan webhook secret dikonfigurasi; whitelist IP bila diwajibkan pengaturan akun.
- SKU, test case, saldo supplier, markup, dan batas biaya dipastikan sebelum aktivasi live.
- Hosting persisten, backup dan prosedur pemulihan tersedia. Gratisnya library WhatsApp tidak berarti gateway/hosting/supplier gratis.

## Sumber teknis untuk verifikasi implementasi

- Xendit How Payments API work: https://docs.xendit.co/v1/docs/how-payments-api-work
- Xendit webhook verification: https://help.xendit.co/hc/en-us/articles/360038072991-How-to-validate-if-the-webhook-is-sent-from-Xendit
- Digiflazz Buyer topup: https://developer.digiflazz.com/api/buyer/topup/
- Digiflazz Buyer webhook: https://developer.digiflazz.com/api/buyer/webhook/
- Baileys upstream: https://github.com/WhiskeySockets/Baileys

## Review spesifikasi

- Keputusan sudah jelas: merchant Indonesia, IDR, Xendit QRIS, Baileys tahap awal, stok sendiri + Digiflazz Buyer.
- Batas MVP jelas: satu toko, private chat, satu unit/order, tanpa saldo pelanggan/multi-bot.
- Kode aplikasi dan demo lokal sudah tersedia; pairing, kredensial, dan pembayaran live belum dilakukan. Lihat README untuk batas verifikasi eksternal.
- Detail API Xendit sengaja menjadi verifikasi kontrak sebelum coding adapter, bukan asumsi payload legacy.
- Review pengguna diterima sebelum coding. Tidak ada commit/branch dibuat.
