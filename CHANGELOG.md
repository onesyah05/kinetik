# Changelog

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
