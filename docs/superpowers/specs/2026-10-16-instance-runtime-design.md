# Instance Runtime — Design Spec

Sub-project 1 dari 4 untuk `vast-comfy`. Status: **draft v2, menunggu review**.
Riwayat: v1 direview Opus (2x pada versi percakapan, 1x pada file), v2 menerapkan seluruh temuan review file.

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

Urutan 1 → 2 → 3 → 4. Sub-proyek 2 dan 3 bergantung pada kontrak di bagian 6, 7, dan 15.

## 2. Keputusan yang sudah diambil

| Topik | Keputusan |
|---|---|
| Instance | 24 GB VRAM, **on-demand**, disk 40 GB, batas ~$0.5/jam |
| Siklus hidup | **Destroy setelah dipakai** (tidak pernah stop). Storage ikut hilang. |
| Pengiriman kode | **A:** image ComfyUI Vast + `bootstrap.sh` dari git (commit dipin). **B** (Docker image sendiri) dipakai sebelum rilis ke tim. Kontrak API tidak boleh berubah antara A dan B. |
| Repo | **Publik** di GitHub, monorepo. Tidak boleh ada rahasia di repo. |
| Jaringan | **Tailscale userspace**, auth key ephemeral + tag. Tanpa port publik. Cadangan: SSH tunnel, Cloudflare Tunnel. |
| Idle | Idle = antrean ComfyUI (running + pending) kosong. Timer dimulai saat `ready`. Peringatan 10 menit sebelum destroy idle, destroy di menit ke-30. |
| Failsafe | Default 3 jam, **batas mutlak 6 jam**, tidak peduli ada job aktif. |
| Heartbeat | **Pull:** watchdog memanggil `/status` tiap 3 menit. Instance tidak punya kredensial ke homelab. |
| Hasil gambar | Tidak ada API output di agent. Bot homelab membaca dari ComfyUI (`/history`, `/view`) lewat Tailscale. Generate dari browser **tidak disimpan**. |
| Workflow | Template bawaan dari repo. Workflow buatan pengguna disinkron lewat `PUT /workflows/{nama}`, **timpa saja** (tanpa `.bak`). |
| Extend | Idle dan failsafe, dibatasi `hard_cap` dan batas per panggilan. |
| Bahasa | `instance/`: **Python** (agent FastAPI) + shell (bootstrap, failsafe). `apps/`: **Node.js/TypeScript**. Kontrak di `contracts/` menjaga keduanya sinkron. |
| Kegagalan boot | Setelah failsafe aktif, kegagalan boot **menghancurkan instance sendiri** (kecuali `KEEP_ON_FAILURE=true` untuk debugging). |

## 3. Non-goals (v1)

- Endpoint instalasi profil saat instance berjalan. Profil hanya dipasang saat boot.
- Auto-interrupt job macet. Failsafe 3 jam sudah melindungi.
- Versi workflow dan `.bak`.
- Bot, watchdog, halaman web generate (sub-proyek 2–3).
- Profil video/3D (sub-proyek 4). Format YAML disiapkan, isinya belum.
- Multi-user, role, anggaran.

## 4. Spike wajib sebelum implementasi

Urutan: **S4 → S1 → S2 → S3 → S5**. S4 paling murah dan seluruh desain pengaman bergantung padanya.
Hasil spike dapat mengubah desain di bagian 5. Tiap spike punya kriteria lulus dan cadangan.

| # | Spike | Lulus jika | Kalau gagal |
|---|---|---|---|
| S4 | **Destroy dari dalam instance** | `CONTAINER_API_KEY` bisa destroy instance sendiri (via `vastai` CLI atau `curl`), **tidak bisa** menyentuh instance lain, dan masih ada setelah container restart. Variabel tersedia untuk proses yang dijalankan `onstart`. | Pakai metode yang berhasil. Kalau keduanya gagal, desain failsafe ditinjau ulang. |
| S1 | **Isi image ComfyUI bawaan Vast** | Diketahui: supervisord yang sudah berjalan, port yang dipakai, proxy/portal publik, ComfyUI-Manager (semuanya bisa dinonaktifkan). Juga diketahui: apakah `onstart` berjalan ulang saat restart, apakah file di disk bertahan, apa arti `/proc/uptime` di container, dan arti `start_date` Vast. Menjawab pertanyaan terbuka soal `onstart`. | Image dasar CUDA polos + supervisord sendiri (mendekatkan ke pilihan B). |
| S2 | **Tailscale userspace** | Laptop di tailnet membuka `http://<node>:8188` dan port agent. Dicek apakah `tailscale serve` diperlukan atau tailscaled sudah meneruskan ke localhost sendiri di mode userspace. Tidak ada port publik (`vastai show instance` + scan eksternal). Perangkat non-pemilik **ditolak** oleh ACL. Node bergabung ulang setelah restart (state Tailscale di disk persisten). | SSH tunnel, atau Cloudflare Tunnel + Access. |
| S3 | **Qwen-Image 2.1 GGUF + text encoder** | Satu gambar benar dihasilkan dengan GGUF Q4_K_M dan encoder (int8 atau lain). Repo sumber terverifikasi (`abenzerps/...` vs mirror `0xSojalSec/...`). Muat di 24 GB VRAM; waktu per gambar dan waktu download dibandingkan dengan `BOOT_TIMEOUT_MIN`. | Ganti kuantisasi/encoder, atau model lain. Catat di `profiles/image.yaml`. |
| S5 | **Auth key Tailscale otomatis** dan **jaring pengaman di sisi Vast** | Auth key ephemeral, ber-tag, kedaluwarsa pendek bisa dibuat lewat OAuth client (kedaluwarsa minimum dicatat). Dicek juga apakah Vast punya destroy terjadwal di sisi server; jika ada, itu menutup risiko sisa 1. | Auth key dibuat manual/sekali pakai lebih panjang; risiko sisa tetap. |

## 5. Arsitektur di dalam instance

### 5.1 Proses

```
failsafe.sh          (berdiri sendiri, dimulai setelah kredensial tersimpan)
supervisord          (program autostart=false; bootstrap menyalakan via supervisorctl)
 ├─ tailscaled       (userspace networking)
 ├─ agent            (Python/FastAPI, 127.0.0.1:8189)
 └─ comfyui          (127.0.0.1:8188)
```

Tiga lapisan pengaman independen: **failsafe** (lokal), **idle watcher** (di agent), **watchdog eksternal** (homelab).

### 5.2 Direktori state dan kepemilikan file

Semua di `/var/lib/vastcomfy/` (disk container, **bukan tmpfs**, bertahan saat restart container). Konfigurasi di `/etc/vastcomfy/.env` (mode 600).
Aturan umum: **waktu = epoch UTC dalam detik (integer)**; satu nilai per file kecuali disebut JSON; **penulisan selalu atomik** (tulis ke file sementara di direktori yang sama, lalu `rename`); satu penulis utama per file.

| File | Isi | Penulis | Pembaca |
|---|---|---|---|
| `/etc/vastcomfy/.env` | Config instance (hanya key dari skema) | bootstrap (langkah 1; `TS_AUTHKEY` dihapus setelah dipakai) | agent, failsafe, bootstrap |
| `first_boot_at` | epoch boot pertama | bootstrap (sekali) | bootstrap, agent |
| `hard_cap` | epoch batas mutlak | bootstrap (sekali, hanya jika belum ada) | failsafe (sekali saat mulai), agent |
| `deadline` | epoch failsafe | bootstrap (hanya jika belum ada); agent (`/extend failsafe`) | failsafe, agent |
| `idle_destroy_at` | epoch destroy karena idle | agent | agent |
| `state.json` | `{state, reason, updated_at}` | bootstrap (fase boot: `booting`, `downloading`, `failed`, `ready`); agent (fase runtime: `ready`↔`idle-warning`, `stopping`, `destroy_failed`). Fase tidak saling tumpang tindih. | agent, bootstrap |
| `progress.json` | `{phase, file, bytes_done, bytes_total}` | bootstrap | agent |
| `failsafe.pid` | pid failsafe | failsafe | agent |
| `destroy_failsafe.json` | `{pending, attempts, last_error}` | failsafe | agent |
| `destroy_agent.json` | `{attempts, last_error}` | agent | agent |
| `tailscale/` | state Tailscale | tailscaled | tailscaled |

`/status` menggabungkan `destroy_failsafe.json` dan `destroy_agent.json` (destroy yang dimulai failsafe harus terlihat di `/status`).

### 5.3 Alur boot (`bootstrap.sh`)

Pengaman dipasang sebelum hal yang bisa gagal.

1. **Kredensial.** Tulis `/etc/vastcomfy/.env` hanya dari key yang ada di skema (daftar kunci dihasilkan dari `contracts/config-schema.yaml` ke `instance/allowed-keys.txt`; **bukan** seluruh env Vast). Pastikan `CONTAINER_ID` dan `CONTAINER_API_KEY` tidak kosong; jika kosong, boot berhenti (state `failed`, reason `missing_container_credentials`). Tidak ada kredensial untuk destroy, jadi **hanya timeout watchdog 25 menit yang menghentikannya**.
2. **Tanda waktu.** Jika `first_boot_at` tidak ada: tulis `first_boot_at`, `hard_cap` (boot + `HARD_CAP_HOURS`), dan `deadline` (boot + `FAILSAFE_HOURS`). Jika `first_boot_at` ada tetapi `hard_cap` hilang: `failed` (reason `hard_cap_missing`) dan self-destroy; jangan menghitung ulang.
3. **Jalankan `failsafe.sh`.** Mulai dari titik ini, setiap kegagalan boot **menghancurkan instance sendiri** (`self_destroy <reason>`), kecuali `KEEP_ON_FAILURE=true`.
4. **supervisord** (disesuaikan hasil S1); nyalakan program lewat `supervisorctl`.
5. **Tailscale naik** (state di `/var/lib/vastcomfy/tailscale/`), `tailscale serve` bila diperlukan (hasil S2). Hapus `TS_AUTHKEY` dari `.env` setelah berhasil. Gagal → `failed` (`tailscale_failed`), self-destroy.
6. **Jalankan agent** (agent hanya terjangkau lewat Tailscale, jadi setelah langkah 5). Menampilkan state `booting`/`downloading`.
7. Pasang node (ComfyUI-GGUF dan node profil, commit dipin). ComfyUI-Manager dinonaktifkan/tidak dipasang.
8. Unduh model profil jika belum ada (state `downloading`, `progress.json`).
9. Jalankan ComfyUI `--listen 127.0.0.1`, salin workflow bawaan.
10. State `ready` saat ComfyUI menjawab. **`idle_destroy_at` diinisialisasi di sini** = sekarang + `IDLE_MINUTES`.

### 5.4 `failsafe.sh`

- Loop tiap 30 detik. Pembacaan `/etc/vastcomfy/.env` memakai pencocokan baris `KEY=` (tanpa `source`, tanpa ekspansi), nilai tanpa tanda kutip.
- `hard_cap` dibaca **sekali saat mulai** dan disimpan di memori. Jika file tidak ada saat mulai: hitung sendiri (waktu mulai + `HARD_CAP_HOURS`). `deadline` dibaca ulang tiap siklus; tidak terbaca/korup → jatuh ke `hard_cap`.
- Jika `min(deadline, hard_cap)` terlewati (epoch UTC) → destroy, **tanpa memedulikan job aktif**.
- Pengaman sekunder: failsafe menghitung waktu berjalannya sendiri (`$SECONDS`); jika ≥ `HARD_CAP_HOURS` × 3600, destroy. Ini melindungi dari lompatan jam atau file yang diubah.
- API Vast tidak terjangkau → coba lagi tiap 30 detik terus-menerus, tulis `destroy_failsafe.json` (`pending: true`), matikan ComfyUI.
- Destroy idempoten: 404/"already gone" dianggap sukses.
- Menulis pid ke `failsafe.pid`.

### 5.5 Idle watcher (di agent)

- Antrean berisi (running + pending > 0): `idle_destroy_at = sekarang + IDLE_MINUTES` pada tiap polling.
- Antrean kosong: nilai dibiarkan. `idle_destroy_at − 10 menit` terlewati → state `idle-warning`. Lewat `idle_destroy_at` → destroy (reason `idle_timeout`).
- `/extend kind=idle minutes=N`: `idle_destroy_at += N`, dibatasi `hard_cap` dan maksimum 120 menit per panggilan. `/extend kind=failsafe minutes=N`: `deadline += N`, dibatasi `hard_cap` dan maksimum 180 menit per panggilan.
- Karena state ada di file, restart agent tidak mengatur ulang hitungan.
- Peringatan sebelum failsafe 10 menit tersedia dari `failsafe_at` di `/status`.

### 5.6 State machine

| Dari | Ke | Pemicu | Reason |
|---|---|---|---|
| `booting` | `downloading` | langkah 8 mulai | - |
| `booting`/`downloading` | `failed` | kegagalan boot | `missing_container_credentials`, `hard_cap_missing`, `tailscale_failed`, `node_install_failed`, `download_failed`, `disk_insufficient`, `comfyui_start_failed`, `config_invalid`, `failsafe_failed`, `supervisor_failed`, `agent_start_failed`, `boot_failed` |
| `downloading` | `ready` | ComfyUI menjawab | - |
| `ready` | `idle-warning` | antrean kosong sampai `idle_destroy_at − 10 menit` | - |
| `idle-warning` | `ready` | antrean berisi atau `/extend idle` | - |
| `booting`/`downloading` | `stopping` | destroy diminta (sebelum `ready`) | `manual`, `watchdog` |
| `ready`/`idle-warning` | `stopping` | destroy dimulai | `idle_timeout`, `failsafe_deadline`, `manual`, `watchdog` |
| `failed` | `stopping` | self-destroy (kecuali `KEEP_ON_FAILURE=true`) | alasan asal |
| `stopping` | `destroy_failed` | percobaan destroy habis | - |
| `destroy_failed` | `stopping` | percobaan ulang (agent atau watchdog) | - |

Setelah `ready`, kegagalan tidak kembali ke `failed`; hanya `stopping`/`destroy_failed`.

## 6. Kontrak agent API (`127.0.0.1:8189`, diteruskan lewat Tailscale)

Token bearer per instance, dibuat oleh bot, dikirim lewat env var Vast saat instance dibuat. **Semua endpoint butuh token kecuali `/health`** (hanya lokal). Perintah mengubah-sesuatu memakai `POST` atau `PUT`.

| Endpoint | Fungsi |
|---|---|
| `GET /health` | Hidup/tidak (lokal, tanpa token) |
| `GET /status` | Lihat 6.1 |
| `POST /extend` `{kind: "idle" \| "failsafe", minutes}` | Lihat 5.5. Melewati `hard_cap` atau maksimum per panggilan ditolak dengan pesan yang menyebut batasnya. Tidak pernah mengubah `hard_cap`. |
| `POST /destroy` `{reason}` | Destroy via Vast dengan retry/backoff (~5 percobaan/10 menit), balas `202`. Idempoten. |
| `GET /workflows`, `GET /workflows/{nama}` | Daftar (dengan waktu ubah) dan isi |
| `PUT /workflows/{nama}` | Timpa. `nama` divalidasi (tanpa path traversal), JSON valid, maksimum 1 MB. |

Halaman panel: satu file HTML statis yang membaca `/status`, dengan tombol Extend dan Destroy. Token diminta sekali dan disimpan di `sessionStorage`.

### 6.1 Skema `/status` (`schema_version: 1`)

| Field | Tipe / satuan | Catatan |
|---|---|---|
| `schema_version` | int | 1 |
| `state` | enum | lihat 5.6 |
| `reason` | string \| null | enum di 5.6 |
| `progress` | `{phase: "nodes"\|"models", file: string, bytes_done: int, bytes_total: int}` \| null | hanya saat `downloading` |
| `now`, `boot_at` | int, epoch UTC detik | |
| `uptime_s` | int, detik | |
| `idle_destroy_at` | int \| null | **waktu destroy karena idle**, bukan "idle sejak" |
| `failsafe_at`, `hard_cap_at` | int, epoch UTC detik | |
| `queue` | `{running: int, pending: int}` \| null | dari ComfyUI `/queue`; `null` bila ComfyUI tidak terjangkau |
| `gpu` | `{util_percent: int\|null, vram_used_mb: int\|null, vram_total_mb: int\|null}` | |
| `profile`, `commit` | string | |
| `failsafe_alive` | bool | cek pid di `failsafe.pid` |
| `destroy` | `{pending: bool, attempts: int, last_error: string\|null}` | gabungan failsafe dan agent |

### Output generate
Tidak lewat agent. Bot membaca dari ComfyUI (`/history`, `/view`) di port 8188 lewat Tailscale, sesuai mode (`normal`, `save`, `silent`; sub-proyek 3).

## 7. Kontrak untuk watchdog (sub-proyek 2)

Instance **tidak** mengirim apa pun ke homelab. Watchdog wajib:

1. Memanggil `/status` (dengan token instance dari registri) tiap 3 menit.
2. Mengirim **peringatan Discord di menit ke-10** bila `/status` tidak terjangkau (instance mungkin masih mengerjakan job; bisa jadi hanya agent yang mati), lalu menghancurkan instance (dengan key utama) bila: `/status` tidak terjangkau 15 menit berturut-turut padahal Vast `running`; `failsafe_alive` = false; **tidak `ready` dalam 25 menit sejak dibuat** (`BOOT_TIMEOUT_MIN`); umur instance melewati **6 jam menurut `start_date` Vast** (penegakan batas mutlak oleh sumber waktu independen); state `failed` dan tidak berubah dalam beberapa siklus (self-destroy belum terjadi).
3. Alert mendesak ke Discord bila destroy gagal, diulang tiap 5 menit sampai instance hilang dari daftar. Isi alert: ID instance, penyebab, `vastai destroy instance <id>`, link konsol.
4. Menarik/memulihkan workflow lewat `GET`/`PUT /workflows`.
5. Menganggap instance yang tidak dikenal (tidak ada di registri) sebagai anomali.

### 7.1 Registri instance (bot ↔ watchdog)

Disimpan di homelab (di luar repo; folder data di-`.gitignore`). Satu record per instance: `vast_instance_id`, `created_at`, `vast_start_date`, `profile`, `agent_token`, `tailnet_hostname`, `status`, `unreachable_since`. Skema di `contracts/instance-registry.schema.json`. Bot menulis saat membuat instance; watchdog memperbarui dan membaca.

### 7.2 Cara bot membuat instance (env + `onstart`)

Bot membuat instance lewat API Vast dengan `env` (key mengikuti skema config): `AGENT_TOKEN`, `TS_AUTHKEY` (sekali pakai, kedaluwarsa pendek), `TS_HOSTNAME` (unik per instance, mis. `vast-<id-acak>`; mencegah bentrok nama node ephemeral), `REPO_URL`, `REPO_COMMIT`, `PROFILE`, `IDLE_MINUTES`, `FAILSAFE_HOURS`, `HARD_CAP_HOURS`, `HF_TOKEN` (opsional), `KEEP_ON_FAILURE` (opsional). `CONTAINER_ID` dan `CONTAINER_API_KEY` disuntik Vast sendiri. `onstart` dibuat minimal: clone `REPO_URL`, checkout `REPO_COMMIT`, jalankan `instance/bootstrap.sh`.

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

Aturan unduh: lewati bila file ada dengan ukuran cocok; unduh ke `.part` lalu rename; verifikasi ukuran (dan checksum bila tersedia); retry 3x dengan backoff; cek ruang disk sebelum mulai (`disk_insufficient`); token HF opsional via env. Profil video/3D nanti = file YAML baru.

## 9. Keamanan

- Tanpa port publik; verifikasi lewat `vastai show instance` dan scan eksternal (bagian 11).
- ComfyUI tidak punya login → **ACL Tailscale** membatasi `tag:gpu` port 8188 dan 8189 hanya untuk perangkat pemilik dan homelab; penolakan dari perangkat lain diuji (S2).
- Auth key Tailscale: sekali pakai, ephemeral, ber-tag, kedaluwarsa pendek; **dihapus dari `.env` setelah dipakai**. Token agent per instance. Keduanya terlihat di UI/API Vast lewat env; dampak dibatasi oleh sifat sekali pakai dan umur instance.
- Custom node berjalan sebagai root dan bisa membaca semua rahasia di instance. Mitigasi: node dipin pada commit, tanpa ComfyUI-Manager.
- Repo publik: **tidak ada rahasia di repo** (bagian 14).
- `PUT /workflows`: validasi nama, JSON, ukuran.
- `CONTAINER_API_KEY` hanya bisa start/stop/destroy instance sendiri (terverifikasi di dokumentasi Vast); cakupan pastinya diuji di S4.

## 10. Penanganan error

| Kejadian | Perilaku |
|---|---|
| Kredensial container kosong (langkah 1) | `failed`; failsafe tidak bisa dijalankan; dihentikan oleh watchdog (timeout 25 menit). |
| `hard_cap` hilang setelah boot pertama | `failed` + self-destroy; tidak dihitung ulang. Watchdog menegakkan dari `start_date` sebagai cadangan. |
| Tailscale/node/ComfyUI gagal (setelah langkah 3) | `failed` + alasan, lalu **self-destroy** (kecuali `KEEP_ON_FAILURE=true`). Tanpa retry otomatis (retry memakan waktu GPU berbayar). |
| Download gagal (jaringan, rate limit, disk, ukuran) | Retry 3x dengan backoff, lalu `failed` dan self-destroy. |
| Agent crash | `supervisord` restart; state ada di file jadi tidak ada yang hilang. Crash terus-menerus → watchdog (15 menit tak terjangkau). |
| Destroy gagal | Retry; lalu `destroy_failed`, ComfyUI dimatikan; watchdog mencoba dengan key utama; alert berulang ke Discord. |
| Container restart | File di `/var/lib/vastcomfy/` tidak ditimpa; `first_boot_at` mencegah penulisan ulang; Tailscale memakai state di disk; batas mutlak juga ditegakkan watchdog dari `start_date`. |
| `deadline`/file lain korup atau setengah tulis | Penulisan atomik mencegahnya; bila tetap terjadi, failsafe jatuh ke `hard_cap`. |
| Tiga pihak destroy bersamaan | Idempoten; 404 dianggap sukses. |

## 11. Pengujian

**Lokal (tanpa GPU):**
- Agent dengan jam palsu: hitungan idle dari `ready`, peringatan 10 menit sebelum destroy, destroy, `/extend` (idle dan failsafe, batas per panggilan, penolakan di atas `hard_cap`), state bertahan setelah restart agent.
- `failsafe.sh` dengan stub API Vast dan deadline berdurasi detik: agent mati, job aktif, API tak terjangkau, `deadline` korup, `hard_cap` tidak ada, lompatan jam (pengaman `$SECONDS`), container restart (file tidak ditimpa).
- Pembaca `.env` di shell: tidak mengeksekusi kode; nilai berisi karakter khusus.
- Bootstrap menulis hanya key dari skema; `TS_AUTHKEY` terhapus setelah dipakai.
- Kegagalan boot setelah langkah 3 memicu self-destroy; `KEEP_ON_FAILURE=true` menahannya.
- `first_boot_at` ada tetapi `hard_cap` hilang → `failed` + self-destroy.
- Kredensial container kosong → boot berhenti, failsafe tidak dijalankan.
- Format epoch UTC pada semua file; penulisan atomik (tidak ada file setengah tulis terbaca).
- Kontrak API (`/status` sesuai `status.schema.json`, `/extend`, `/destroy`, `/workflows`) dengan model dummy kecil; validasi nama workflow; semua endpoint kecuali `/health` menolak tanpa token.
- State machine: semua transisi di 5.6, termasuk jalur yang dimulai failsafe.
- `bootstrap.sh` di Docker lokal dengan profil dummy; timeout boot saat download; destroy bersamaan dari tiga pelaku.
- Agent mati tetapi ComfyUI masih menjalankan job (sisi watchdog): peringatan menit ke-10, destroy menit ke-15.

**Nyata di Vast (kecil dan murah), setelah spike lulus:**
1. Boot penuh profil `image`: waktu sampai `ready` tercatat, ComfyUI dibuka dari laptop lewat Tailscale, satu gambar dihasilkan.
2. Uji pengaman dengan deadline dipendekkan (idle 3 menit, failsafe 10 menit): matikan agent, blokir API, matikan failsafe (watchdog harus bertindak), restart container.
3. Verifikasi di konsol Vast: instance hilang dan tagihan berhenti.
4. Verifikasi tidak ada port publik atau tunnel portal; perangkat non-pemilik ditolak ACL.

## 12. Kriteria selesai

- Satu perintah dari instance baru sampai `ready`, waktu boot tercatat.
- Gambar bisa dibuat dari browser laptop lewat Tailscale.
- Idle 30 menit dan failsafe 3 jam menghancurkan instance, terbukti di konsol Vast.
- Setiap baris di bagian 10 punya tes.
- Spike S4, S1, S2, S3, S5 lulus atau cadangannya terpilih dan tercatat.
- `contracts/` berisi skema yang dipakai kedua sisi (bagian 15).

## 13. Struktur repo (monorepo, publik)

```
instance/               # sub-proyek 1: jalan di Vast
  bootstrap.sh
  failsafe.sh
  supervisord.conf
  allowed-keys.txt      # dihasilkan dari contracts/config-schema.yaml
  agent/                # Python/FastAPI
  profiles/image.yaml
  workflows/
apps/                   # sub-proyek 2-3: jalan di homelab (Node.js/TypeScript)
  core/                 #   modul generate bersama
  watchdog/             #   proses kecil, berdiri sendiri
  bot/                  #   bot Discord
  web/                  #   halaman generate untuk HP
contracts/              # satu sumber kebenaran (bagian 15)
docs/superpowers/       # spec dan plan per sub-proyek
scripts/                # check-secrets.sh dan sejenisnya
```

## 14. Konfigurasi dan rahasia

Tujuan: pemilik selalu tahu **config apa** dan **API key apa** yang dipakai, dan mudah merawatnya.

1. **Satu skema config**: `contracts/config-schema.yaml`. Tiap key: `name`, `component`, `secret` (ya/tidak), `required`, `default`, `description`. Skema adalah satu-satunya daftar key yang sah.
2. **Satu modul `config` per komponen** (pola `config.js` yang memetakan `process.env` ke objek bernama, mis. `instance/agent/config.py`, `apps/core/config.*`). Hanya modul ini yang membaca env; kode lain mengimpor dari sana.
3. **Sumbernya file `.env`** (standar), dimuat saat start.
   - Homelab: `.env` lokal, di-`.gitignore`.
   - Instance: **satu** file `/etc/vastcomfy/.env` (mode 600) yang ditulis `bootstrap.sh` pada langkah pertama **hanya dari key yang ada di skema**. Format subset: `KEY=VALUE` per baris, tanpa kutip, tanpa ekspansi, tanpa baris baru di nilai. Failsafe (shell) membacanya dengan pencocokan baris, tidak dengan `source`.
4. **Fail fast**: key wajib kosong atau key di luar skema menghentikan program saat start dengan pesan yang menyebut nama key. Nilai `secret: true` tidak pernah dicetak di log (`***`).
5. **Tidak ada file example di repo.** `config init` membuat `.env` kosong dari skema (tidak menimpa yang sudah ada); `config list` mencetak semua key, pemakainya, dan mana yang rahasia.
6. **Pemeriksaan rahasia (berlapis):**
   - `.gitignore` mencakup `.env`, `.env.*`, `*.key`, `*.pem`, `node_modules/`, `dist/`.
   - Hook `pre-commit` (`.githooks/`, `scripts/check-secrets.sh`): menolak file config/kredensial (termasuk rename), menjalankan `gitleaks git --staged`, dan **gagal bila gitleaks tidak terpasang** (kecuali `SKIP_GITLEAKS=1`).
   - Hook hanya lokal dan bisa dilewati (`--no-verify`); ini risiko yang diterima (bagian 16). Tidak memakai GitHub secret scanning.
7. **Tidak ada hardcoded config (aturan utama).** Semua nilai yang bisa berubah atau bergantung lingkungan berada di skema config, dengan default di skema, dan dibaca hanya lewat modul `config`:
   - angka dan ambang: port (8188, 8189), interval polling, timeout, batas per panggilan `/extend`, ukuran maksimum workflow, jumlah retry, durasi peringatan, `BOOT_TIMEOUT_MIN`;
   - path: direktori state, lokasi `.env`, direktori ComfyUI, direktori output;
   - alamat dan identitas: URL API Vast, URL repo, hostname, ID Discord, nama channel;
   - semua key, token, dan kredensial.
   Yang boleh berada di kode hanyalah konstanta protokol (nama field di kontrak, kode status HTTP, nama state). Profil model (`instance/profiles/*.yaml`) dan workflow adalah file data deklaratif dan menjadi satu-satunya tempat sumber model.
   Penegakan (dibuat saat implementasi): (a) pembacaan env di luar modul `config` ditolak oleh lint; (b) pemeriksaan sederhana pada hook pre-commit mencari literal IP, URL, port, dan path absolut di luar modul `config` dan file data; (c) `config list` menunjukkan semua key beserta defaultnya.

### Daftar awal key (diperbarui di skema, bukan di sini)

Daftar otoritatif ada di `contracts/config-schema.yaml` (dibuat di Task 1); tabel ini hanya ringkasan awal.

| Key | Pemakai | Rahasia |
|---|---|---|
| `VAST_API_KEY` (key utama) | apps/watchdog, apps/bot (**tidak pernah di instance**) | ya |
| `CONTAINER_ID`, `CONTAINER_API_KEY` | instance/failsafe, instance/agent (disuntik Vast) | ya |
| `AGENT_TOKEN` | instance/agent, apps (dibuat per instance) | ya |
| `TS_AUTHKEY` | instance/bootstrap (sekali pakai, dihapus setelah dipakai) | ya |
| `TS_API_CREDENTIAL` | apps (membuat auth key) | ya |
| `HF_TOKEN` | instance/bootstrap (opsional) | ya |
| `DISCORD_BOT_TOKEN` | apps/bot, apps/watchdog | ya |
| `DISCORD_ADMIN_USER_IDS`, `DISCORD_ALERT_TARGET` | apps | tidak |
| `TS_HOSTNAME`, `REPO_URL`, `REPO_COMMIT` | instance/bootstrap | tidak |
| `PROFILE`, `IDLE_MINUTES`, `FAILSAFE_HOURS`, `HARD_CAP_HOURS`, `BOOT_TIMEOUT_MIN`, `KEEP_ON_FAILURE` | instance dan apps | tidak |
| `OUTPUT_DIR`, `WATCHDOG_INTERVAL_S`, `VAST_API_URL` | apps | tidak |
| `COMFY_PORT`, `AGENT_PORT`, `COMFY_DIR`, `STATE_DIR`, `ENV_FILE_PATH` | instance | tidak |
| `FAILSAFE_POLL_S`, `IDLE_WARN_MINUTES`, `EXTEND_MAX_IDLE_MIN`, `EXTEND_MAX_FAILSAFE_MIN`, `WORKFLOW_MAX_BYTES`, `DESTROY_RETRIES`, `DOWNLOAD_RETRIES` | instance | tidak |
| `TAILSCALED_BIN`, `COMFY_PYTHON`, `REPO_DIR`, `SUPERVISOR_CONF`, `COMFY_PROGRAM`, `DESTROY_TIMEOUT_S`, `DESTROY_BACKOFF_S`, `DESTROY_GONE_MARKERS`, `HF_BASE_URL`, `GIT_HOST_URL`, `COMFY_START_TIMEOUT_S`, `AGENT_START_TIMEOUT_S` | instance, non-secret (`ENV_FILE_PATH` dan `DESTROY_RETRIES` sudah terdaftar di atas) | tidak |
| `UNREACHABLE_WARN_MIN`, `UNREACHABLE_DESTROY_MIN`, `ALERT_REPEAT_MIN` | apps/watchdog | tidak |

## 15. `contracts/`

Format: **OpenAPI 3.1 + JSON Schema**. Isi:

| File | Isi |
|---|---|
| `agent.openapi.json` | Semua endpoint di bagian 6 (dihasilkan dari aplikasi FastAPI) |
| `status.schema.json` | Skema `/status` (6.1), `schema_version` |
| `instance-registry.schema.json` | Record registri (7.1) |
| `config-schema.yaml` | Daftar key config (bagian 14) |

Sisi agent (Python) memakai model pydantic yang divalidasi terhadap skema; sisi apps (TypeScript) menghasilkan tipe dari OpenAPI (mis. `openapi-typescript`). Perubahan kontrak adalah satu commit yang menyentuh kedua sisi.

## 16. Risiko sisa (diterima secara sadar)

- **Homelab mati (watchdog dan bot ikut mati) bersamaan dengan failsafe yang mati.** Tidak ada pihak yang menghentikan instance; batas terakhir hanya saldo Vast yang habis. Mitigasi: saldo prabayar kecil, auto top-up dimatikan, `failsafe_alive` dipantau, failsafe sekecil mungkin, dan (jika S5 menemukannya) destroy terjadwal di sisi Vast.
- **Kredensial container kosong di langkah 1**: hanya timeout watchdog 25 menit yang menghentikan instance.
- **Watchdog bisa menghancurkan instance yang sedang mengerjakan job** bila hanya agent yang mati. Biaya didahulukan; ada peringatan di menit ke-10.
- **Rahasia di env Vast terlihat di UI/API Vast.** Dibatasi oleh sifat sekali pakai dan umur instance.
- **Custom node berjalan sebagai root** dan dapat membaca rahasia instance. Dibatasi dengan commit yang dipin dan tanpa ComfyUI-Manager.
- **Hook pre-commit bisa dilewati** (`--no-verify`, atau clone tanpa hook). Tidak ada cadangan di sisi server; pemilik menerima risiko ini.

## 17. Pertanyaan terbuka

- Nilai pasti batas boot (default 25 menit); ditinjau setelah S3 mengukur waktu download.
- Apakah `tailscale serve` diperlukan di mode userspace (S2).
- Strategi menjalankan `onstart` (batas panjang dan perilaku run-ulang); alternatif `PROVISIONING_SCRIPT`. Dijawab S1.
- Cara pengguna tim menjangkau ComfyUI/halaman web saat rilis (sub-proyek 3–4), karena ACL saat ini hanya untuk pemilik.
