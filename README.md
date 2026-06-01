[README.md](https://github.com/user-attachments/files/28456438/README.md)
<div align="center">

# 🍗 鸡腿快助手 / Chicken Leg Quick Assistant

**DaVinci Resolve Studio 短剧时间线质检插件**

[![Version](https://img.shields.io/badge/version-1.3.4-blue.svg)](https://github.com/Hnqhj/jituikuaizhushou)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-lightgrey.svg)]()
[![DaVinci Resolve](https://img.shields.io/badge/DaVinci%20Resolve-Studio-orange.svg)]()

</div>

---

## 🇨🇳 中文说明

### 简介

鸡腿快助手是一款专为 DaVinci Resolve Studio 设计的短剧时间线质检插件，面向竖屏短剧交付场景，提供一键式自动化质量检查，帮助剪辑师和审片人员快速发现时间线中的常见问题。

### 功能特性

| 检查项目 | 说明 | 标记颜色 |
|---------|------|---------|
| 短剧结构检查 | 堆叠预判、夹帧检测、片段完整性分析 | — |
| 黑帧检测 | 检测画面中的单帧黑帧 | 🔴 Red |
| 黑场检测 | 检测持续多帧的黑场画面 | 🟣 Purple |
| 夹帧检测 | 检测画面中的闪帧/夹帧 | 🟡 Sand |
| 未调色检测 | 识别未经调色处理的片段 | 🟡 Yellow |
| 过曝检测 | 检测画面过曝区域 | 🟢 Green |
| 单声道检测 | 检测音频轨道单声道问题 | 🩷 Pink |
| 格式检查 | 交付格式合规性验证 | 🔵 Cyan |

### 核心优势

- **一键检查** — 快速检查 + 精确检查 + 批量检查，灵活组合
- **自动标记** — 检查结果自动写入时间线标记，支持一键清除
- **低分辨率渲染** — 内置低分辨率抽帧渲染引擎，加速分析流程
- **自动更新** — 支持 Gitee/GitHub 托管的自动更新机制
- **内置运行时** — 打包 Python 运行时、FFmpeg、Pillow、numpy，开箱即用

### 安装方法

1. 关闭 DaVinci Resolve
2. 将 ZIP 安装包完整解压到本地文件夹
3. 确认目录结构：
   ```
   鸡腿快助手_v1.3.4_20260601/
   ├─ install.bat
   ├─ TimelineQC/
   ├─ 安装说明.md
   └─ 免责声明.md
   ```
4. 双击 `install.bat`（需管理员权限）
5. 重启 DaVinci Resolve Studio
6. 在 `Workspace` > `Workflow Integrations` 中打开「鸡腿快助手」

> ⚠️ `install.bat` 必须与 `TimelineQC` 文件夹在同一级目录，单独运行无效。

### 使用说明

1. 确认当前项目已打开时间线
2. 在左侧面板选择时间线或文件夹
3. 先执行**快速检查**，再按需执行**精确检查**或**批量检查**
4. 检查结果会同步写入时间线标记，可直接定位问题位置

### 项目结构

```
TimelineQC/
├── main.js                    # 插件入口（Workflow Integration）
├── preload.js                 # Electron 预加载脚本
├── bridge.py                  # Python 后端桥接
├── backend/
│   ├── main.py                # 核心质检逻辑
│   └── analyzers/
│       ├── black_frame.py     # 黑帧/黑场检测
│       ├── flash_frame.py     # 夹帧检测
│       ├── exposure.py        # 过曝检测
│       ├── ungraded.py        # 未调色检测
│       ├── audio.py           # 单声道检测
│       ├── renderer.py        # 低分辨率渲染引擎
│       └── short_drama.py     # 短剧结构分析
├── frontend/
│   ├── panel.html             # 面板界面
│   ├── panel.css              # 样式
│   └── panel.js               # 前端逻辑
├── manifest.xml               # 插件清单
├── plugin_config.json         # 插件配置
├── update_config.json         # 自动更新配置
└── WorkflowIntegration.node   # 工作流集成节点
```

### 常见问题

- **看不到插件** — 请确认使用的是 DaVinci Resolve Studio 版（免费版不支持 Workflow Integrations）
- **精确检查失败** — 检查 `runtime` 目录是否完整
- **首次启动慢** — Resolve 载入插件和内置运行时需要时间，属正常现象
- **安装脚本找不到 TimelineQC** — 未完整解压安装包或移动了 `install.bat`

### 免责声明

本工具仅用于辅助检查时间线问题，检查结果不构成最终审片结论。你仍然需要对黑帧、黑场、夹帧、未调色、过曝、单声道等问题进行人工复核。本工具与 Blackmagic Design 无隶属关系。灵感来自清何大佬，在此致谢。

---

## 🇺🇸 English README

### Overview

Chicken Leg Quick Assistant (鸡腿快助手) is a timeline quality control plugin designed for DaVinci Resolve Studio, targeting vertical short drama delivery workflows. It provides one-click automated QC checks to help editors and reviewers quickly identify common timeline issues.

### Features

| Check Type | Description | Marker Color |
|-----------|-------------|-------------|
| Short Drama Structure | Stack prediction, flash frame detection, clip integrity analysis | — |
| Black Frame | Detect single-frame black frames in the picture | 🔴 Red |
| Black Screen | Detect multi-frame black screen segments | 🟣 Purple |
| Flash Frame | Detect flash/inserted frames in the picture | 🟡 Sand |
| Ungraded | Identify clips without color grading applied | 🟡 Yellow |
| Overexposure | Detect overexposed areas in the picture | 🟢 Green |
| Mono Audio | Detect mono audio channel issues | 🩷 Pink |
| Format Check | Delivery format compliance verification | 🔵 Cyan |

### Key Advantages

- **One-Click QC** — Quick check + Precise check + Batch check, flexible combination
- **Auto Markers** — Results are automatically written as timeline markers, with one-click clear
- **Low-Res Rendering** — Built-in low-resolution frame extraction engine for faster analysis
- **Auto Update** — Supports Gitee/GitHub hosted auto-update mechanism
- **Bundled Runtime** — Includes Python runtime, FFmpeg, Pillow, and numpy — ready to use out of the box

### Installation

1. Close DaVinci Resolve
2. Extract the ZIP installer to a local folder completely
3. Verify the directory structure:
   ```
   鸡腿快助手_v1.3.4_20260601/
   ├─ install.bat
   ├─ TimelineQC/
   ├─ 安装说明.md
   └─ 免责声明.md
   ```
4. Double-click `install.bat` (requires administrator privileges)
5. Restart DaVinci Resolve Studio
6. Open the plugin via `Workspace` > `Workflow Integrations` > `鸡腿快助手`

> ⚠️ `install.bat` must be in the same directory as the `TimelineQC` folder. Running it alone will not work.

### Usage

1. Make sure a timeline is open in the current project
2. Select a timeline or folder in the left panel
3. Run **Quick Check** first, then **Precise Check** or **Batch Check** as needed
4. Results are written to timeline markers — click any marker to navigate to the issue

### Project Structure

```
TimelineQC/
├── main.js                    # Plugin entry (Workflow Integration)
├── preload.js                 # Electron preload script
├── bridge.py                  # Python backend bridge
├── backend/
│   ├── main.py                # Core QC logic
│   └── analyzers/
│       ├── black_frame.py     # Black frame/screen detection
│       ├── flash_frame.py     # Flash frame detection
│       ├── exposure.py        # Overexposure detection
│       ├── ungraded.py        # Ungraded clip detection
│       ├── audio.py           # Mono audio detection
│       ├── renderer.py        # Low-resolution render engine
│       └── short_drama.py     # Short drama structure analysis
├── frontend/
│   ├── panel.html             # Panel UI
│   ├── panel.css              # Styles
│   └── panel.js               # Frontend logic
├── manifest.xml               # Plugin manifest
├── plugin_config.json         # Plugin configuration
├── update_config.json         # Auto-update configuration
└── WorkflowIntegration.node   # Workflow integration node
```

### FAQ

- **Plugin not visible** — Make sure you are using DaVinci Resolve Studio (the free version does not support Workflow Integrations)
- **Precise check fails** — Verify the `runtime` directory is complete
- **Slow first launch** — Normal behavior as Resolve loads the plugin and bundled runtime
- **Installer can't find TimelineQC** — The ZIP was not fully extracted, or `install.bat` was moved

### Disclaimer

This tool is intended solely for assisting with timeline quality checks. Results do not constitute a final review conclusion. Manual verification is still required for black frames, black screens, flash frames, ungraded clips, overexposure, and mono audio issues. This tool is not affiliated with Blackmagic Design. Inspired by 清何 (Qinghe) — special thanks.

---

## 📄 License

This project is provided as-is. See [免责声明.md](TimelineQC/免责声明.md) for details.
