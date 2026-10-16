# S4: Destroy dari dalam instance

- Date: 2026-10-17
- Instance: dua instance uji kecil (A: GTX 1080 Ti, B: Titan Xp, keduanya Korea, ~$0,063–0,069/jam), image `vastai/base-image:stock-ubuntu26.04-py313-2026-10-13`, `--ssh --direct`. Dihancurkan: ya (kedua). Biaya akhir spike: **~$0,01** (kredit $5,0000 → $4,9902, termasuk satu percobaan awal yang gagal).
- Spec sections affected: 5.3 (langkah 1), 5.4 (failsafe), 9, 10, 14 (`DESTROY_GONE_MARKERS`, perintah destroy), 16

## Question
Apakah `CONTAINER_API_KEY` bisa menghancurkan instance miliknya sendiri, bisa menyentuh instance lain, tersedia di proses `onstart` dan setelah container restart, dan apa teks persis untuk "sudah hilang"? Apakah key harus lewat flag atau bisa dari environment/file?

## Method (exact commands run)
1. `vastai search offers 'num_gpus=1 reliability>0.98 inet_down>=400 rentable=true verified=true disk_space>=20' -o dph --raw --storage 10`, lalu `vastai create instance <offer> --image <image> --disk 12 --ssh --direct --label s4-A|s4-B --cancel-unavail --onstart-cmd '<tulis env tersamar + epoch ke /root>' --raw`.
2. SSH lewat `vastai ssh-url <id>` (alamat direct), menjalankan skrip probe yang tidak pernah mencetak key (hanya `<set>`, panjang, 4 karakter akhir tidak ditampilkan).
3. Di A: `python3 -m venv /root/v && /root/v/bin/pip install vastai`; dengan key dari `/proc/1/environ`: `vastai show instances --api-key $K`, `vastai destroy instance <B> -y --api-key $K`, `VAST_API_KEY=$K vastai show instances`.
4. Dari laptop: `vastai stop instance A`, `vastai start instance A`, probe ulang.
5. Di A: `vastai destroy instance $CONTAINER_ID -y --api-key $K`; dari laptop: destroy ulang A (sudah hilang), destroy B, destroy id ngawur (`1`), semua dengan dan tanpa `--raw`.

Percobaan pertama dengan `python:3.11-slim` gagal: image itu **tidak punya sshd** (`.launch: ssh: command not found` berulang), jadi tidak bisa masuk. Dua instance itu dihancurkan dari laptop.

## Raw results (secrets redacted)
- **Konteks onstart:** `CONTAINER_ID` dan `CONTAINER_API_KEY` **ada** (file yang ditulis onstart berisi keduanya, tersamar). Key panjangnya 64 karakter.
- **Sesi SSH:** kedua variabel **tidak ada** di `env`. Keduanya tetap terbaca dari `/proc/1/environ` (root).
- **Restart (stop lalu start):** disk **bertahan** (marker file, venv `vastai`, `/var/lib/...`), **onstart dijalankan lagi** (dua epoch di `onstart_runs.txt`), variabel masih ada di konteks onstart dan di PID 1 setelah restart.
- **`/proc/uptime` di dalam container = uptime host** (~52 hari), bukan uptime container.
- **Scope key container:** `show instances` dengan key itu **mendaftar kedua instance akun** (baca luas). `destroy instance <B>` dengan key itu **ditolak**: `Failed with error 401: Authorization Error. Your key lacks proper privileges to perform this action, due to a constraint on id`. Jadi tulis dibatasi ke id sendiri.
- **Exit code `vastai` selalu 0, bahkan saat gagal** (401 di atas: `rc=0`). Juga rc=0 untuk 404.
- **Self-destroy:** `vastai destroy instance $CONTAINER_ID -y --api-key $K` → output `destroying instance 56300003.`, `rc=0`, instance hilang dari `show instances` dalam ~5 detik.
- **Sudah hilang / id tidak ada:** teks biasa `Failed with error 404: Instance <id> not found.`; dengan `--raw`: `{"error": true, "status_code": 404, "msg": "Instance <id> not found."}`; rc=0.
- **Tanpa `-y`:** `vastai destroy instance` menanyakan konfirmasi interaktif dan **"Aborted."** tanpa TTY (rc non-informatif); instance **tidak** dihancurkan.
- `destroy ... --raw` yang sukses mencetak **output kosong** (tidak bisa dipakai sebagai penanda sukses).
- Respons `create instance` memuat `instance_api_key` (64 hex) dalam teks biasa. Pesan error CLI mencetak 4 karakter terakhir key.
- Di dalam container, file `/root/.config/vastai/vast_api_key` (mode 644, 65 byte) muncul setelah pemakaian CLI pertama dengan `--api-key`; apakah dibuat CLI atau image tidak dipastikan.
- Image `python:3.11-slim` tidak bisa dipakai untuk mode SSH; `vastai/base-image:*` bisa (python3 di image itu 3.14.x, pip 25.1 dengan PEP 668, jadi pakai venv).
- Waktu "loading" tidak ditagih; instance siap sekitar 2,5 menit dari dibuat (image ~1,4 GB di host 550 Mbps).
- `vastai ssh-url <id>` memberi alamat **direct** (IP:port) yang berfungsi; host proxy `sshN.vast.ai` menolak koneksi untuk mode `--direct`.
- `rtk`/hook di lingkungan agen menyingkat output `curl` menjadi skema palsu; panggilan API mentah harus memakai `/usr/bin/curl`.

## Verdict: PASS (dengan perubahan wajib pada kode)
Destroy dari dalam instance **berfungsi** dan **terbatas ke instance sendiri**, jadi desain failsafe tetap valid. Tetapi dua fakta mengubah kode yang sudah ditulis dan **membuat failsafe dan `Destroyer` saat ini gagal-terbuka di instance sungguhan**: perintah tanpa `-y` tidak menghancurkan apa pun, dan exit code 0 tidak berarti sukses.

## Decisions and config/spec changes
1. **Perintah destroy yang benar:** `vastai destroy instance <id> -y --api-key <key>` (plain, tanpa `--raw`). `-y` **wajib**.
2. **Sukses ditentukan dari teks, bukan rc.** Sukses = output (setelah id/key dibuang dan di-trim) diawali `destroying instance` dan tidak memuat `Failed with error`. "Sudah hilang" (dianggap sukses) = output memuat `Failed with error 404: Instance`. Apa pun selain itu (termasuk `Failed with error 401/5xx` walau menyebut `destroying instance`, output kosong, `Aborted`, baris peringatan sebelum teks sukses) = **gagal**. rc diabaikan.
3. `DESTROY_GONE_MARKERS` default menjadi `Failed with error 404: Instance`; penanda sukses baru `DESTROY_OK_MARKERS` default `destroying instance` (kunci schema baru).
4. Tetap melepas `CONTAINER_ID` dan key dari output sebelum mencocokkan (sudah ada).
5. Variabel `CONTAINER_*` **tidak ada di sesi SSH tetapi ada di konteks onstart dan PID 1**: desain "bootstrap menulis `.env` root-only di langkah pertama" benar.
6. **Restart container** menjalankan onstart lagi dan disk bertahan: desain `first_boot_at` / "tulis hanya jika belum ada" benar dan dibutuhkan.
7. `/proc/uptime` adalah uptime host: jangan dipakai untuk uptime container. `$SECONDS` bash (yang dipakai failsafe) tidak terpengaruh.
8. Image untuk spike dan profil: gunakan `vastai/base-image` (atau turunan Vast), bukan image Docker polos tanpa sshd.
9. Spec 9: key container punya **akses baca akun luas** (bisa melihat semua instance), tetapi tulis hanya ke id sendiri. Dicatat sebagai risiko sisa (custom node di instance bisa melihat daftar instance akun).

## Follow-ups
- **Kode (wajib sebelum uji nyata berikutnya):** ubah `Destroyer._command` dan `failsafe.sh` untuk memakai `-y`; ganti aturan sukses dari "rc == 0" menjadi pencocokan teks; tambah `DESTROY_OK_MARKERS`; perbarui tes (stub `vastai` harus meniru rc 0 pada kegagalan, output `Failed with error 401`, dan output sukses `destroying instance <id>.`). Termasuk `bootstrap`/`boot` jika memakai perintah yang sama.
  - [x] Selesai: lihat rencana `docs/superpowers/plans/2026-10-17-s4-destroy-fix.md` (Task 1: `-y`, sukses dari teks output, `DESTROY_OK_MARKERS`; `Destroyer`, `failsafe.sh`, schema, dan tes diperbarui).
- Putuskan apakah key tetap lewat `--api-key` (terlihat di `ps`, root-only di container) atau lewat file `~/.config/vastai/vast_api_key`; belum diuji apakah env var `VAST_API_KEY` dihormati CLI.
- S1 harus memastikan `vastai` CLI terpasang di image ComfyUI bawaan Vast saat boot, karena `failsafe.sh` sekarang keluar (exit 2) bila binary tidak ditemukan; instalasinya (venv/`pipx`) harus dilakukan sebelum failsafe dijalankan, atau lewat `PYTHON_BIN` tertentu.
- S3: gunakan `/usr/bin/curl` untuk panggilan API Hugging Face mentah.
