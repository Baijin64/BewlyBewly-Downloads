# BewlyBewly + Downloads

Personal maintenance fork for the maintainer and friends. Browser extension **0.44.7**, Rust local helper **0.3.0** (Windows MSIX + Android companion app **0.44.7**). This is an independent fork, not an official continuation of either upstream project.

- **Original BewlyBewly project:** [BewlyBewly/BewlyBewly](https://github.com/BewlyBewly/BewlyBewly), originally by [Hakadao](https://github.com/hakadao). Its MIT license and attribution are preserved.
- **Bilidown author:** [王子周棋洛 — https://zhouql.vip/](https://zhouql.vip/). Bilidown's workflow and settings inspired the download integration; the local download core in this fork is independently implemented in Rust.
- **This fork and downloads:** [Baijin64/BewlyBewly-Downloads](https://github.com/Baijin64/BewlyBewly-Downloads). Private repository assets require repository access.

For installation and builds, see [中文说明](README-cmn_CN.md), [personal-fork installation](docs/INSTALL-DOWNLOADS.md), [platform matrix](docs/PLATFORMS.md), and [build instructions](docs/BUILD-DOWNLOADS.md).

The download UI opens without starting the local download service. Download and queue operations start it on demand after first-use confirmation; it exits after work finishes. Launching the connector manually from Windows keeps it resident. See [process lifecycle](docs/DOWNLOAD-LIFECYCLE.md).

The ZIP can be extracted and loaded with developer mode in Chrome/Edge. A valid CRX signature does not establish that a browser will allow direct installation or activation. The helper (`BewlyDownloadHost.exe` + NativeAOT tray `BewlyDownloadTray.exe`) is now pure Rust with bundled LGPL FFmpeg and no longer requires Node.js or aria2. Windows MSIX builds use a local development certificate; other computers must explicitly trust the included public certificate before installation. An Android companion app (`platforms/android`) embeds the same Rust core via JNI and exports completed media through MediaStore.

The original upstream README is retained below. Its store links install the original extension, which does not include this fork's download features.

---

# BewlyBewly (upstream documentation)

English | [官话 - 简体中文](README-cmn_CN.md) | [官話 - 繁體中文](README-cmn_TW.md) | [廣東話](README-jyut.md)

<p align="center" style="margin-bottom: 0px !important;">
<img width="300" alt="BewlyBewly icon" src="https://cdn.jsdelivr.net/gh/BewlyBewly/Imgs/logos/bewlybewly-vtuber-logo.png"><br/>
</p>

<p align="center">Just make a few small changes to your Bilibili homepage.</p>

<!-- ![min1](https://github.com/hakadao/BewlyBewly/assets/33394391/951f9e2a-d0e1-452c-83a9-dc6d85c4d441)
![min2](https://github.com/hakadao/BewlyBewly/assets/33394391/3e75dd20-f60b-4645-b434-23a24c72959c) -->

## 👋 Introduction

> [!IMPORTANT]
> BewlyBewly mainly focuses on page adjustments and optimization rather than improving functionally and efficiency.
>
> The dark mode will only be adapted to commonly used pages due to its efficiency and maintenance difficulty, while less
> frequently used pages will not to be adapted.

> [!CAUTION]
> [BLBewly](https://apps.apple.com/us/app/blbewly/id6742200021) is a free BewlyBewly extension on Safari. We thank [𝗦𝘁𝗲𝘃𝗲 𝕏](https://x.com/st7evechou) for their help with the free publication of the app to Safari.
> However, issues encountered with the Safari version are outside of our maintenance scope,
> and we are not considering Safari maintenance.

> [!CAUTION]
> If you are installing this extension, your browser will probably say that it can read your browser history.
>
> This is because BewlyBewly uses the ["tabs" permission](https://developer.chrome.com/docs/extensions/reference/api/tabs), which can also be used to read each tab, allowing it to know the browsing history, but it is not utilized here.
>
> **Some browsers will mention the worst-case scenario and the highest risks, ensuring your safety after installation.**
> Additionally, this project is open source, so you can see what exactly what it does.

BewlyBewly is a browser extension for BiliBili that aims to enhance the user experience by redesigning the BiliBili UI.
The design is inspired by YouTube, Vision OS, and iOS, resulting in a more visually appealing and user-friendly interface.
This project uses the [vitesse-webext](https://github.com/antfu/vitesse-webext) template for development.
Without this template, it may not be possible to develop this project.

## ⬇️ Installation

### Online Installation

> [!TIP]
> Even in the Edge browser, we strongly recommend you install it in the Chrome web store.
> In terms of review speed, the Chrome web store is faster than Edge Add-ons.
>
> Additionally, the Chrome Web Store version of BewlyBewly will address and fix critical bugs more quickly.

- Chrome: <https://chromewebstore.google.com/detail/bewlybewly/bbbiejemhfihiooipfcjmjmbfdmobobp>
- Edge: <https://chromewebstore.google.com/detail/bewlybewly/bbbiejemhfihiooipfcjmjmbfdmobobp>
- Firefox: <https://addons.mozilla.org/en-US/firefox/addon/bewlybewly/>

#### To Firefox users

> [!WARNING]
> When using the Firefox browser, remember to enable all permissions shown in the picture below for normal use of BewlyBewly

<br/> <img width="655" alt="enable all bewlybewly permissions on firefox" src="https://github.com/hakadao/BewlyBewly/assets/33394391/9566aed8-040a-4435-a2ec-c61117f8e429">

### Local Installation

[CI](https://github.com/hakadao/BewlyBewly/actions): Automatically build with the latest code

[Releases](https://github.com/hakadao/BewlyBewly/releases): Stable version

#### Edge & Chrome (RECOMMENDED)

> Ensure you installed [extension.zip](https://github.com/hakadao/BewlyBewly/releases) .

Opening the `edge://extensions` page in the Edge or `chrome://extensions` page in Chrome,
simply drag and drop the downloaded `extension.zip` file into the browser to complete the installation.

<details>
 <summary> Another installation method for Edge & Chrome </summary>

#### Edge

> Ensure you installed [extension.zip](https://github.com/hakadao/BewlyBewly/releases) and decompress this file.

1. Type in `edge://extensions/` in the address bar and press Enter
2. Turn on `Developer mode` then press `Load Unpacked` <br/> <img width="655" alt="image" src="https://user-images.githubusercontent.com/33394391/232246901-e3544c16-bde2-480d-b770-ca5242793963.png">
3. Load the decompressed extension folder in your browser

#### Chrome
>
> Ensure you installed [extension.zip](https://github.com/hakadao/BewlyBewly/releases) and decompress this file.

1. Type in `chrome://extensions/` in the address bar and press Enter
2. Turn on `Developer mode` then press `Load Unpacked` <br/> <img width="655" alt="Snipaste_2022-03-27_18-17-04" src="https://user-images.githubusercontent.com/33394391/160276882-13da0484-92c1-47dd-add8-7655c5c2bf1c.png">
3. Load the decompressed extension folder in your browser

</details>

## 🤝 Contribution & Build

See [CONTRIBUTING.md](docs/CONTRIBUTING.md)

### Contributors

[![Contributors](https://contrib.rocks/image?repo=hakadao/BewlyBewly)](https://github.com/BewlyBewly/BewlyBewly/graphs/contributors)

## ❤️ Credits

- [vitesse-webext](https://github.com/antfu/vitesse-webext) - The template used for this project
- [UserScripts/bilibiliHome](https://github.com/indefined/UserScripts/tree/master/bilibiliHome),
[bilibili-app-recommend](https://github.com/magicdawn/bilibili-app-recommend) - Reference source for obtaining the access key
- [Bilibili-Evolved](https://github.com/the1812/Bilibili-Evolved) - Partial implementation of functionalities
- [bilibili-API-collect](https://github.com/SocialSisterYi/bilibili-API-collect)
