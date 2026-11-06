# Changelog

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
