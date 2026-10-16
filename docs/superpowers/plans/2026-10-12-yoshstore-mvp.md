# YOSHSTORE MVP Implementation Plan

> Eksekusi lokal mengikuti skill executing-plans dan TDD. Tidak membuat branch, commit, PR, atau transaksi live.

**Goal:** bot satu toko dengan stok sendiri, Digiflazz Buyer, dan Xendit QRIS IDR yang dapat diuji tanpa kredensial produksi.

**Architecture:** satu proses TypeScript dengan HTTP webhook, adapter WhatsApp, application service, PostgreSQL, dan durable worker. Pengiriman dan order persisten serta terpisah dari lifecycle koneksi WhatsApp.

**Tech Stack:** Node.js 22+, TypeScript, Fastify, pg, Baileys, qrcode, Vitest; PGlite untuk integration tests portable, PostgreSQL untuk deployment.

## Global Constraints

- Satu toko, chat pribadi, satu unit per order; semua nominal integer IDR.
- Stok sendiri dan Digiflazz Buyer; tidak ada saldo pelanggan, rental, dashboard, atau refund otomatis.
- Simulasi default; live harus diaktifkan eksplisit dengan konfigurasi lengkap.
- Tidak mencetak atau meminta rahasia di chat. Payload stok terenkripsi; sesi WhatsApp tidak di-track.
- Pisahkan status payment/fulfillment dan adapter provider; jangan klaim exactly-once pesan WhatsApp.
- Jangan membuka public endpoint simulasi pembayaran atau admin.

## File map

- `src/config.ts`, `src/crypto.ts`: validasi mode/konfigurasi dan perlindungan rahasia.
- `src/db.ts`, `src/schema.sql`: PostgreSQL, migration, transactions, indexes/constraints.
- `src/providers/types.ts`, `xendit.ts`, `digiflazz.ts`, `simulation.ts`: kontrak dan integrasi eksternal.
- `src/store.ts`: katalog, reservasi, status order, event inbox, job/outbox.
- `src/service.ts`, `src/commands.ts`: checkout, settlement, fulfillment, akses owner/customer.
- `src/worker.ts`, `src/http.ts`, `src/whatsapp.ts`: eksekusi job, verifikasi webhook, koneksi pesan.
- `src/main.ts`, `src/migrate.ts`, `scripts/demo.ts`: startup, migration dan demo lokal.
- `tests/*.test.ts`, `tests/helpers.ts`: tes unit/integrasi provider fixtures dan database nyata dalam proses.
- `README.md`, `.env.example`, `compose.yaml`: setup dan batas operasional.

## Task 1 — Config dan provider contracts
- [x] Tes config simulation/live, crypto tampering, Xendit request/status normalization, Digiflazz pending/ref_id/max_price.
- [x] Jalankan tes untuk memverifikasi modul belum ada (RED).
- [x] Implementasikan config, crypto, provider adapters dengan fetch timeout dan respons tervalidasi.
- [x] Jalankan tes dan typecheck (GREEN).

## Task 2 — Transaksi database dan layanan order
- [x] Tes reservasi stok, customer ownership, callback mismatch/duplicate, timeout checkout, expiry/late payment, supplier pending, restart recovery.
- [x] Verifikasi RED sebelum membuat implementasi schema/store/service.
- [x] Implementasi transactions, jobs/outbox, reconciliation, dan fulfillment.
- [x] Jalankan tes integrasi database; verifikasi stock allocation hanya sekali.

## Task 3 — Commands, HTTP dan worker
- [x] Tes owner authorization, menu/beli/status/batal, webhook auth, retry, concurrency jobs.
- [x] Verifikasi RED; implementasi router, HTTP inbox, worker dan adapter WhatsApp.
- [x] Jalankan tes; live mode tidak aktif dalam pengujian.

## Task 4 — Bootstrap dan dokumentasi
- [x] Implementasi startup validation, migrations, graceful shutdown, demo end-to-end, Compose dan konfigurasi contoh.
- [x] Jalankan `npm test`, `npm run typecheck`, `npm run build`, `npm run demo`, audit dependensi.
- [x] Catat integrasi yang belum bisa diuji tanpa akun, pairing dan endpoint HTTPS; jangan mengklaim live siap tanpa sandbox verification.

## Bukti verifikasi

- 46 tes source (tanpa duplikasi compiled tests); integration fixture dijalankan dengan PGlite dan PostgreSQL 17 disposable.
- Typecheck/build sukses; demo mengirim dua produk simulasi (stok sendiri dan supplier), bruto IDR 26.000.
- Compiled application startup, health check, batas endpoint simulasi, dan graceful SIGTERM diuji dengan PostgreSQL asli.
- Audit dependensi runtime tanpa temuan saat implementasi.
- Kontrak Xendit diverifikasi dari OpenAPI resmi: header `api-version=2024-11-11`, QR action `QR_STRING`, GET/cancel by ID. Tidak mengasumsikan endpoint list-by-reference yang tidak terdokumentasi.
- Timeout request ID dipulihkan melalui callback terautentikasi atau command owner `cekbayar`, bukan create pembayaran ulang.

## External contract references

- Xendit Payments V3 request: https://docs.xendit.co/apidocs/create-payment-request
- Xendit payment lifecycle: https://docs.xendit.co/docs/payment-statuses
- Xendit capture callback: https://docs.xendit.co/apidocs/payment-succeeded
- Digiflazz Buyer: https://developer.digiflazz.com/api/buyer/topup/
- Digiflazz webhook: https://developer.digiflazz.com/api/buyer/webhook/
- Baileys: https://baileys.wiki/docs/intro/
