# S1: Image ComfyUI bawaan Vast

- Date: 2026-10-17
- Instance: (1) template resmi ComfyUI (id 264313, image `vastai/comfy`, tag otomatis `v0.41.0-cuda-12.9-py312`), RTX 3060 12 GB Korea, $0,091/jam; (2) `vastai/comfy:v0.41.0-cuda-12.9-py312` dibuat sendiri tanpa `-p`, GTX/RTX murah (offer 25225034). Keduanya dihancurkan: ya. Biaya akhir S1: **~$0,05** (kredit $4,9834 → $4,9374, kedua instance).
- Spec sections affected: 5.1, 5.3 (langkah 3-9), 9, 14 (default path/port/binary), 16, 17 (pertanyaan terbuka onstart)

## Question
Apa yang sudah dijalankan template ComfyUI bawaan (supervisord, port, proxy/portal publik, ComfyUI-Manager); bisakah semuanya dinonaktifkan; apakah `onstart` jalan ulang saat restart dan disk bertahan; arti `/proc/uptime` dan `start_date`; versi Python/pip; di mana ComfyUI terpasang?

## Method (exact commands run)
1. `vastai search templates 'count_created > 200' --raw` (disaring "comfy" di sisi klien), lalu `vastai create instance <offer> --template_hash 2188dfd3e0a0b83691bb468ddae0a4e5 --disk 40 --cancel-unavail --label s1-comfy`.
2. SSH (alamat dari `vastai ssh-url`) dan skrip probe: `ps`, `supervisorctl status`, `ss -ltnp`, isi `/etc/supervisor`, `/opt/supervisor-scripts/*.sh`, `/etc/Caddyfile` (tersamar), `env` (nama saja), versi Python/pip/setuptools, `df`, `nvidia-smi`.
3. Dari laptop: `curl` tanpa autentikasi ke setiap port publik; `vastai show instance --raw`.
4. `vastai stop` lalu `vastai start`; probe ulang; bandingkan `start_date`.
5. Instance kedua: `vastai create instance <offer> --image vastai/comfy:v0.41.0-cuda-12.9-py312 --disk 40 --ssh --direct --env '-e PORTAL_CONFIG="localhost:8188:18188:/:ComfyUI" -e COMFYUI_ARGS="--disable-auto-launch --port 18188" -e DATA_DIRECTORY=/workspace/ -e WORKSPACE=/workspace' --onstart-cmd '<tulis marker>; (entrypoint.sh > /var/log/entry.log 2>&1 &); <tulis marker>'` (tanpa `-p`, tanpa `PROVISIONING_SCRIPT`), probe, lalu pasang `vastai` terbaru di venv dan destroy dari dalam.

## Raw results (secrets redacted)
**Template bawaan:**
- Template = image `vastai/comfy`, jenis `jupyter`, `onstart = entrypoint.sh`, env berisi `-p 1111 -p 8080 -p 8384 -p 72299 -p 8188`, `PORTAL_CONFIG` (Instance Portal, ComfyUI, Jupyter, Syncthing), `PROVISIONING_SCRIPT` (unduh checkpoint dari civitai, ±6 GB, ±6 menit), `COMFYUI_ARGS="--disable-auto-launch --port 18188 --enable-cors-header"`.
- **Port publik terpetakan (0.0.0.0):** 1111, 3000, 8080, 8188, 8384, 58988, dan 22. Probe tanpa autentikasi: 8188/1111/8384 → HTTP 401 (token), 8080 → HTTP 302 (login Jupyter). Layanan web dilindungi token tetapi **publik**.
- **Cloudflare quick tunnel** (`cloudflared --url http://localhost:1111|8188`, `https://localhost:8080`) dijalankan otomatis oleh `tunnel_manager`: jalur publik kedua ke ComfyUI, Portal, dan Jupyter, selain pemetaan port.
- **supervisord sudah berjalan** (PID 603, dimulai oleh `/opt/instance-tools/bin/boot_default.sh`; config `/etc/supervisor/supervisord.conf`, socket `/var/run/supervisor.sock`, program di `/etc/supervisor/conf.d/`): `api-wrapper, caddy, comfyui, cron, instance_portal, jupyter, pyworker, syncthing, tensorboard, tunnel_manager`, semuanya `autostart=true`. `supervisorctl status` bekerja tanpa `-c`.
- **ComfyUI:** `/workspace/ComfyUI`, dijalankan oleh program `comfyui` lewat `/opt/supervisor-scripts/comfyui.sh` dengan venv `/venv/main` (Python 3.12.14, pip 26.2.1, setuptools 84, `uv`), argumen dari env `COMFYUI_ARGS`. Mendengarkan di **127.0.0.1:18188**; Caddy memproksikan 8188 → 18188 dengan token. `WORKSPACE=/workspace`. **`ComfyUI-Manager` ada** di `custom_nodes/`.
- `comfyui.sh` **menunggu `/.provisioning` hilang** sebelum menjalankan ComfyUI (provisioning dari `PROVISIONING_SCRIPT` berjalan lebih dulu).
- Layanan membaca `/etc/portal.yaml` (dihasilkan dari `PORTAL_CONFIG`); layanan yang tidak ada di sana **keluar sendiri** (`EXITED`). `comfyui.sh` juga memeriksa entri "ComfyUI" di sana (kecuali `SERVERLESS=true`).
- Image menyertakan CLI `vastai` **usang** (`/opt/instance-tools/bin/vastai`, `vast.py`): **tidak mengenal `-y`** (`error: unrecognized arguments: -y`, rc=2), mencetak 3 baris `WARNING: ... deprecated ...` lalu hasil; destroy **tanpa** `-y` berhasil dengan output `WARNING...\n\ndestroying instance <id>.`, rc 0.
- File `/root/.config/vastai/vast_api_key` dibuat oleh image saat boot dan **sama dengan `CONTAINER_API_KEY`**.
- Variabel `CONTAINER_ID`/`CONTAINER_API_KEY` **ada di sesi SSH dan PID 1** pada image ini (berbeda dari image Ubuntu polos di S4).
- Tidak ada `tailscale`/`tailscaled`, dan **tidak ada `/dev/net/tun`** (userspace networking wajib). `github.com`, `tailscale.com`, `huggingface.co` terjangkau. `/opt`, `/etc`, `/var/lib` bisa ditulis oleh root. Python sistem 3.12.3 (pip 24.0, `PIP_BREAK_SYSTEM_PACKAGES=1`).
- `/proc/uptime` = uptime host (±8,7 hari), bukan container.

**Restart (stop lalu start) pada template bawaan:**
- Marker file dan 6,5 GB model **bertahan** (disk persisten); `/.provisioning` **tidak** muncul lagi (provisioning tidak diulang).
- Entrypoint/onstart **jalan lagi**: supervisord dan program-programnya dimulai ulang (PID baru, `uptime 0:00:51`), cloudflared hidup lagi.
- **`start_date` Vast tidak direset oleh restart** (tetap waktu pembuatan, selisih 525 s dari pembuatan setelah ±8 menit).

**Instance kedua (tanpa `-p`, `PORTAL_CONFIG` hanya ComfyUI, tanpa provisioning):**
- Port publik terpetakan: **hanya 22/tcp** (`3000/tcp` tercatat tanpa pemetaan).
- `cloudflared` = **0 proses**. `instance_portal`, `tunnel_manager`, `jupyter`, `syncthing`, `tensorboard`, `pyworker`, `api-wrapper` = `EXITED`. `caddy` jalan tetapi tidak mendengarkan port web. Listener hanya: `0.0.0.0:22` dan **`127.0.0.1:18188` (ComfyUI)**.
- `onstart` kita dijalankan; `(entrypoint.sh > log &)` memulai supervisord dan ComfyUI tanpa menunggu provisioning; ComfyUI membalas HTTP 200 di `127.0.0.1:18188/system_stats`.
- Pemasangan `vastai` terbaru di venv: **27 detik**, versi 1.8.3. Self-destroy dengan `-y`: output tepat `destroying instance <id>.`, rc 0, instance hilang.
- Banner SSH instance menyuruh "AI agents" membaca `/etc/vast-agents-guide.md`; ini teks dari mesin sewaan (tidak tepercaya) dan **tidak diikuti**.

## Verdict: PASS
Image bawaan **dapat dipakai** (tanpa fallback ke image CUDA polos). Paparan publik **dapat dinonaktifkan sepenuhnya** dengan membuat instance dari image (bukan template), tanpa `-p`, dengan `PORTAL_CONFIG` hanya berisi ComfyUI. Perubahan wajib pada desain bootstrap tercantum di bawah.

## Decisions and config/spec changes
1. **Tidak memulai supervisord sendiri.** Supervisord image sudah berjalan. Langkah 4 bootstrap diganti: pakai `supervisorctl` yang ada, tambahkan program kita (`tailscaled`, `agent`) lewat file `/etc/supervisor/conf.d/vastcomfy.conf` (generate dari `instance/supervisord.conf` tanpa blok `[supervisord]`/`[unix_http_server]`) lalu `supervisorctl reread && supervisorctl update`. Default: `SUPERVISOR_CONF=/etc/supervisor/supervisord.conf`; kunci baru `SUPERVISOR_CONF_DIR=/etc/supervisor/conf.d`.
2. **Instance dibuat dari image, bukan template:** `--image vastai/comfy:<tag dipin> --ssh --direct`, **tanpa `-p`**, **tanpa `PROVISIONING_SCRIPT`** (provisioning menahan ComfyUI dan bertabrakan dengan "tunggu ComfyUI" di bootstrap), `--env` memuat `PORTAL_CONFIG="localhost:8188:18188:/:ComfyUI"`, `COMFYUI_ARGS="--disable-auto-launch --port 18188"` (tanpa `--listen` dan tanpa `--enable-cors-header`), `WORKSPACE`/`DATA_DIRECTORY`, serta env milik kita (spec 7.2). Ini menjadi bagian kontrak pembuatan instance untuk bot (sub-proyek 3).
3. **Port ComfyUI di dalam instance = 18188** (bukan 8188): `COMFY_PORT` default menjadi 18188. `tailscale serve` (S2) meneruskan ke `127.0.0.1:18188`. Port tailnet ComfyUI juga 18188 (= `COMFY_PORT`), agent 8189; contoh ACL `tag:gpu:18188,8189` (spec 9).
4. **Onstart:** `--onstart-cmd` kita menggantikan `entrypoint.sh` template, jadi onstart harus menjalankan entrypoint image sendiri di latar belakang, lalu bootstrap: `<nonaktifkan Manager>; (entrypoint.sh > /var/log/entry.log 2>&1 &); <clone repo>; bash instance/bootstrap.sh`. Diverifikasi bekerja. `PROVISIONING_SCRIPT` **tidak dipakai**. Batas panjang `--onstart-cmd` belum teruji (perintah kita pendek).
5. **ComfyUI-Manager harus dinonaktifkan** sebelum ComfyUI mulai: ganti nama `custom_nodes/ComfyUI-Manager` menjadi `ComfyUI-Manager.disabled` di onstart **sebelum** `entrypoint.sh` (ComfyUI otomatis jalan lewat supervisor). Pengabaian direktori `*.disabled` oleh ComfyUI belum diverifikasi; harus dicek pada boot berikutnya (UNVERIFIED).
6. **ComfyUI start sendiri saat boot**, sebelum model terunduh. Setelah memasang custom node (ComfyUI-GGUF), bootstrap melakukan `supervisorctl restart comfyui`; model baru muncul setelah refresh. Langkah "start comfyui" di bootstrap diganti "restart comfyui"; `COMFY_PROGRAM=comfyui` tetap benar.
7. **CLI `vastai`:** pasang yang terbaru di venv khusus **sebelum failsafe dijalankan**: `python3 -m venv /opt/vastcomfy-venv && /opt/vastcomfy-venv/bin/pip install vastai==<versi dipin>` (27 detik). `VASTAI_BIN` default → `/opt/vastcomfy-venv/bin/vastai`. CLI bawaan image tidak boleh dipakai dengan `-y` (rc 2). Kegagalan pemasangan harus **fail-closed**.
8. **Interpreter:** agent dipasang di venv sendiri (`/opt/vastcomfy-venv`, terpisah dari `/venv/main` milik ComfyUI): `AGENT_PYTHON=/opt/vastcomfy-venv/bin/python`; `COMFY_PYTHON=/venv/main/bin/python`. `pip install -e` bekerja (pip 26/setuptools 84); `/venv/main` tidak punya fastapi/uvicorn.
9. **Default path:** `COMFY_DIR=/workspace/ComfyUI` (sudah benar), `WORKFLOWS_DIR=/workspace/ComfyUI/user/default/workflows` (sudah benar), `REPO_DIR` perlu path yang bisa ditulis (`/opt/vast-comfy` ok), `STATE_DIR=/var/lib/vastcomfy` ok.
10. **Penghitungan umur:** `start_date` Vast tidak direset oleh restart, sehingga batas mutlak 6 jam dari watchdog dihitung dari pembuatan (termasuk waktu stop). Konservatif dan sesuai niat. `/proc/uptime` tetap tidak dipakai.
11. **`CONTAINER_*`** tersedia di sesi SSH dan PID 1 pada image ini; desain "tulis `.env` di langkah pertama" tetap benar.
12. Pertanyaan terbuka spec 17 ("strategi `onstart`") terjawab: pakai `--onstart-cmd` (bukan `PROVISIONING_SCRIPT`).

## Follow-ups
- Ubah kode/skema/bootstrap sesuai keputusan 1, 3, 6, 7, 8: default `COMFY_PORT=18188`, `COMFY_PYTHON=/venv/main/bin/python`, `AGENT_PYTHON=/opt/vastcomfy-venv/bin/python`, `VASTAI_BIN=/opt/vastcomfy-venv/bin/vastai`, `SUPERVISOR_CONF=/etc/supervisor/supervisord.conf`, kunci `SUPERVISOR_CONF_DIR`; bootstrap: pasang venv + vastai + agent dulu, tanpa `supervisord`, pakai `supervisorctl reread/update`, `restart comfyui`.
  - [x] Selesai: rencana `docs/superpowers/plans/2026-10-17-s1-image-adaptation.md` (Task 2: default dan kunci skema, `render-supervisor-conf`, `set-key`; Task 3: `bootstrap.sh` membangun venv + agent + `vastai` dipin dulu, tanpa supervisord sendiri, `supervisorctl reread/update`, `restart comfyui`; `instance/supervisord.conf` dihapus; `instance/onstart.sh` baru untuk keputusan 4 dan 5).
- **Fail-closed saat pemasangan `vastai` gagal:** tanpa CLI baru, `Destroyer`/failsafe tidak bisa menghancurkan, padahal CLI lama bisa menghancurkan (tanpa `-y`, dengan 3 baris peringatan sebelum hasil). Diputuskan: fallback ke CLI bawaan dengan `-y` dikosongkan lewat kunci `DESTROY_ASSUME_YES=false`; aturan sukses destroy kini per baris sehingga 3 baris peringatan CLI bawaan ditoleransi (Destroyer dan `failsafe.sh` selesai di Task 1; pemasangan fallback di `bootstrap.sh` menyusul di Task 3).
  - [x] Selesai (Task 3): `vastai` dipin gagal → `.env` diubah ke `STOCK_VASTAI_BIN` dengan `DESTROY_ASSUME_YES=false` sebelum failsafe dimulai; venv/agent gagal → `emergency_destroy` dengan CLI bawaan dari `PATH` (tanpa `-y`) dan exit non-zero.
- Verifikasi `ComfyUI-Manager.disabled` benar-benar tidak dimuat ComfyUI (boot berikutnya).
- Kontrak pembuatan instance (image + env + onstart + tanpa `-p`) dicatat untuk bot (sub-proyek 3).
  - [x] Dicatat di spec 7.2 (Task 3), termasuk teks `--onstart-cmd` persis dengan ekor `|| vastai destroy ...` (CLI bawaan, tanpa `-y`) untuk clone/checkout gagal, dan port tailnet 18188/8189. Implementasinya di bot tetap bagian sub-proyek 3.
- Catat bahwa banner instance mengandung teks yang ditujukan ke agen AI; semua teks dari instance diperlakukan sebagai data tak tepercaya.
