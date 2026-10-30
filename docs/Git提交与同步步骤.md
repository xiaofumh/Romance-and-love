# Git 提交与同步步骤

## 本次操作

1. 检查目标仓库、可见性、分支及写权限。本次目标为`xiaofumh/Romance-and-love`，公开空仓库，默认分支`main`。
2. 独立整理源码。复制`src/tests/scripts/docs`、构建配置、依赖锁及空白环境模板，排除依赖、构建物、真实密钥、聊天、二维码、日志和本机回溯包。当前已部署工程保持原样。
3. 检查实际上传列表，运行`pnpm check`。确认核心源码和测试内容与V0.5.0一致，文档只整理说明及本机路径。
4. 在独立同步目录初始化Git，设置目标远端，将确认的169个文件加入暂存区并核对暂存内容；创建V0.5.0源码提交，再推送到`main`。远端原为空仓库，因此这条源码提交就是首个版本。以后提交接在现有历史之后，不强制覆盖分支。
5. 回读远端分支、提交及文件树，核对实际文件和Git blob摘要。GitHub上的提交记录提供回溯依据；本机原有源码／回溯包继续保留。

本次先检查GitHub连接器，读取仓库成功，但创建文件返回403（连接器内容写权限不足），于是改用本机Git。推送认证由本机Git凭据管理器处理，不在聊天或源码中保存访问令牌。Git的三个概念分别是：暂存区选择本次文件，提交记录版本与父提交，推送让远端分支指向新版本。

## 以后用命令行更新

首次下载到新目录：

```powershell
git clone https://github.com/xiaofumh/Romance-and-love.git
cd Romance-and-love
pnpm install --frozen-lockfile
pnpm check
```

修改后，先查看目标仓库和差异：

```powershell
git remote -v
git status --short
git diff
pnpm check
```

选择本次确实修改的文件加入暂存区；以下只是源码修改示例，按实际文件调整：

```powershell
git add src tests scripts docs README.md .gitignore
git diff --cached --stat
git diff --cached
git commit -m "feat: improve companion conversation"
git push origin main
```

`git add`选择文件，`git commit`创建本地版本，`git push`上传本地提交。只改了依赖时，也要检查并提交`package.json`与`pnpm-lock.yaml`。推送后在GitHub核对最新提交和文件；推送被拒绝时先检查远端变化，不直接强制覆盖。


## 2026-10-30 V0.5.1 更新

沿用现有main历史，先核对远端仍为19e670c，再检查源码差异与305项离线测试；明确选择本次源码、测试、配置和文档加入暂存区，提交修复版本并普通推送，最后回读远端提交和文件树。不上传真实测试报告、二维码、密钥或回溯包，不强制覆盖历史。具体命令在本次操作聊天中逐步说明。

主修复提交984683c已推送。后续真实调用发现生成质量异常，因此增加聊天采样及实际值审计；完整离线检查增至349项。这部分接在已有提交之后单独提交，不修改已经公开的提交历史，也不把降低温度解释为已确定根因或保证稳定。
