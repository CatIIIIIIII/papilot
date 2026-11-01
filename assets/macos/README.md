# Papilot macOS 图标

延续 `src/web/logo.svg` 的蓝白笔尖和四角星，保留第一版笔尖的轮廓、配色和阴影，仅将底板增强为从左上白色到右下浅蓝的柔和渐变。由现有矢量标志直接制作，无 AI 位图生成。

## 桌面打包

- `Papilot.icns`：传统 macOS app bundle、Electron 或 Tauri 打包使用。
- `Papilot.png`：1024 × 1024，透明外边距，已绘制圆角、背景渐变和轻微阴影。
- `Papilot.svg`：上述静态版本的可编辑矢量源文件。
- `Papilot.iconset/`：16、32、128、256、512 pt 的 1x/2x PNG，共 10 个文件，最高 1024 px。
- `preview.png`：浅色、深色背景及小尺寸效果，仅供预览。
- `variants/Papilot-flat.svg` / `.png`：第一版图标，保留供对比；当前版本仅加强了背景渐变。

`Papilot.icns` 可直接作为打包配置中的 macOS icon。原生 app bundle 将它放入 `Contents/Resources/`，并在 `Info.plist` 中将 `CFBundleIconFile` 设置为 `Papilot.icns`。本次只交付图标资源，尚未修改桌面应用配置。

## Icon Composer / 新版 macOS

Apple 当前推荐使用未预裁圆角的 1024 × 1024 分层素材，让系统绘制圆角与动态视觉效果。`icon-composer/background.svg` 是不透明满幅背景；`icon-composer/foreground.svg` 是透明前景，未烘焙高光或阴影。两者保持相同画布与中心对齐，可导入 Icon Composer 后检查不同外观并导出 `.icon`。

不要把带透明边距、已裁圆角的 `Papilot.png` 作为 Icon Composer 的背景层。分层 SVG 使用相同的背景渐变与平面前景，让系统生成视觉效果，不烘焙静态阴影。此目录的分层 SVG 是制作素材，不是已验证的 `.icon` 工程；深色和染色外观需在最终应用中预览。

参考：[Apple App icons HIG](https://developer.apple.com/design/human-interface-guidelines/app-icons)、[配置 App Icon](https://developer.apple.com/documentation/xcode/configuring-your-app-icon)。

## 重新导出

在 macOS 上安装项目的 review 依赖和 Google Chrome 后，从仓库根目录运行：

```sh
node scripts/build-macos-icon.mjs
```

脚本读取 `Papilot.svg`，导出 PNG / iconset / 预览，并通过 macOS `iconutil` 打包 ICNS。Icon Composer 的平面分层源文件单独维护。
