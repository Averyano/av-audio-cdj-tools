- Replace this line with the changes, one bullet each. The app's update dialog shows these bullets.

---

Problems and ideas: hello@averyano.com

### Download

| Your computer | File |
|---|---|
| Mac with Apple Silicon (M1 or later) | `AudioConverter-…-mac-arm64.dmg` |
| Mac with an Intel processor | `AudioConverter-…-mac-x64.dmg` |
| Windows 10/11, 64-bit | `AudioConverter-…-win-x64.exe` |
| Linux, 64-bit | `AudioConverter-…-linux-….AppImage` |

The source code is in the zip / tar.gz below.

### First launch

The installers aren't signed by Apple or Microsoft, so the first launch needs one extra step:

- **Mac:** open the .dmg and drag AudioConverter into Applications, then open it. When macOS says it can't verify the app, open **System Settings → Privacy & Security** and click **Open Anyway**.
- **Windows:** if SmartScreen says "Windows protected your PC", click **More info → Run anyway**.
- **Linux:** make the AppImage executable (`chmod +x AudioConverter-*.AppImage`), then run it.

### ffmpeg

AudioConverter uses [ffmpeg](https://ffmpeg.org/download.html) to convert and decode audio. If it can't find it, the app tells you and links to the download page.

- **Mac:** `brew install ffmpeg` (with [Homebrew](https://brew.sh)).
- **Debian/Ubuntu:** `sudo apt install ffmpeg`.
- **Windows:** download a build from ffmpeg.org, unzip it, and choose its `bin\ffmpeg.exe` in **Settings → ffmpeg → Choose…**.
