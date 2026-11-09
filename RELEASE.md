# 发版清单 / Release checklist

发布由维护者手动批准；开发和测试不自动 push 或发布 npm。

1. 对新接口镜像和上游兼容镜像分别跑 E2E：
   ```sh
   SUB2API_IMAGE=sub2api-fork:key-status ./test/run.sh
   SUB2API_IMAGE=weishaw/sub2api:latest ./test/run.sh
   ```
2. 用真实 magpie 分别验证订阅 key 和余额 key（真实请求可能计费）：
   ```sh
   JMDS_KEY=sk-... JMDS_NAME=release-check ./e2e.sh
   ```
   检查单一 `jmds` provider、账号名、用量窗口、余额、模型和真实请求结果。
3. 更新 `package.json` 版本，提交测试产物，保持工作区干净。
4. 由维护者创建并推送与包版本一致的 `v*` tag。
5. `publish.yml` 先调用 CI，然后使用 npm Trusted Publishing（OIDC）发布 `magpie-jmds`。

## 首次发布与 Trusted Publishing

npm 的 Trusted Publishing 按包配置。首次发布须由维护者从已审核的干净检出手动完成；不要提前推 tag 触发尚未配置好的自动发布。

在 npm 的 **magpie-jmds › Settings › Trusted publishing** 中选择 GitHub Actions：

- organization: `zerith-llc`
- repository: `magpie-jmds`
- workflow: `publish.yml`
- environment: 留空

`package.json` 的 repository 必须为 `git+https://github.com/zerith-llc/magpie-jmds.git`。
工作流已配置 Node 24、npm ≥ 11.5.1、GitHub-hosted runner 和 `id-token: write`。
维护者还需配置 CI 的只读拉取凭证 `GHCR_READ_TOKEN` 与镜像标签变量 `SUB2API_FORK_TAG`。
外部 PR 没有该凭证时明确跳过 fork 测试，仍运行上游兼容测试。
