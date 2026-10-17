# Antarmuka web: kontrol instance dan generate gambar (sub-proyek 3a)

Status: **draf untuk direview**. Ditulis saat pemilik proyek tidak bisa dihubungi; semua yang bertanda **[Keputusan saya]** adalah tebakan yang bisa dikoreksi, bukan kesepakatan. Hanya bagian "Dari pemilik" yang berasal dari percakapan.

## 1. Tujuan dan alasan

Dari pemilik (percakapan sebelumnya): generator gambar privat di GPU sewaan Vast.ai yang hemat karena dipakai sesekali; instance dihancurkan setelah dipakai; akses privat lewat Tailscale; halaman generate yang nyaman dari HP; Discord menyusul belakangan; model diunduh per profil; tanpa config hardcode; bot/web nanti dipakai tim ("3PB"), tetapi **mulai dari pemilik sendiri**. Perintah terbaru: "bikin web interface dulu aja" (sebelum bot Discord).

Alasan: tanpa antarmuka, instance hanya bisa dikendalikan lewat CLI. Web membuat siklus lengkap bisa dijalankan dari HP: **nyalakan GPU → tunggu siap → generate → matikan**, dengan biaya dan sisa waktu terlihat.

Ini juga menjadi **Task 13** (boot end-to-end nyata): tombol Start di web adalah pembuat instance sungguhan pertama.

### Sukses berarti
- Dari HP (tanpa Tailscale terpasang) pemilik menekan Start, menunggu progres, mengetik prompt, memilih kualitas, dan melihat gambar, lalu menekan Destroy.
- Tidak ada cara dari web untuk membuat instance berjalan tanpa batas: semua pengaman instance (failsafe, idle, hard cap) tetap berlaku dan tidak bisa dilewati web.
- Tidak ada rahasia di repo atau di browser.

### Non-goal
- Bot Discord, watchdog, role tim (sub-proyek 2, 3b, 4).
- Penyimpanan hasil: gambar **tidak disimpan** di server (spec bagian 2); hanya ada di sesi browser.
- Video dan 3D.
- Banyak instance paralel: **satu instance aktif sekaligus**.

### Anti-goal (gagal walau secara teknis jalan)
- Instance terlupa menyala karena web gagal menghancurkan atau salah menampilkan status.
- Browser atau halaman memegang `VAST_API_KEY`, token agent, atau kredensial Tailscale.
- Halaman bisa diakses publik tanpa login.

## 2. Bentuk sistem

Satu layanan Node.js/TypeScript di homelab (container Docker, `apps/web`), memakai modul bersama `apps/core`. Browser hanya bicara ke layanan ini; **browser tidak pernah menjangkau instance langsung** (HP tidak perlu Tailscale, dan token agent tidak pernah keluar dari homelab).

```
HP / laptop --HTTPS--> apps/web (homelab) --Vast API-----> Vast (cari, buat, hancurkan)
                                          --tailnet-----> instance:8189 agent (/status, /extend, /destroy)
                                          --tailnet-----> instance:18188 ComfyUI (/prompt, /history, /view)
```

`apps/core` (dipakai ulang bot dan watchdog kelak): modul `config` (satu-satunya pembaca env), klien Vast, klien Tailscale (buat auth key), klien agent, klien ComfyUI, registri instance, dan orkestrasi siklus hidup. Kode di `apps/web` hanya HTTP + UI.

## 3. Fitur

1. **Kartu status** (polling `/status` tiap beberapa detik): state (booting, downloading + persen, ready, idle-warning, stopping, failed), uptime, sisa waktu idle/failsafe/hard cap, antrean, VRAM, estimasi biaya berjalan (harga per jam dari penawaran × uptime).
2. **Start**: hanya bila tidak ada instance aktif. Memilih penawaran termurah yang memenuhi filter (config: GPU yang diizinkan, VRAM minimum, harga maksimum per jam, unduhan minimum, reliabilitas), membuat instance sesuai kontrak spec 7.2 (env, `--onstart-cmd`, tag, hostname unik), mencatat di registri, lalu menampilkan progres. Tombol memunculkan perkiraan biaya sebelum konfirmasi.
3. **Generate**: kolom prompt, **preset kualitas**, rasio/ukuran, seed (acak atau diisi). Hasil muncul sebagai gambar yang bisa diunduh; riwayat hanya selama sesi browser.
4. **Preset kualitas**: `preview` 10 langkah, `standard` 25, `high` 40 (usulan pemilik). Didefinisikan **di profil** (`instance/profiles/image.yaml`: `quality_presets` dan pemetaan parameter ke node workflow), bukan di kode. Kualitas 10 langkah dengan sampler `euler` belum diuji; preview boleh memakai ukuran lebih kecil bila perlu.
5. **Extend** idle/failsafe (melewati `hard_cap` ditolak agent) dan **Destroy** dengan konfirmasi.
6. **Pesan jelas** untuk keadaan gagal (`failed` + alasan, `destroy_failed`), dan peringatan menonjol bila instance masih jalan tetapi agent tidak terjangkau.

## 4. Keputusan desain

**[Keputusan saya] Akses dan login.** Layanan hanya dipublikasikan lewat satu jalur yang dipilih pemilik (lihat pertanyaan 1). Untuk tahap pemilik sendiri: satu kredensial (password atau token dari `.env`, di-hash) dengan sesi cookie `HttpOnly`; tanpa akun pengguna. Peran admin/anggota ditunda ke sub-proyek 4. Authentik SSO (sudah ada di homelab) adalah jalur naik kelas untuk tim.

**[Keputusan saya] Proxy generate.** Backend menerima `{prompt, preset, ukuran, seed}`, mengisi workflow dari berkas profil (tidak ada parameter bebas dari browser selain yang diizinkan), mengirim ke ComfyUI, mengikuti `/history` atau websocket, dan mengalirkan gambar dari `/view`. Browser tidak bisa mengirim workflow sembarang.

**[Keputusan saya] Satu instance.** Registri berisi paling banyak satu instance aktif; Start ditolak bila ada. Registri berupa berkas JSON di volume homelab sesuai `contracts/instance-registry.schema.json`.

**[Keputusan saya] Auth key Tailscale.** Sesuai S5: dibuat otomatis lewat OAuth client (scope `auth_keys`, tag `tag:gpu`, sekali pakai, ephemeral, kedaluwarsa pendek). Sampai OAuth client dibuat, tahap awal boleh membaca key sekali pakai dari berkas lokal homelab (hanya untuk uji Task 13).

**[Keputusan saya] Pengaman.** Web hanya membuat dan menghancurkan; ia tidak mematikan failsafe, tidak menaikkan `hard_cap`, dan setiap Start mengirim nilai `FAILSAFE_HOURS`, `HARD_CAP_HOURS`, `IDLE_MINUTES` dari config. Bila Destroy dari web gagal, status `destroy_failed` ditampilkan dan percobaan diulang; instance tetap dilindungi failsafe-nya sendiri.

**[Keputusan saya] Teknologi.** Node 20+ TypeScript, Fastify untuk API, UI satu halaman tanpa kerangka berat (HTML + TypeScript kecil, responsif, bisa di-"Add to Home Screen"), pengujian dengan Vitest dan server palsu untuk Vast, agent, dan ComfyUI. Semua config lewat `contracts/config-schema.yaml` (komponen `apps`) dan modul `config` di `apps/core`; lint `scripts/check_config_usage.py` berlaku untuk `.ts`. Kontrak API web ditulis di `contracts/` (OpenAPI) seperti kontrak agent.

## 4b. Keputusan kecil setelah builder check (semua **[Keputusan saya]**)

- **Default pencarian penawaran:** 1 GPU, VRAM >= 24 GB (sesuai `requires` profil), disk 40-50 GB, unduhan >= 500 Mbps, reliabilitas > 0,98, verified, harga maksimum default $0,50/jam; daftar GPU yang diizinkan kosong berarti semua yang memenuhi syarat (S3 memakai RTX A5000). Semua nilai di schema `apps`, bukan di kode. Image: `vastai/comfy:v0.41.0-cuda-12.9-py312` (S1).
- **Commit yang dideploy:** `REPO_COMMIT` dibaca dari config (diisi pemilik atau skrip rilis dengan `git rev-parse` dari commit yang **sudah di-push**); web tidak menebak HEAD.
- **Skema profil untuk generate:** profil mendapat bagian `generate: {workflow: <berkas>, params: {prompt|steps|width|height|seed: {node, input}}, quality_presets: {nama: {steps, ...}}, sizes: [...]}`. Perubahan ini menyentuh `instance/agent/vastcomfy_agent/profile.py`, kontrak, dan tes dalam satu commit (spec bagian 15). Web membaca profil dari checkout repo lokal pada commit yang sama dengan yang dideploy, bukan dari instance. Nilai preset boleh disetel pembangun setelah uji kualitas.
- **Estimasi biaya:** harga per jam penawaran x horizon `FAILSAFE_HOURS` (batas atas), plus catatan bahwa penyimpanan ditagih terpisah per jam selama instance ada; angka berjalan memakai uptime aktual.
- **Pemulihan:** Start menulis catatan `pending` di registri **sebelum** memanggil Vast; saat web hidup (dan tiap beberapa menit) ia mencocokkan registri dengan `vastai show instances` (label/tag proyek). Instance tak dikenal ditampilkan dengan peringatan dan tombol Destroy; tidak ada adopsi otomatis.
- **Penegakan oleh web (sampai watchdog ada):** loop ringan di `apps/core` menghancurkan instance bila boot melewati batas (25 menit) atau agent tak terjangkau melewati batas konfigurasi; ini tidak menggantikan watchdog (sub-proyek 2).
- **Konfigurasi baru:** kunci `apps` ditambahkan ke `contracts/config-schema.yaml` (`VAST_API_KEY`, hash password web, rahasia sesi, filter penawaran, batas waktu); lint `scripts/check_config_usage.py` sudah mendukung berkas `.ts`.
- **Cara menjangkau tailnet dari homelab:** bergantung jawaban pertanyaan 2; bila container perlu `tailscaled` sendiri (userspace), klien HTTP di `apps/core` memakai proxy lokalnya.

## 5. Keamanan

- `VAST_API_KEY` dan kredensial OAuth Tailscale hanya di `.env` homelab (di-`.gitignore`), tidak pernah ke browser atau ke instance.
- Token agent per instance dibuat acak oleh web, disimpan di registri homelab, dikirim ke instance lewat env, dan tidak pernah dikirim ke browser.
- Browser tidak bisa menjangkau ComfyUI atau agent; hanya endpoint web yang diizinkan.
- ACL Tailscale: node homelab perlu izin ke `tag:gpu` port 18188 dan 8189 (ACL saat ini hanya mengizinkan perangkat anggota; node homelab harus anggota tailnet yang sama atau diberi tag/aturan sendiri).
- Rate limit pada Start/Generate; batas ukuran prompt; ukuran gambar dibatasi oleh preset di profil.

## 6. Kegagalan yang harus ditangani
Vast tidak punya penawaran sesuai filter; pembuatan instance gagal; instance `running` tetapi Tailscale tidak pernah naik (timeout boot lalu destroy); agent tidak terjangkau; ComfyUI error saat generate; Destroy gagal; homelab restart saat instance berjalan (registri dipulihkan dari berkas, status dibaca ulang).

## 7. Diserahkan kepada pembangun
Struktur modul di dalam `apps/`, skema UI persis, pemilihan penawaran di antara kandidat setara, format log, dan pengujian dengan server palsu.

## 8. Pertanyaan untuk pemilik (jawaban mengubah rencana)
1. **Jalur akses:** halaman web dibuka dari HP lewat apa? (a) hanya di jaringan tailnet/rumah (HP butuh Tailscale), (b) domain publik lewat tunnel/reverse proxy dengan login (Authentik atau password), atau (c) lainnya. Ini menentukan cara pemasangan dan model login.
2. **Homelab di tailnet:** apakah host Docker `192.168.88.113` sudah menjadi node Tailscale (maka container cukup HTTP biasa ke nama MagicDNS), atau container web harus menjalankan `tailscaled` sendiri? Boleh diberi tag (mis. `tag:homelab`) dengan izin ke `tag:gpu:18188,8189`?
3. **OAuth client Tailscale:** kamu mau membuatnya (scope `auth_keys`, tag `tag:gpu`) sekarang, atau tahap awal cukup dengan key sekali pakai manual untuk Task 13?
4. **Letak `VAST_API_KEY` (key utama):** boleh disimpan di `.env` homelab untuk layanan ini?

## 9. Urutan kerja yang diusulkan
1. `apps/core`: config, klien Vast/agent/ComfyUI, registri, siklus hidup (dengan server palsu).
2. `apps/web`: API + UI, preset kualitas di profil, kontrak OpenAPI.
3. Task 13 nyata: Start dari web dengan key manual, satu generate, Destroy; catat temuan.
4. Pemasangan di homelab (Docker) sesuai jawaban pertanyaan 1-2.
