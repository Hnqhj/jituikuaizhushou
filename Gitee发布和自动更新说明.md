# Gitee 发布和自动更新说明

## 原理
插件启动后会读取 `TimelineQC/update_config.json` 里的 `manifest_url`。  
如果 `update.json` 里的版本号高于本地版本，插件会下载 ZIP，解压到本地更新缓存，并在 DaVinci Resolve 关闭后自动替换插件目录。

## Gitee 配置
当前记录的 Gitee 仓库：
```text
https://gitee.com/qhjnb123456/chicken-leg
```

1. 在 Gitee 创建仓库。
2. 把 `TimelineQC/update_config.json` 里的 `manifest_url` 改成：
   ```text
   https://gitee.com/你的用户名/你的仓库/raw/master/update/update.json
   ```
3. 每次发布新版本时，先运行打包脚本：
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts/build_release.ps1 -DownloadBaseUrl "https://gitee.com/你的用户名/你的仓库/releases/download/v1.3.4"
   ```
4. 在 Gitee Releases 创建 `v1.3.4`，上传生成的 ZIP。
5. 确认 `update/update.json` 里的 `url` 指向这个 ZIP，`sha256` 不为空。
6. 推送代码和更新清单：
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts/publish_gitee.ps1 -RemoteUrl "https://gitee.com/你的用户名/你的仓库.git"
   ```

## 注意
- 真实推送需要你的 Gitee 仓库地址和登录权限。
- 自动替换会等待 Resolve 退出，避免覆盖正在加载的插件文件。
- 如果 `manifest_url` 为空，自动更新会自动跳过，不会影响插件启动。
