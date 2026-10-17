# S2: Tailscale userspace networking in the Vast instance

- Date: 2026-10-17
- Instance: satu instance kecil (GTX 1660 S, ~$0,067/jam), image `vastai/comfy` (stock), `--ssh --direct`. Dihancurkan: ya. Biaya spike: **~$0,008** (kredit $4,9374 → $4,9292).
- Spec sections affected: 5.3 (langkah Tailscale), 9 (akses/ACL), 14 (kunci `TS_*`, `TS_SERVE_ENABLED`)

## Question
Bisakah node di dalam container Vast (tanpa `/dev/net/tun`, tanpa tailscale bawaan) bergabung ke tailnet lewat userspace networking memakai auth key dari file, dapat dijangkau dari perangkat sendiri hanya di port yang diizinkan, dan tidak bisa menjangkau perangkat kita?

## Method
1. Unduh tarball Tailscale 1.104.1 ke `/opt/tailscale` (instal ~2 detik); jalankan `tailscaled --tun=userspace-networking --state=/var/lib/vastcomfy/tailscale/tailscaled.state --socket=/var/run/tailscale/tailscaled.sock`.
2. `tailscale up --auth-key=file:/root/ts_key --hostname=s2-test --advertise-tags=tag:gpu`.
3. Uji dari laptop ke node (port 18188, 8189, 22, 8188) dan dari node ke laptop (`timeout 8 tailscale nc <ip> 9999`), pertama dengan ACL allow-all, lalu setelah ACL dipersempit.
4. Hentikan `tailscaled`, hapus socket dan file key, jalankan ulang dengan state yang sama, ukur waktu bergabung kembali.

## Raw results
- `tailscale up --auth-key=file:...` berfungsi (key dibaca dari file, tidak muncul di argumen proses). Node bergabung sebagai `s2-test` dengan tag `tag:gpu`.
- Koneksi masuk dari tailnet **otomatis diteruskan ke layanan di localhost** pada userspace mode; `tailscale serve` tidak diperlukan. Port yang dibuka ditentukan ACL.
- Di bawah ACL allow-all: node **bisa menjangkau laptop** (listener laptop mencatat koneksi dari IP node).
- Setelah ACL dipersempit (grants: `autogroup:member`→`autogroup:member` penuh; `autogroup:member`→`tag:gpu` hanya `tcp:18188,8189`):
  - laptop → node:18188 = HTTP 200; laptop → node:8189 = HTTP 200 (listener uji);
  - laptop → node:22 = **ditolak** (sshd berjalan di node, jadi ini murni ACL); node:8188 = ditolak;
  - node → laptop:9999 dan node → laptop:22 = **timeout/ditolak** (rc 124).
- Rejoin: setelah `tailscaled` dimatikan, socket dan file auth key dihapus, start ulang dengan state yang sama → node muncul kembali di tailnet dalam **2 detik tanpa auth key**; laptop → node:18188 tetap 200.
- `tailscale nc -w` tidak didukung; pakai `timeout 8 tailscale nc ...`.

## Verdict: PASS
Tailscale userspace berfungsi di instance Vast, akses masuk dikunci oleh ACL ke dua port, dan node tidak punya jalur ke perangkat pengguna.

## Decisions and config/spec changes
1. Pasang tarball Tailscale yang dipin (1.104.1) ke `/opt/tailscale`; jalankan `tailscaled` sebagai program supervisor (bukan `nohup`), state di `/var/lib/vastcomfy/tailscale` agar bertahan saat stop/start.
2. `tailscale up --auth-key=file:<path> --hostname=<TS_HOSTNAME> --advertise-tags=tag:gpu`; hapus file key sesudah `up` berhasil (state menyimpan identitas node).
3. **Jangan** pakai `tailscale serve`; hapus logika `serve_port`/`TS_SERVE_ENABLED` dari bootstrap dan schema.
4. Port tailnet: ComfyUI = `COMFY_PORT` (18188), agent = 8189; keduanya dibuka lewat ACL, bukan lewat proses di instance.
5. ACL wajib dipersempit (allow-all membiarkan instance menjangkau perangkat pengguna). Kebijakan yang diuji: grants di atas + blok `tests` (accept `tag:gpu:18188,8189`, deny `tag:gpu:22,80`).
6. Setelah restart container, `tailscaled` dengan state lama bergabung kembali tanpa key; onstart tidak perlu key baru bila state ada.

## Follow-ups
- Kode: adaptasi langkah Tailscale di `bootstrap.sh` / `supervisor_conf` sesuai keputusan 1–3 (via SDD).
- S5: umur minimum auth key OAuth/ephemeral dan pengaman sisi Vast.
