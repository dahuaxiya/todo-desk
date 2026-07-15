# macOS 签名、公证与发布

普通用户直接安装 Todo Desk，Release 包必须同时通过 Developer ID 签名、Apple 公证和 Gatekeeper 校验。仅使用 ad-hoc 签名的包在本机可能能运行，但从 GitHub 下载后会带有 quarantine 属性，macOS 会提示应用“已损坏”。

## 当前发布限制

`v0.2.2` 的现有 macOS 附件没有 Developer ID 签名和公证，不能作为面向普通用户的正式安装包。它的文件摘要与 GitHub 上的附件一致，问题不是下载不完整，而是发布产物缺少 Apple 信任链。

没有 Apple Developer Program 账号和 `Developer ID Application` 证书时，无法生成所有用户都能直接打开的公共安装包。当前过渡版本需要先把 App 复制到 Applications，再移除 quarantine；这不能代替正式签名：

```bash
xattr -dr com.apple.quarantine "/Applications/Todo Desk.app"
open "/Applications/Todo Desk.app"
```

Agent 从 GitHub 链接安装时不需要克隆源码。它应单独下载独立安装脚本：

```bash
set -euo pipefail
INSTALLER="$(mktemp -t todo-desk-installer)"
trap 'rm -f "$INSTALLER"' EXIT
curl --fail --location --silent --show-error \
  https://raw.githubusercontent.com/dahuaxiya/todo-desk/main/scripts/install-macos-release.sh \
  --output "$INSTALLER"
bash -n "$INSTALLER"
bash "$INSTALLER"
rm -f "$INSTALLER"
trap - EXIT
```

`scripts/install-macos-release.sh` 会从 GitHub API 解析最新架构匹配的 DMG，校验 Release SHA-256 和 `CFBundleIdentifier=com.codex.todo-desk`，再安装、处理 quarantine、启动并检查 API。下载、校验、安装、启动或健康检查任一步失败，Agent 都必须报告错误，不能宣称安装成功。

## 一次性准备

1. 加入 [Apple Developer Program](https://developer.apple.com/programs/)。
2. 在 Apple Developer 的 Certificates 页面创建 `Developer ID Application` 证书。
3. 把证书及其私钥从“钥匙串访问”导出为有密码的 `.p12` 文件。
4. 在 App Store Connect 的“用户和访问 > 集成”中创建 API Key，下载仅能下载一次的 `.p8`，并记录 Key ID 和 Issuer ID。
5. 在 GitHub 仓库的 `Settings > Secrets and variables > Actions` 中创建以下 Secrets：

| Secret | 内容 |
| --- | --- |
| `MACOS_CERTIFICATE_P12_BASE64` | `.p12` 文件的 Base64 内容 |
| `MACOS_CERTIFICATE_PASSWORD` | 导出 `.p12` 时设置的密码 |
| `APPLE_API_KEY_P8` | `.p8` 文件的完整文本内容 |
| `APPLE_API_KEY_ID` | App Store Connect API Key ID |
| `APPLE_API_ISSUER` | App Store Connect Issuer ID |

在 macOS 上可用下面的命令生成第一个 Secret：

```bash
base64 -i DeveloperIDApplication.p12 | pbcopy
```

证书必须包含私钥并且类型是 `Developer ID Application`。API Key 至少需要能够提交 notarization；建议为发布专用 Key，不要复用个人凭据。

## 发布新版本

先修改 `package.json` 版本并提交，再创建与版本完全一致的 tag：

```bash
git tag v0.2.3
git push origin main
git push origin v0.2.3
```

`.github/workflows/release-macos.yml` 会在 `v*` tag 推送后执行：

1. 检查证书和公证 Secrets，缺少任意一项立即失败。
2. 构建 Apple Silicon `arm64` 和 Intel `x64` 的 DMG、ZIP。
3. 使用 Hardened Runtime 和 Developer ID 签名应用。
4. 向 Apple 提交公证并把公证票据 staple 到应用。
5. 校验完整签名、Team ID、Hardened Runtime、staple 票据和 Gatekeeper 结果。
6. 所有校验通过后，才把四个安装包上传到对应 GitHub Release。

本地已安装证书和公证环境变量时也可以执行：

```bash
npm run dist:mac
npm run verify:mac
```

只需要验证开发构建时，可以显式生成不用于发布的 arm64 `.app`：

```bash
npm run dist:mac:unsigned
```

## 发布验收

最终 Release 应包含以下四个文件，文件名中的版本以实际版本为准：

```text
todo-desk-0.2.3-arm64.dmg
todo-desk-0.2.3-arm64.zip
todo-desk-0.2.3-x64.dmg
todo-desk-0.2.3-x64.zip
```

除 CI 校验外，发布后还应在一台没有开发证书的 Mac 上从 GitHub 下载 DMG，确认可以打开、拖入 Applications，并在不执行 `xattr` 的情况下首次启动。
