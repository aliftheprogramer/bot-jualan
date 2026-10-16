# YOSHSTORE Bot

**Bot toko produk digital di WhatsApp: katalog, stok sendiri, produk supplier, dan pembayaran QRIS dalam satu alur.**

YOSHSTORE adalah MVP untuk **satu toko** dengan Node.js dan TypeScript. Pelanggan memesan melalui chat pribadi; owner mengelola produk, stok, dan pesanan dari WhatsApp. Koneksi WhatsApp, pembayaran, dan supplier dipisahkan agar adapter dapat diganti kemudian.

**Status:** core dan simulasi bisa dijalankan; adapter provider sudah dibuat dan diuji dengan fixture. Pairing WhatsApp dan transaksi sandbox/production belum diverifikasi dengan akun nyata. Jangan menerima pelanggan live sebelum checklist sandbox selesai.

## Daftar isi

- [Fitur dan batas lingkup](#fitur-dan-batas-lingkup)
- [Arsitektur](#arsitektur)
- [Coba sekarang tanpa akun atau pembayaran](#coba-sekarang-tanpa-akun-atau-pembayaran)
- [Setup aplikasi persisten](#setup-aplikasi-persisten)
- [Pairing WhatsApp](#pairing-whatsapp)
- [Mode operasi](#mode-operasi)
- [Perintah pelanggan](#perintah-pelanggan)
- [Perintah owner](#perintah-owner)
- [Verifikasi](#verifikasi)
- [Keamanan repository](#keamanan-repository)

## Fitur dan batas lingkup

| Area | Kemampuan |
|---|---|
| Katalog | Banner opsional, kategori bernomor, harga, dan ketersediaan produk |
| Pesanan | Beli, cek status, dan batal sebelum pembayaran sukses; satu unit per order |
| Stok sendiri | Payload produk terenkripsi, reservasi stok, dan pengiriman setelah pembayaran terverifikasi |
| Supplier | Integrasi Digiflazz Buyer, sinkronisasi katalog, dan polling transaksi pending |
| Pembayaran | Adapter Xendit Payments V3 untuk QRIS IDR dan validasi pembayaran melalui API provider |
| Owner | Kelola produk/stok, lihat pesanan dan rekap bruto, rekonsiliasi manual, kirim ulang hasil |
| Reliability | PostgreSQL inbox/jobs/outbox, retry, dan penanganan callback duplikat |
| Pengujian | Demo offline dan tes menggunakan PGlite; dukungan fixture PostgreSQL lokal |

Tidak mencakup rental multi-bot, broadcast, transaksi grup, dashboard web, saldo pelanggan, atau refund otomatis. Tidak ada integrasi pengambilan OTP atau aktivasi akun pihak ketiga. Gunakan hanya produk dengan sumber dan hak distribusi yang jelas.

**Baileys bukan API resmi WhatsApp.** Tidak ada jaminan bebas pembatasan akun atau gangguan koneksi. Biaya hosting, produk supplier, dan payment gateway tidak termasuk dalam aplikasi ini.

## Arsitektur

```text
WhatsApp / Baileys → Commands → Services → PostgreSQL
                                  │          ├─ Produk & stok
                                  │          ├─ Order & pembayaran
                                  │          └─ Inbox, jobs & outbox
                                  ├─ Xendit payment adapter
                                  └─ Digiflazz supplier adapter

Provider webhooks → Fastify → Auth & validasi → Jobs → Worker → Fulfillment
                                                                  └─ WhatsApp
```

**Stack:** Node.js 22+, TypeScript, Fastify, PostgreSQL, Baileys, Vitest, dan PGlite untuk demo/tes. Redis tidak diperlukan untuk MVP ini.

## Coba sekarang tanpa akun atau pembayaran

Prasyarat: Node.js 22+ dan npm.

Untuk mengambil proyek dari GitHub setelah source di-push:

```bash
git clone git@github.com:aliftheprogramer/bot-jualan.git
cd bot-jualan
```

Perintah clone tersebut membutuhkan akses repository dan SSH GitHub yang sudah dikonfigurasi. Jika source sudah ada di komputer, cukup buka terminal di folder proyek.

```bash
npm ci
npm run demo
```

Demo menggunakan database PostgreSQL-compatible PGlite sementara, nomor palsu, voucher demo, pembayaran palsu, dan supplier palsu. Tidak menghubungi WhatsApp/Xendit/Digiflazz. Demo menampilkan menu, order, QR simulasi, pembayaran, pengiriman stok sendiri, pemenuhan supplier, dan rekap. Data demo tidak masuk database toko.

Jika berhasil, demo diakhiri dengan pesan `PASS`, dua produk terkirim, dan bruto simulasi Rp26.000. **QR demo tidak dapat dibayar dan bukan bukti pembayaran nyata.**

## Setup aplikasi persisten

Prasyarat tambahan: Docker dengan Compose dan Docker daemon aktif. Aplikasi berjalan di terminal host; Compose menjalankan PostgreSQL.

```bash
npm run setup
docker compose up -d --wait
npm run migrate
npm run dev
```

Setup meminta nomor owner Indonesia (format `62...`) dan membuat `.env` permission `0600`, encryption key, serta secret webhook secara lokal. Tidak mencetak rahasia dan tidak menimpa `.env` yang sudah ada.

- Owner adalah nomor akun yang mengirim perintah admin; gunakan nomor bot berbeda karena pesan `fromMe` diabaikan.
- Defaults: `APP_MODE=simulation`, `WHATSAPP_ENABLED=false`, HTTP localhost port 3000.
- Compose hanya PostgreSQL lokal pada `127.0.0.1:5434`; password development bukan untuk server produksi.
- Logo contoh pengguna ada di `assets/yoshstore.png`; dapat diganti melalui `LOGO_PATH`.
- Health check: `GET /health`. Tidak ada dashboard atau API admin publik.
- Build: `npm run build`, lalu `npm start`. Migration otomatis juga dicek pada startup.
- Jangan memakai `docker compose down -v` untuk restart: perintah tersebut menghapus volume database.

### Konfigurasi utama

| Variabel | Fungsi |
|---|---|
| `APP_MODE` | `simulation` (default), `sandbox`, atau `live` |
| `WHATSAPP_ENABLED` | `true` untuk mengaktifkan koneksi WhatsApp; default `false` |
| `OWNER_NUMBER` | Nomor admin format `62...`, tanpa `+`; berbeda dari nomor bot |
| `DATABASE_URL` | Koneksi PostgreSQL; template memakai localhost port 5434 |
| `STOCK_KEY` | Kunci base64 32 byte yang dibuat setup; jangan diganti pada data existing |
| `BOT_NAME`, `OWNER_NAME` | Identitas tampilan bot dan owner |
| `TIMEZONE` | Zona waktu tampilan; default `Asia/Jakarta` |
| `LOGO_PATH` | Lokasi gambar banner opsional |
| `WHATSAPP_SESSION_PATH` | Folder sesi dan QR pairing; default `./sessions/yoshstore` |
| `HOST`, `PORT` | HTTP listener; default `127.0.0.1:3000` |

Lihat [`.env.example`](.env.example) untuk template lengkap. Nomor bot ditentukan lewat akun yang dipairing, bukan melalui `OWNER_NUMBER`.

### Stop dan restart

- Hentikan aplikasi dengan `Ctrl+C`, lalu jalankan kembali `npm run dev`.
- Hentikan database tanpa menghapus data: `docker compose stop`.
- Jalankan kembali database: `docker compose up -d --wait`.
- Periksa database: `docker compose ps` dan `docker compose logs --tail=50 postgres`.
- Periksa HTTP dari terminal lain: `curl http://127.0.0.1:3000/health`.

## Pairing WhatsApp

1. Edit `.env` lokal: `WHATSAPP_ENABLED=true`. Tetap gunakan simulation atau sandbox dahulu.
2. Jalankan `npm run dev`.
3. Ketika pairing diperlukan, aplikasi menulis QR ke `sessions/yoshstore/pairing.png`. Buka file lokal itu dan scan lewat Linked Devices pada nomor bot.
4. Kirim `menu` dari akun pelanggan atau `hostmenu` dari nomor owner yang dikonfigurasi.

Tidak mencetak pairing QR ke log. Jangan upload/share folder `sessions/`, QR pairing, atau `.env`. Folder sesi adalah akses ke akun WhatsApp. Baileys bukan API resmi; tidak ada jaminan akun bebas pembatasan atau koneksi bebas gangguan. Versi library dikunci melalui lockfile; upgrade harus diuji ulang, khususnya PN/LID.

Jika logged out, aplikasi tidak menghapus sesi secara otomatis. Operator harus memutuskan prosedur pairing ulang dan memindahkan sesi lama dengan aman. Pesan grup, broadcast, riwayat sinkronisasi, media masuk, dan pesan akun bot sendiri tidak diproses.

## Mode operasi

| Mode | WhatsApp | Pembayaran dan supplier |
|---|---|---|
| `simulation` | Opsional | Fake providers; QR bertanda simulasi, tidak dapat dibayar |
| `sandbox` | Opsional | Xendit test key; Digiflazz memakai `testing=true` |
| `live` | Opsional | Xendit production key dan Digiflazz transaksi nyata |

Pada aplikasi simulation, provider pembayaran berada dalam memori; restart kehilangan status provider palsu, bukan order database. Gunakan `npm run demo` untuk alur simulasi lengkap. Tidak ada public endpoint atau command pelanggan untuk mengubah pembayaran menjadi sukses.

### Sandbox provider

Isi **secara lokal**, jangan melalui chat:

```dotenv
APP_MODE=sandbox
XENDIT_SECRET_KEY=<test-secret-key>
XENDIT_WEBHOOK_TOKEN=<callback-verification-token-dari-Xendit>
DIGIFLAZZ_USERNAME=<username-buyer>
DIGIFLAZZ_API_KEY=<api-key-testing-yang-sesuai-akun>
DIGIFLAZZ_WEBHOOK_SECRET=<secret-yang-sama-dengan-konfigurasi-Digiflazz>
```

Setup menghasilkan secret awal, tetapi token Xendit harus diganti dengan verification token yang benar dari dashboard. Secret Digiflazz harus sama dengan yang didaftarkan di webhook supplier. Akun/test case Digiflazz tetap harus disiapkan; `testing=true` bukan jaminan semua SKU live punya skenario test.

**Batas konfigurasi saat ini:** mode `sandbox` dan `live` mewajibkan konfigurasi Xendit **dan** Digiflazz, meskipun katalog hanya memakai stok sendiri. Mode non-simulasi tanpa akun Digiflazz belum didukung oleh validasi konfigurasi.

Webhook HTTPS publik yang perlu dikonfigurasi:

- `POST /webhooks/xendit`: callback **Payments V3**; header `x-callback-token` diverifikasi.
- `POST /webhooks/digiflazz`: header `X-Hub-Signature`, HMAC-SHA1 atas raw body.

Gunakan reverse proxy HTTPS ke aplikasi localhost; jangan membuka PostgreSQL ke internet. Jika menjalankan aplikasi dalam container/network terisolasi, sesuaikan `HOST`, `DATABASE_URL`, dan proxy secara eksplisit. Body callback dibatasi 64 KiB; handler mengakui event hanya sesudah penyimpanan database sukses.

### Live gate

Live membutuhkan `APP_MODE=live`, production key Xendit, seluruh konfigurasi provider, dan `LIVE_ACK=I_UNDERSTAND_REAL_MONEY`. Jangan menambahkan acknowledgement itu sebelum approval merchant/channel, legalitas katalog, tarif dan settlement, saldo supplier, whitelist IP supplier bila diperlukan, dan pengujian sandbox sudah selesai. Sistem ini tidak mengotomatisasi refund.

## Perintah pelanggan

```text
menu / stok
1                         nomor kategori dari menu terakhir
beli VOUCHER              stok sendiri, satu unit
beli PULSA 081234567890    supplier dengan tujuan
status <id-order>
batal <id-order>
owner
bantuan
```

Harga IDR, satu unit/order. Nomor kategori disimpan per pelanggan selama 30 menit. Maksimal 3 order belum selesai per pelanggan. Pembayaran sukses tidak dapat dibatalkan melalui command; hubungi owner untuk penanganan/refund.

## Perintah owner

Kirim di chat pribadi ke nomor bot, dari nomor owner:

```text
hostmenu
addproduct VOUCHER|Voucher demo|Voucher|15000
addstock VOUCHER|Isi voucher satu unit
addsupplier PULSA|Pulsa 10k|Pulsa|11000|SKU_DARI_SUPPLIER|9500|PHONE
editproduct VOUCHER|Nama baru|Voucher|16000|on
editproduct PULSA|Pulsa 10k|Pulsa|12000|off|10000
listproduct
liststock
syncproduk
orders
rekap
cekbayar <id-order> <payment-request-id-dari-dashboard-Xendit>
kirimulang <id-order>
```

- `addstock` menambahkan satu payload (bisa berisi beberapa baris), bukan bulk beberapa unit. Isi rahasia tidak ditampilkan ulang atau dimasukkan audit log.
- Stok sama dalam produk yang sama ditolak melalui keyed hash; payload dienkripsi AES-256-GCM.
- `PHONE` memerlukan 8–16 digit; `ID` hanya huruf/angka/titik/underscore/hyphen tanpa spasi. Pastikan format tujuan cocok SKU supplier; produk dengan tujuan multi-field belum punya form khusus.
- SKU hasil `syncproduk` otomatis **nonaktif**, harga jual 0, kode `DF-...`, jenis tujuan `ID`. Owner harus menetapkan nama/kategori/harga dan mengaktifkan melalui `editproduct`.
- Sinkronisasi berikutnya memperbarui biaya/ketersediaan yang dikembalikan supplier, tidak menimpa harga jual atau batas biaya owner. SKU yang hilang dari response belum otomatis dinonaktifkan; owner harus memeriksa katalog.
- Batas biaya Digiflazz (`max_price`) disimpan pada snapshot order dan tidak boleh melebihi harga jual.
- `kirimulang` hanya memakai hasil yang sudah tersimpan; tidak membeli produk supplier atau mengambil stok baru. Hanya job selesai/dead yang dapat dijadwalkan ulang, bukan job aktif.
- `rekap` menunjukkan pembayaran bruto dan jumlah terkirim, bukan laba bersih atau settlement bank.

## Jaminan transaksi dan batasnya

- Order, stok reservasi, snapshot harga, event inbox, jobs, dan message outbox disimpan di PostgreSQL.
- Pembayaran tidak ditentukan dari screenshot/pesan pelanggan. Callback mengantrekan pengecekan status melalui API provider yang terautentikasi.
- Validasi reference, payment request ID, amount, dan currency sebelum fulfillment.
- Callback duplikat tidak mengalokasikan produk kedua; status paid tidak diturunkan oleh callback lama.
- Reservasi berumur 15 menit memicu permintaan cancel pada provider saat polling; **bukan janji bahwa QR pasti mati tepat pada menit ke-15**. Stok baru dilepas setelah status terminal terkonfirmasi. Jika provider tidak dapat cancel/diakses, stok tetap ditahan.
- Pembayaran terlambat tetap dicatat sukses; jika stok tidak tersedia, masuk review owner, tidak mengambil stok reservasi pelanggan lain.
- Timeout setelah create QR tidak memicu create ulang. Dokumentasi V3 yang dipakai menyediakan GET by ID, bukan lookup reference yang kami asumsikan tersedia. Jika request ID hilang, callback dengan request ID dapat memulihkan mapping melalui GET; owner juga dapat menggunakan `cekbayar` dengan ID dari dashboard. Sampai terverifikasi, order/stok masuk review.
- Supplier pending/timeout diperiksa dengan `ref_id` order yang sama. Tidak membuat ref_id baru. Gagal sesudah payment sukses perlu penanganan/refund manual.
- Job memakai lease 120 detik dan exponential backoff; setelah 10 kegagalan menjadi `DEAD`. Jobs yang menunggu status pending dipolling tiap 30 detik tanpa menghabiskan retry budget.
- WhatsApp offline tidak memblokir webhook; pengiriman tertahan dapat dicoba kembali. NOTIFY yang sudah dead tidak otomatis hidup ketika reconnect; owner perlu `kirimulang` untuk hasil order atau pemeriksaan operasional.
- **Exactly-once delivery WhatsApp tidak dijamin.** Kegagalan jaringan setelah pesan terkirim dapat menyebabkan pengiriman ulang dengan message ID stabil. Stok/alokasi tetap sama.
- Command dan payload outbox disimpan terenkripsi. Mode simulation tetap jangan dipakai untuk menguji rahasia produksi.

## Verifikasi

```bash
npm test
npm run typecheck
npm run build
npm run demo
npm audit --omit=dev
```

Tes default menggunakan PGlite dan tidak memerlukan Docker. Tes dapat memakai PostgreSQL asli melalui `TEST_DATABASE_URL`, hanya host localhost dan database khusus `yoshstore_test` diterima. Setiap fixture membuat schema unik; pakai database disposable, bukan database toko. Schema fixture tidak dihapus otomatis.

Area tes: otorisasi owner/customer, PN/LID, penguncian stok, inbound replay, signature/token webhook, callback duplikat, nominal berbeda, status tidak berurutan, cancel/timeout/late payment, recovery request ID, supplier pending, outbox retry, dan restart application service.

### Checklist sebelum menerima pelanggan

- [ ] Pairing dan balasan WhatsApp nyata, termasuk identitas owner PN/LID.
- [ ] Approval Xendit untuk kategori produk dan QRIS merchant Indonesia; konfirmasi biaya.
- [ ] Request QRIS sandbox, gambar QR, event Payments V3 dan GET status cocok kontrak akun.
- [ ] Nominal/status terminal, expiry/cancel, callback berulang, dan timeout diuji di sandbox provider.
- [ ] Digiflazz testing sesuai SKU, tujuan, signature, pending, success dan failure.
- [ ] Nomor owner berbeda dari nomor bot dan tidak ada akses owner dari akun lain.
- [ ] HTTPS webhook, firewall, rate limiting proxy, backup database, encryption key dan auth session.
- [ ] Restart/recovery dan refund manual diuji operator.
- [ ] Source produk dan hak distribusi sudah sah; tidak menjanjikan sharing akun yang dilarang provider.

Tidak ada klaim dukungan pembayaran Malaysia/cross-border pada MVP. QRIS dan IDR tetap fokus merchant Indonesia.

## Struktur dan operasional

`src/store.ts`: transaksi database; `src/service.ts`: lifecycle order; `src/commands.ts`: command/akses; `src/providers/`: integrasi; `src/http.ts`: authenticated inbox; `src/worker.ts`: jobs; `src/whatsapp.ts`: koneksi; `src/schema.sql`: migration awal.

Jangan mengganti `STOCK_KEY` pada database yang sudah berisi stok/jobs: data lama tidak akan dapat didekripsi. Backup key dan database bersama secara aman, di luar repository. Perubahan migration awal pada database existing ditolak checksum; tambahkan migration versioned untuk upgrade berikutnya, jangan menghapus volume agar aplikasi bisa start.

Tidak ada commit atau branch dibuat otomatis. Tidak ada saldo pelanggan, rental multi-bot, dashboard, atau broadcast dalam MVP.

## Keamanan repository

- `.env`, sesi WhatsApp, data lokal, backup, log, dependency, dan hasil build dikecualikan melalui `.gitignore`.
- Dokumen handoff percakapan pribadi (`docs/SESSION-HANDOFF-*.md`) tetap lokal dan tidak ikut Git. Jangan memakai `git add -f` untuk memasukkannya tanpa meninjau data pribadi di dalamnya.
- `.env.example` adalah template yang boleh di-track, bukan tempat menyimpan credential. Password Compose adalah contoh development, bukan password produksi.
- Periksa `git status` dan perubahan yang akan di-commit sebelum push. `.gitignore` tidak melindungi rahasia yang ditempel ke source atau yang sudah pernah di-commit.
- Jika credential terlanjur terpublikasi, cabut/rotasi di provider; sekadar menghapus file dari commit berikutnya tidak cukup.

Dokumentasi teknis tambahan:

- [Desain MVP](docs/superpowers/specs/2026-10-12-yoshstore-mvp-design.md)
- [Rencana implementasi dan catatan verifikasi](docs/superpowers/plans/2026-10-12-yoshstore-mvp.md)

## Dokumentasi provider

- https://docs.xendit.co/apidocs/create-payment-request.md
- https://docs.xendit.co/apidocs/get-payment-request.md
- https://docs.xendit.co/apidocs/cancel-payment-request.md
- https://developer.digiflazz.com/api/buyer/topup/
- https://developer.digiflazz.com/api/buyer/webhook/
- https://baileys.wiki/docs/intro/
