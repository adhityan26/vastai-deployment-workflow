# Instance Runtime — Design Spec

Sub-project 1 dari 4 untuk `vast-comfy`. Status: **draft, menunggu review**.

## 1. Ringkasan

Layanan generate gambar (lalu video dan 3D) dari GPU sewaan Vast.ai yang hemat biaya.
Tahap awal pribadi (private), nanti dibuka ke tim 3PB lewat Discord.
Sub-proyek ini mencakup semua yang berjalan **di dalam instance Vast**: bootstrap, profil model, agent
(panel + idle watcher), failsafe, dan kontrak yang dikonsumsi watchdog/bot di homelab.

Tujuan utama: **tidak ada skenario GPU menyala dan menagih tanpa terpantau.**

### Peta sub-proyek

| # | Sub-proyek | Status |
|---|---|---|
| 1 | Instance runtime (dokumen ini) | spec |
| 2 | Watchdog + notifikasi (homelab) | belum |
| 3 | Bot Discord + halaman web generate (homelab) | belum |
| 4 | Profil video dan 3D, role tim | belum |

Urutan 1 → 2 → 3 → 4. Sub-proyek 2 dan 3 bergantung pada kontrak API di bagian 6.

## 2. Keputusan yang sudah diambil

| Topik | Keputusan |
|---|---|
| Instance | 24 GB VRAM, **on-demand**, disk 40 GB, batas ~$0.5/jam |
| Siklus hidup | **Destroy setelah dipakai** (tidak pernah stop). Storage ikut hilang. |
| Pengiriman kode | **A:** image ComfyUI Vast + `bootstrap.sh` dari git (commit dipin). **B** (Docker image sendiri) dipakai sebelum rilis ke tim. Kontrak API tidak boleh berubah antara A dan B. |
| Repo | **Publik** di GitHub. Tidak boleh ada rahasia di repo. |
| Jaringan | **Tailscale userspace**, auth key ephemeral + tag, `tailscale serve` ke 127.0.0.1. Tanpa port publik. Cadangan: SSH tunnel, Cloudflare Tunnel. |
| Idle | Idle = antrean ComfyUI (running + pending) kosong. Peringatan menit ke-20, destroy menit ke-30. Peringatan 10 menit sebelum failsafe. |
| Failsafe | Default 3 jam, **batas mutlak 6 jam**, tidak peduli ada job aktif. |
| Heartbeat | **Pull:** watchdog memanggil `/status` tiap 3 menit. Instance tidak punya kredensial ke homelab. |
| Hasil gambar | Tidak ada API output di agent. Bot homelab membaca dari ComfyUI (`/history`, `/view`) lewat Tailscale. Generate dari browser **tidak disimpan**. |
| Workflow | Template bawaan dari repo. Workflow buatan pengguna disinkron lewat `PUT /workflows/{nama}`, **timpa saja** (tanpa `.bak`). |
| Extend | Idle dan failsafe, dibatasi `hard_cap`. |

## 3. Non-goals (v1)

- Endpoint instalasi profil saat instance berjalan (`POST /profiles/.../install`). Profil hanya dipasang saat boot.
- Auto-interrupt job macet. Failsafe 3 jam sudah melindungi.
- Versi workflow dan `.bak`.
- Bot, watchdog, halaman web generate (sub-proyek 2–3).
- Profil video/3D (sub-proyek 4). Format YAML disiapkan, isinya belum.
- Multi-user, role, anggaran.

## 4. Spike wajib sebelum implementasi

Hasil spike dapat mengubah desain di bagian 5. Dikerjakan berurutan; tiap spike punya kriteria lulus dan cadangan.

| # | Spike | Lulus jika | Kalau gagal |
|---|---|---|---|
| S1 | **Isi image ComfyUI bawaan Vast** | Diketahui: supervisord yang sudah berjalan, port yang dipakai, proxy/portal publik, ComfyUI-Manager. Semuanya bisa dinonaktifkan lewat env/config. | Pakai image dasar CUDA polos dengan supervisord sendiri (mendekatkan ke pilihan B). |
| S2 | **Tailscale userspace + `tailscale serve`** | Laptop di tailnet membuka `http://<node>:8188` dan port agent. Tidak ada port publik (`vastai show instance` + scan eksternal). | SSH tunnel, atau Cloudflare Tunnel + Access. |
| S3 | **Qwen-Image 2.1 GGUF + text encoder** | Satu gambar benar dihasilkan dengan GGUF Q4_K_M dan encoder (int8 atau lain) di ComfyUI. Repo sumber model terverifikasi (`abenzerps/...` vs mirror `0xSojalSec/...`). Ukuran total tercatat. | Ganti kuantisasi/encoder, atau model lain. Catat di `profiles/image.yaml`. |
| S4 | **Destroy dari dalam instance** | `CONTAINER_API_KEY` bisa destroy instance sendiri, lewat `vastai` CLI atau `curl`. Variabel tersedia untuk proses yang dijalankan `onstart`. | Pakai metode yang berhasil; kalau keduanya gagal, desain failsafe ditinjau ulang. |

## 5. Arsitektur di dalam instance

### 5.1 Proses

```
failsafe.sh          (berdiri sendiri, dimulai paling awal)
supervisord
 ├─ tailscaled       (userspace networking)
 ├─ agent            (Python/FastAPI, 127.0.0.1:8189)
 └─ comfyui          (127.0.0.1:8188)
```

Tiga lapisan pengaman independen: **failsafe** (lokal), **idle watcher** (di agent), **watchdog eksternal** (homelab).

### 5.2 Alur boot (`bootstrap.sh`)

Urutan sengaja menempatkan pengaman sebelum hal yang bisa gagal.

1. Simpan `CONTAINER_ID` dan `CONTAINER_API_KEY` ke file root-only (mode 600) karena variabel bisa hilang di sesi lain.
2. Tulis `deadline` (boot+3 jam) dan `hard_cap` (boot+6 jam) **hanya jika file belum ada** (tahan restart container). Penulisan atomik: tulis ke file sementara, lalu `rename`.
3. Jalankan `failsafe.sh`.
4. Jalankan `supervisord` (disesuaikan dengan hasil S1).
5. **Naikkan Tailscale** dan `tailscale serve` untuk port 8188 dan 8189. Gagal → state `failed`, boot berhenti.
6. Jalankan `agent` (state `booting`, lalu `downloading`).
7. Pasang node (ComfyUI-GGUF dan node profil, commit dipin). ComfyUI-Manager **tidak dipasang/dinonaktifkan**.
8. Unduh model profil jika belum ada.
9. Jalankan ComfyUI `--listen 127.0.0.1`, salin workflow bawaan.
10. State `ready` saat ComfyUI menjawab.

State: `booting → downloading → ready → idle-warning → stopping`; `failed` (+alasan) dan `destroy_failed` di titik mana pun.

### 5.3 `failsafe.sh`

- Loop tiap 30 detik. Membaca `deadline`; **`hard_cap` dibaca sekali saat mulai dan disimpan di memori** (file tidak dipercaya setelahnya).
- Jika `min(deadline, hard_cap)` terlewati → destroy, **tanpa memedulikan job aktif**.
- File `deadline` tidak terbaca/korup → jatuh ke `hard_cap`, bukan "tidak pernah".
- API Vast tidak terjangkau → coba lagi tiap 30 detik terus-menerus, buat penanda `destroy_pending`, matikan ComfyUI.
- Destroy idempoten: 404/"already gone" dianggap sukses.
- Sumber waktu: monotonic/`/proc/uptime`.
- Menulis pid ke file; `/status` melaporkan `failsafe_alive`.

### 5.4 Idle watcher (di agent)

- `last_active` disimpan di file; setelah agent restart dipakai `max(last_active, sekarang saat antrean tidak kosong)`.
- Antrean berisi → `last_active` diperbarui. Antrean kosong 20 menit → state `idle-warning`. 30 menit → destroy.
- Peringatan sebelum failsafe 10 menit dilaporkan lewat `/status` (`failsafe_at`) agar bot bisa memperingatkan.

## 6. Kontrak agent API (`127.0.0.1:8189`, diteruskan `tailscale serve`)

Token bearer per instance, dibuat oleh bot, dikirim lewat env var Vast. Semua perintah mengubah-sesuatu adalah **POST + token**.

| Endpoint | Fungsi |
|---|---|
| `GET /health` | Hidup/tidak (lokal, tanpa token) |
| `GET /status` | `state`, `reason`, progres download, `uptime_s`, `boot_at`, `idle_at`, `failsafe_at`, `hard_cap_at`, `queue {running, pending}`, `gpu {util, vram}`, `profile`, `commit`, `failsafe_alive`, `destroy_attempts`, `destroy_last_error` |
| `POST /extend` `{kind: idle \| failsafe, minutes}` | Menunda deadline. Hanya mengubah `deadline` (atomik), **tidak pernah `hard_cap`**. Melewati `hard_cap` ditolak dengan pesan batasnya. |
| `POST /destroy` `{reason}` | Destroy via Vast dengan retry/backoff (~5 percobaan/10 menit), balas `202`. Idempoten. |
| `GET /workflows`, `GET /workflows/{nama}` | Daftar (dengan waktu ubah) dan isi |
| `PUT /workflows/{nama}` | Timpa. `nama` divalidasi (tanpa path traversal), JSON valid, ukuran maksimum 1 MB. |

Halaman panel: satu file HTML statis yang membaca `/status`, dengan tombol Extend dan Destroy. Token diminta sekali dan disimpan di `sessionStorage`.

### Output generate
Tidak lewat agent. Bot membaca dari ComfyUI (`/history`, `/view`) di port 8188 lewat Tailscale, sesuai mode (`normal`, `save`, `silent`; sub-proyek 3).

## 7. Kontrak untuk watchdog (sub-proyek 2)

Instance **tidak** mengirim apa pun ke homelab. Watchdog wajib:

1. Memanggil `/status` tiap 3 menit.
2. Menghancurkan instance (dengan key utama) bila: `/status` tidak terjangkau 15 menit berturut-turut padahal Vast `running`; state `failed`; `failsafe_alive` = false; **tidak `ready` dalam 25 menit sejak dibuat** (batas boot, bisa dikonfigurasi); umur instance melewati **6 jam menurut `start_date` Vast** (penegakan batas mutlak oleh sumber waktu independen).
3. Alert mendesak ke Discord bila destroy gagal, diulang tiap 5 menit sampai instance hilang dari daftar. Isi alert: ID instance, penyebab, `vastai destroy instance <id>`, link konsol.
4. Menarik/memulihkan workflow lewat `GET`/`PUT /workflows`.
5. Menganggap instance yang tidak dikenal (dibuat manual) sebagai anomali.

## 8. Profil

File `instance/profiles/<nama>.yaml`. Profil adalah **konsep proyek ini**, bukan fitur ComfyUI.

```yaml
name: image
requires: { vram_gb: 24, disk_gb: 40 }
nodes:
  - repo: city96/ComfyUI-GGUF
    commit: <hash>
models:
  - file: <nama file>
    repo: <sumber HF>        # diverifikasi di S3
    revision: <hash>
    dest: models/diffusion_models/
    size_bytes: <ukuran>
workflows: [<nama>.json]
```

Aturan unduh: lewati bila file ada dengan ukuran cocok; unduh ke `.part` lalu rename; verifikasi ukuran (dan checksum bila tersedia); retry 3x dengan backoff; cek ruang disk sebelum mulai; token HF opsional via env. Profil video/3D nanti = file YAML baru.

## 9. Keamanan

- Tanpa port publik; verifikasi lewat `vastai show instance` dan scan eksternal (bagian 11).
- ComfyUI tidak punya login → **ACL Tailscale** membatasi `tag:gpu` port 8188 dan 8189 hanya untuk perangkat pemilik dan homelab.
- Auth key Tailscale: sekali pakai, ephemeral, ber-tag, kedaluwarsa ~1 jam. Token bearer per instance. Keduanya terlihat di UI/API Vast lewat env; dampak dibatasi oleh sifat sekali pakai dan umur instance.
- Custom node berjalan sebagai root dan bisa membaca semua rahasia di instance. Mitigasi: semua node dipin pada commit, tanpa ComfyUI-Manager.
- Repo publik: **tidak ada rahasia di repo**; `.gitignore` mencakup `.env` dan file kredensial.
- `PUT /workflows`: validasi nama, JSON, ukuran.
- `CONTAINER_API_KEY` hanya bisa start/stop/destroy instance sendiri (terverifikasi di dokumentasi Vast); cakupan pastinya diuji di S4.

## 10. Penanganan error

| Kejadian | Perilaku |
|---|---|
| Tailscale/node/ComfyUI gagal saat boot | State `failed` + alasan. **Tanpa retry otomatis** (retry memakan waktu GPU berbayar). Failsafe tetap jalan. Watchdog alert. |
| Download gagal (jaringan, rate limit, disk, ukuran) | Retry 3x dengan backoff, lalu `failed` dengan alasan. |
| Agent crash | `supervisord` restart. Crash terus-menerus → watchdog (15 menit tak terjangkau). |
| Destroy gagal | Retry; lalu `destroy_failed`, ComfyUI dimatikan; watchdog mencoba dengan key utama; alert berulang ke Discord. |
| Container restart | `deadline`/`hard_cap` tidak ditimpa; batas mutlak juga ditegakkan watchdog dari `start_date`. |
| `deadline` korup/setengah tulis | Failsafe jatuh ke `hard_cap`. |
| Tiga pihak destroy bersamaan | Idempoten; 404 dianggap sukses. |

## 11. Pengujian

**Lokal (tanpa GPU):**
- Agent dengan jam palsu: hitungan idle, peringatan menit ke-20, destroy menit ke-30, extend, penolakan di atas `hard_cap`, state idle bertahan setelah restart agent.
- `failsafe.sh` dengan stub API Vast dan deadline berdurasi detik: agent mati, job aktif, API tak terjangkau, `deadline` korup, container restart (file tidak ditimpa).
- Kontrak API (`/status`, `/extend`, `/destroy`, `/workflows`) dengan model dummy kecil; validasi nama workflow.
- `bootstrap.sh` di Docker lokal dengan profil dummy.
- Destroy bersamaan dari tiga pelaku.
- Timeout boot saat download.

**Nyata di Vast (kecil dan murah), setelah S1–S4 lulus:**
1. Boot penuh profil `image`: waktu sampai `ready` tercatat, ComfyUI dibuka dari laptop lewat Tailscale, satu gambar dihasilkan.
2. Uji pengaman dengan deadline dipendekkan (idle 3 menit, failsafe 10 menit): matikan agent, blokir API, matikan failsafe (watchdog harus bertindak).
3. Verifikasi di konsol Vast: instance hilang dan tagihan berhenti.
4. Verifikasi tidak ada port publik atau tunnel portal.

## 12. Kriteria selesai

- Satu perintah dari instance baru sampai `ready`, waktu boot tercatat.
- Gambar bisa dibuat dari browser laptop lewat Tailscale.
- Idle 30 menit dan failsafe 3 jam menghancurkan instance, terbukti di konsol Vast.
- Setiap baris di bagian 10 punya tes.
- S1–S4 lulus atau cadangannya terpilih dan tercatat.

## 13. Struktur repo (monorepo, publik)

```
instance/               # sub-proyek 1: jalan di Vast
  bootstrap.sh
  failsafe.sh
  supervisord.conf
  agent/                # Python/FastAPI
  profiles/image.yaml
  workflows/
apps/                   # sub-proyek 2-3: jalan di homelab
  core/                 #   modul generate bersama (workflow + submit + hasil + mode)
  watchdog/             #   proses kecil, berdiri sendiri
  bot/                  #   bot Discord
  web/                  #   halaman generate untuk HP
contracts/              # skema /status dan API agent (satu sumber kebenaran)
docs/superpowers/       # spec dan plan per sub-proyek
```

Aturan repo publik: **tidak ada rahasia di repo**. Token Discord, API key Vast, auth key Tailscale,
token agent, ID user/role, dan alamat homelab hanya ada di `.env` atau file konfigurasi lokal yang
di-`.gitignore`. Yang di-commit hanya `*.example` berisi placeholder. `.env` di-ignore sejak commit pertama
dan dipasang pemeriksaan rahasia sebelum commit (lihat `scripts/check-secrets.sh`).

## 14. Konfigurasi dan rahasia

Tujuan: pemilik selalu tahu **config apa** dan **API key apa** yang dipakai, dan mudah merawatnya.

1. **Satu skema config**: `contracts/config-schema.yaml`. Tiap key punya: `name`, `component` (instance/agent, instance/failsafe, apps/watchdog, apps/bot, ...), `secret` (ya/tidak), `required`, `default`, `description`. Skema adalah satu-satunya daftar key yang sah.
2. **Satu loader per komponen** (mis. `instance/agent/config.py`, `apps/core/config.py`). Kode tidak membaca `os.environ` langsung; semua lewat loader.
3. **Loader membaca dari file config**, bukan dari environment proses.
   - Homelab: `config.env` lokal, di-`.gitignore`.
   - Instance: Vast hanya meneruskan konfigurasi lewat env var saat instance dibuat, jadi `bootstrap.sh` menulis env itu ke satu file config **root-only (mode 600)** pada langkah pertama boot. Agent dan failsafe membaca dari file itu.
4. **Fail fast**: key wajib kosong atau key di luar skema menghentikan program saat start dengan pesan yang menyebut nama key. Nilai `secret: true` tidak pernah dicetak di log (ditampilkan sebagai `***`).
5. **`config.example` dihasilkan dari skema** dan satu-satunya yang di-commit. Perintah `--list-config` (atau skrip) mencetak semua key, pemakainya, dan mana yang rahasia.
6. **Pemeriksaan rahasia**: `.gitignore` mencakup `.env`, `.env.*`, `config.env`, `*.key`, `*.pem`; hook `pre-commit` (`.githooks/`, `scripts/check-secrets.sh`) menolak file config/rahasia yang ter-stage dan menjalankan `gitleaks protect --staged`.

### Daftar awal key (diperbarui di skema, bukan di sini)

| Key | Pemakai | Rahasia |
|---|---|---|
| `VAST_API_KEY` (key utama) | apps/watchdog, apps/bot | ya |
| `CONTAINER_ID`, `CONTAINER_API_KEY` | instance/failsafe, instance/agent (disuntik Vast) | ya |
| `AGENT_TOKEN` | instance/agent, apps (dibuat per instance) | ya |
| `TS_AUTHKEY` | instance/bootstrap (sekali pakai) | ya |
| `TS_API_CREDENTIAL` | apps (membuat auth key) | ya |
| `HF_TOKEN` | instance/bootstrap (opsional) | ya |
| `DISCORD_BOT_TOKEN` | apps/bot, apps/watchdog | ya |
| `DISCORD_ADMIN_USER_IDS`, `DISCORD_ALERT_TARGET` | apps | tidak |
| `PROFILE`, `IDLE_MINUTES`, `IDLE_WARN_MINUTES`, `FAILSAFE_HOURS`, `HARD_CAP_HOURS`, `BOOT_TIMEOUT_MIN` | instance dan apps | tidak |
| `OUTPUT_DIR`, `WATCHDOG_INTERVAL_S` | apps | tidak |

## 15. Pertanyaan terbuka

- Nilai pasti batas boot (default 25 menit) dan apakah perlu bergantung pada kecepatan host.
- Strategi menjalankan `onstart` (batas panjang dan perilaku run-ulang belum terverifikasi); alternatif `PROVISIONING_SCRIPT`. Ditentukan setelah S1.
- Cara pengguna tim menjangkau ComfyUI/halaman web saat rilis (sub-proyek 3–4), karena ACL saat ini hanya untuk pemilik.
