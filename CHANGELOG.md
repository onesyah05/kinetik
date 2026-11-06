# Changelog

## v0.6.0 — 2026-11-07

### Baru
- **Posting ke Facebook Reels**: setiap hasil render punya tombol **Post to Reels**. Isi **Page ID** dan **Page access token** sekali di **Settings → Facebook Reels** (ada tombol **Test connection**).
- **Caption & hashtag dari AI**: caption ditulis dari narasi video. Hashtag dibuat huruf kecil semua: campuran tag populer Reels, tag sesuai topik, dan topik yang sedang tren di Google Trends (negaranya bisa dipilih) kalau memang cocok. Tren hari ini tampil sebagai pilihan yang bisa diklik.
- Pilih **Publish now** atau **Save as draft**. Bisa ditandai **AI-generated**.
- Sebelum mengunggah, Kinetik mengecek syarat Reels (9:16, 3–90 detik, minimal 540×960, 24–60 fps) dan batas 30 posting per 24 jam.
- Progres unggah tampil langsung. Video yang sudah diposting diberi tanda **Posted to Facebook Reels** dengan link-nya.
- Setiap render kini mencatat video mana asalnya (berkas `.json` di samping MP4).

## v0.5.0 — 2026-11-07

### Baru
- **Login Muse Code (Meta)**: di **Settings → Sign in with subscription** sekarang ada **Muse Code**. Buka link yang muncul, masukkan kodenya, setujui, dan selesai. Model Muse Spark (`muse-spark-1.3`, `1.2`, `1.1`) langsung bisa dipilih di chat.
- Kalau project memakai Muse, pembuatan gambar otomatis memakai akun Codex atau Antigravity yang terhubung.

### Perbaikan
- Render berhenti dengan pesan "restart Kinetik" kalau server masih menjalankan kode lama yang mengabaikan pilihan video, bukan merender video yang salah.

## v0.4.1 — 2026-11-07

### Perbaikan
- Jendela update dan pemberitahuan "Kinetik updated" kini tampil benar: menutupi seluruh halaman dan muncul di pojok kanan bawah, tidak lagi terjepit di bagian header.

## v0.4.0 — 2026-11-07

### Baru
- **Update dengan satu klik**: Kinetik mengecek versi baru sendiri. Kalau ada, tombol **Update to vX.Y.Z** muncul di kanan atas beserta catatan rilisnya. Klik **Update now**: Kinetik menutup diri, memasang versi baru, menyala lagi, lalu halaman browser memuat ulang sendiri.
- **`kinetik update`** di terminal (`--check` untuk hanya mengecek). Kalau Kinetik sedang berjalan, perintah ini menyuruh Kinetik meng-update dirinya sendiri.
- Saat `kinetik` dijalankan, terminal memberi tahu kalau ada versi baru.
- Berlaku untuk semua cara pasang: npm, ZIP (`Start-Kinetik.bat`), dan clone git. Project, pengaturan, dan login tidak tersentuh.

### Perbaikan
- Chrome untuk render (~300 MB) sekarang disimpan di folder data Kinetik, tidak lagi di folder tempat `kinetik` diketik, jadi tidak diunduh ulang.
- Update tidak akan berjalan selama agent bekerja atau render sedang berjalan.

## v0.3.0 — 2026-11-06

### Baru
- **Pilih video yang dirender**: di tab *Renders*, project dengan beberapa video sekarang menampilkan daftar video. Centang satu, beberapa, atau semua (*Select all*). Setiap video dirender bergantian menjadi MP4 sendiri, lengkap dengan durasi masing-masing.
- Render tidak lagi mengganti video yang sedang aktif di preview atau chat.
- Progres menampilkan video ke berapa yang sedang dirender (misal *Rendering 2 of 3*), dan setiap MP4 langsung muncul di daftar begitu selesai.
- Agent bisa merender semua video sekaligus saat diminta ("render semua videonya").

## v0.2.0 — 2026-11-06

### Baru
- **Pasang dengan satu perintah**: `npm install -g kinetik-studio`, lalu jalankan `kinetik` dari terminal mana saja.
- **Perintah `kinetik`**: `start` (buka browser otomatis), `doctor` (cek FFmpeg, Python, dan paketnya), `setup` (pasang paket Python), `cli`, `home`, `--port`, `--no-open`, `--home`.
- **Data terpisah dari program**: hasil instalasi npm menyimpan project dan pengaturan di `~/Kinetik`, jadi update atau pasang ulang tidak menghapus apa pun. Hasil clone git tetap memakai `workspace/` di dalam repo.

### Perbaikan
- Cache Vite dan file sementara tidak lagi ditulis ke folder program (aman untuk instalasi global yang read-only).
- Dependensi yang dibutuhkan saat berjalan (`vite`, `@vitejs/plugin-react`, `@codemirror/view`) dipindah ke `dependencies`.
- `kinetik doctor` mendeteksi paket Python dengan benar di Windows.

## v0.1.0 — 2026-11-06

Rilis publik pertama Kinetik.

### Fitur
- **Agent video lewat chat**: menulis adegan Remotion, membuat narasi + subtitle per kata, mengecek frame-nya sendiri, dan merender MP4 secara lokal.
- **Login dengan langganan**: Codex (ChatGPT), Claude Code, dan Antigravity (Google), tanpa API key. Daftar model diambil langsung dari akunmu.
- **Pilihan gaya dari gambar AI**: 3 contoh gaya dibuat paralel, gaya yang dipilih jadi acuan seluruh video dan referensi aset. Bisa beralih ke sampel kode animasi.
- **Gambar & animasi AI** lewat Codex atau Antigravity: latar transparan otomatis, edit dengan gambar referensi, sprite frame-by-frame, dan rig karakter.
- **Semua ikut model chat**: pembuatan gambar, sprite, dan rig otomatis memakai provider yang dipilih di project.
- **Banyak video dalam satu project** dengan gaya, suara, dan aset yang sama. Tombol *New video* menerima beberapa tema sekaligus.
- **Edit & kirim ulang** pesan di chat.
- **Peluncur Windows** `Start-Kinetik.bat` yang memeriksa dan memasang kebutuhan secara otomatis.

### Perbaikan
- Gateway Codex: versi klien diperbarui (model GPT-6 muncul), argumen tool dari model baru terbaca, format pesan asisten diperbaiki.
- Gateway Antigravity: format permintaan Cloud Code, project otomatis, dan tool calling Gemini 3.
- Error dari provider tampil sebagai error, tidak lagi tersimpan sebagai balasan agent.
