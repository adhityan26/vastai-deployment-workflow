# S3: Qwen-Image 2.1 GGUF + text encoder on a 24 GB GPU

- Date: 2026-10-17
- Instance: RTX A5000 24 GB (Lithuania, $0,238/jam, ~900 Mbps), image `vastai/comfy:v0.41.0-cuda-12.9-py312`, `--ssh --direct`, ComfyUI 0.41.0, torch 2.10.0+cu128. Dihancurkan: ya. Biaya akhir: **~$0,067** (kredit $4,9272 → $4,8606).
- Spec sections affected: 8 (profil), 3/5 (BOOT_TIMEOUT_MIN), 14

## Question
Apakah satu gambar benar-benar dihasilkan dengan GGUF Q4_K_M + encoder int8 di ComfyUI stock, dari repo mana, muat di 24 GB, dan berapa waktu download dan waktu per gambar?

## Method
1. Verifikasi repo lewat API HF (tanpa GPU): daftar file, ukuran, oid LFS, `SHA256SUMS`, dibandingkan dengan repo penulis.
2. Instance seperti kontrak S1. Node: `git clone leejet/ComfyUI-GGUF` pada commit `373048b`, `pip install -r requirements.txt` ke `/venv/main`, ComfyUI-Manager di-rename `.disabled`.
3. `curl -L` tiga file dari mirror pada revision `d94be5d7…` ke `models/{diffusion_models,text_encoders,vae}`; `sha256sum` setelahnya.
4. `supervisorctl restart comfyui`, lalu workflow API buatan sendiri (`instance/workflows/qwen-image-t2i.json`): `UnetLoaderGGUF` → `ModelSamplingAuraFlow(shift 3.1)` → `CLIPLoader(type qwen_image, device default)` + `VAELoader` → `CLIPTextEncode` → `EmptySD3LatentImage 1024²` → `KSampler(euler, simple, 25 langkah, cfg 1)` → `VAEDecode` → `SaveImage`. Dua generasi berturut-turut (seed 42, 43), VRAM dipantau tiap 0,5 detik.

## Raw results
- Repo: mirror `0xSojalSec/Qwen-Image-2.1-Uncensored-HF` (rev `d94be5d7a09b47b0211b03d0f23d20bc18203358`, 23 Sep) **identik byte-per-byte** dengan repo penulis `abenzerps/Qwen-Image-2.1-Uncensored-GGUF` (sudah di-rename menjadi `…-Uncensored-Quantized`, update 12 Okt): oid LFS dan `SHA256SUMS` sama untuk ketiga file. Lisensi `qwen-research` (`license:other`), tidak gated.
- Ukuran: Q4_K_M 4.604.558.112 B, encoder int8_convrot 9.350.798.360 B, VAE 675.509.688 B (total ~14,6 GB).
- Download dari HF: GGUF 74 s, encoder 150 s, VAE 13 s, **total 237 s** (~62 MB/s). SHA256 ketiga file cocok dengan `SHA256SUMS`.
- Node `UnetLoaderGGUF` termuat setelah restart ComfyUI. Encoder int8_convrot dan VAE berjalan di ComfyUI 0.41.0 stock tanpa node tambahan.
- Generasi 1024×1024, 25 langkah: **38,4 s** (pertama, termasuk memuat model) dan **32,1 s** (kedua). Hasil: foto rubah di salju yang tajam dan koheren.
- **VRAM puncak 13,996 MiB (~14 GB)** dari 24 GB: sisa ~10 GB.
- Template resmi Comfy (`image_qwen_image_2_1_t2i.json`) memakai subgraph dan model int8 sendiri; tidak dipakai.

## Verdict: PASS
GGUF Q4_K_M + encoder int8 + VAE menghasilkan gambar yang benar di 24 GB dengan sisa VRAM. Waktu boot baru yang menambah download ~4 menit.

## Decisions and config/spec changes
1. `instance/profiles/image.yaml` berisi tiga model dari mirror, dipin ke revision dan ukuran terukur, plus node `leejet/ComfyUI-GGUF` @ `373048b`. Spec 8 diganti dari `city96` ke `leejet` (fork city96 gagal pada arsitektur Qwen-Image 2.1).
2. Workflow API `qwen-image-t2i.json` dikirim di `instance/workflows/`.
3. Catat repo asli sebagai cadangan jika mirror hilang (hash sama, cukup ganti `repo`).
4. Waktu download (~4 menit) + boot (~2,5 menit) + instal node: `BOOT_TIMEOUT_MIN` default harus cukup; periksa nilainya terhadap ~8–10 menit total di Task 13. Gambar pertama ~38 s, berikutnya ~32 s.
5. 24 GB tidak wajib untuk Q4_K_M (14 GB terpakai); GPU 16 GB mungkin cukup, belum diuji. `requires.vram_gb` tetap 24 sampai diuji.

## Follow-ups
- Task 13: boot end-to-end nyata dengan profil ini (butuh repo di-push).
- Uji GPU 16 GB (lebih murah) dan resolusi 2048² bila diperlukan.
- Pengecekan checksum otomatis (`ModelSpec` belum punya `sha256`); saat ini hanya ukuran yang diverifikasi.

## Addendum: copyrighted characters (second run, same setup)
- Empat prompt SFW dengan karakter berhak cipta (seed 7, 1024², 25 langkah): Pikachu, Mickey Mouse klasik, Spider-Man, Super Mario. **Semuanya sukses dan dikenali dengan benar**, tanpa penolakan, gambar kosong, atau pengaburan. Waktu 32–39 s per gambar, download total 296 s di instance kedua (host sama, kecepatan GGUF berbeda: 151 s vs 74 s).
- Tidak ada filter konten di pipeline (sesuai README model). Pembatasan konten, jika diinginkan, harus ditambahkan di bot atau halaman web.
- Biaya run kedua: ~$0,077 (kredit $4,8410 → $4,7644). Instance dihancurkan.
