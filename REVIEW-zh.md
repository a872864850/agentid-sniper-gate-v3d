# agentid-sniper 学习笔记与代码审查

审查对象：`nancyc0813-maker/agentid-sniper` v2.8.3（MIT）
审查时间：2026-11-02
审查方式：`git clone` 全量历史 + 逐段读码 + 哈希校验 + 出站域名提取；**未执行**任何交易。

---

## 1. 它是什么

一个跑在本地 Windows/Linux 上的常驻 Node 脚本，专打 BSC 上**只允许 .ai Agent ID 持有者参与**的铸造项目：
扫区块找新合约 → 判断是不是 Agent ID 专属 → 过一堆防钓鱼闸门 → 调币安官方 `baw` CLI 先预览再执行 → 开池后按规则自动止盈 → Telegram 通知/下指令。

卖点不是"快"（README 自己承认拼不过 MEV 机器人，每笔预览+执行要 10–15 秒），而是**赛道隔离**：没有 .ai 身份的机器人进不来。

## 2. 代码结构（实测）

| 项 | 值 |
|---|---|
| 仓库大小 | 1.2 MB，102 个 commit（2026-10-29 起，几乎每天多次提交） |
| 单文件 | `watch.mjs` 1901 行 / 221 KB / 约 100 个函数 |
| 依赖 | `node:child_process`、`fs`、全局 `fetch`；唯一 npm 依赖 `telegram@2.26.22`（仅开群组监控时首启自动装） |
| 其它文件 | `setup.mjs`（向导）、`login.mjs`（登录取链）、三个 .bat/.vbs 启动器、`config.example.json` |
| 混淆 | 无。长 base64 串 0 个，无 eval/new Function，210KB 全是可读逻辑 |

## 3. 流水线（五个阶段，都能在代码里找到对应函数）

**① 发现**（`scanNew` / `proxyScan` / `mintScan` / `hotScan` / `toshWatch` / `flapAgentWatch`）
每 3 秒拉一次新区块，看三类事件：合约创建（含 CREATE2 部署器、工厂）、代理实现（EIP-1967/Beacon）、Transfer 铸给零地址。
六层兜底：合约码里有 Agent ID 登记合约 `0x60B9…022F`；热度（3 分钟 ≥12 钱包）；聪明钱包；后端签名型（打它的钱包六成持有 .ai）；铸造事件（30 分钟 ≥6 钱包）；TG 群/频道/热门网址。

**② 判定**（`agentOnly`）
先看合约字节码是否引用登记合约，再回退到"打它的钱包里 .ai 占比"。

**③ 闸门**（`riskBlock` / `riskDay` / `isRepeatDev` / `blacklist` / `nftStrict` / `drainCheck`）
这一步是全仓库写得最重的地方，判据包括：同一部署者 24h 内多项目、同款代码批量部署、新钱包部署、假进度（要 ≥20/40 个不同钱包付款）、合约里的钱被转光、可升级合约、NFT 图片是假的/复用、以及**每钱包每天手续费 ≤0.01 BNB**。

**④ 模拟 + 铸造**（`previewExec` / `autoMint` / `learnReplay`）
只调官方 CLI：`contract-call preview` → 校验 → `contract-call execute --requestId`。
`previewExec` 的校验条件是我重点看的（watch.mjs:925 起）：

- `balanceChanges` 里**不能有该钱包以外的资产减少**，扣款**不能超过预期 1%**
- `allowanceChanges` 里出现非目标 spender → 直接拒绝
- 免费铸造必须**净额为正**（拿到又被转走 → 不送）
- 失败自动 `approvals revoke`，不留授权

**⑤ 持仓与止盈**（`holdings` / `sell` / `packSell`）
价格取 DexScreener + GeckoTerminal + 池子报价里最好的一个；规则 `backX 2 倍回本、10 倍卖 30%、20 倍再卖 50%、回落 40% 全卖`，用"每颗价格"算，避免卖掉一部分后被误判成暴跌。

## 4. 我实际做的安全检查

| 检查 | 结果 |
|---|---|
| 是否读取私钥/助记词/keystore | **没有**。全仓库无 `privateKey`/`mnemonic`/`keystore` 相关代码 |
| 是否自己签交易 | **没有**。全部走 `baw contract-call execute` / `market-order swap`，签名在币安侧 |
| 出站域名（唯一 19 个） | BSC 公共 RPC ×8、DexScreener、GeckoTerminal、honeypot.is、BscScan、Element、IPFS/Arweave、`api.telegram.org`、`raw.githubusercontent.com`、`toshx.xyz`（ToshX 平台项目元数据）。**无不明域名** |
| 文件读写范围 | 只读自己目录下的 `config.json`、`data/*.json`、`data/watch.log`；无 `.baw` 会话读取 |
| 完整性 | `version.json` 的 sha256 = `e020fd…e558fe`，与 `watch.mjs` **按 LF 归一化后完全一致**（CRLF 差异导致直接比对不符，这不是篡改） |
| 自更新 | 只在用户回 `/update` 时执行：sha256 必须匹配 + **新增域名白名单检查**（出现没见过的站就拒）+ **危险模式计数检查** + `node --check` 语法校验 + 备份旧版 |
| 多开保护 | `data/watch.lock` 按 PID 互斥，防重复铸造 |

**结论：代码可信度高于同类"一键搬运"工具平均水平，没有后门迹象。**

## 5. 真实风险（不是危言耸听，是我从代码里看到的边界）

1. **它有执行权**：配置好后，工具能对 4 个钱包执行任意合约调用的预览与发送，只受"每钱包每项目 ≤20U、每天 ≤60U、keepBnb 0.006"约束。这 20U 是**单笔上限**，不是单日上限。
2. **合约是别人写的**：项目方随时能做出"看起来像 Agent ID 专属、进度刚好到门槛"的盘子。作者已经打了多轮补丁（随机门槛 v2.6.3、假进度 v2.7.0），说明这场攻防是持续的，不是一次性解决。
3. **TG 就是你的操作台**：`data/tg_user.json` 是 TG 账号的 MTProto 会话（只在使用群组监控时生成），等于账号登入凭证；`tg_login` 会把登录链接发到 TG。botToken / chatId 泄露 = 别人能看你的持仓、也能回指令卖币。
4. **流量**：每分钟约 130 个完整区块，一天可能几 GB，家用网络要注意。
5. **收益不确定性**：免费项目只通知不自动打；付费项目要同时满足进度 + 30 天开的盘 + 合约权限检查。默认设置下"打空转"的概率不低。

## 6. 与我们环境的适配度（这是最有价值的部分）

四个钱包**全部已持有 .ai 身份**，这是这类工具唯一硬性前置条件，我们已满足：

| 钱包 | 地址 | .ai 名称 | BNB 余额 | 备注 |
|---|---|---|---|---|
| 一号 | `0xA6dF…DAFD` | `0xhhj.ai` | 0.2066 | 主号，不建议先上 |
| 二号 | `0xdAd2…0510` | `buy888.ai` | 0.0405 | 余额最薄 |
| 三号 | `0x9719…9C52` | `676676.ai` | 0.1199 | |
| 四号 | `0x9143…E373` | `w000.ai` | 0.0615 | |

会话隔离方案**已经存在**（`wallet-multi/wallets/*` + `instanceId`），工具的 `bawDir`/`instanceId` 配置项就是这套机制，**不需要重新扫码**，只要把路径指过去。

## 7. 我的建议

- **不要一次上四个钱包**。先用**三号**（`676676.ai`，0.1199 BNB，余额够但非主号）单钱包跑 3–7 天，`paid.maxUsd` 压到 **5U**，`keepBnb` 0.01。
- 先只开通知、`paid.maxUsd: 0`，观察它到底会打什么，再决定是否放开。
- 部署位置建议单独目录，别直接放在 DSH 工作目录里被我的记忆归档扫到。
- 是否跟进，取决于你是想要"每天几十个免费项目通知"（价值低但零成本）还是"自动打付费项目"（有成本、有本金风险）。

## 8. 若要部署（我这边可代做）

1. 复制仓库到 `<用户目录>\agentid-sniper`（不动工作目录）
2. 用现有注册表生成 `config.json`：每个 `bawDir` 指向本机已登录钱包的 baw 目录，`instanceId` 用现有值
3. 需要你提供：TG bot token、你的 chat id（或跳过通知）
4. 启动 `node watch.mjs`，前台观察 10 分钟日志，确认 `登入門檻` 与 `wallet status CONNECTED`
5. 首周只看不买（`paid.maxUsd: 0`）

> 提醒：以上第 4 步之后工具会**持续**调用 `baw`，与我在会话里的手工查询共享同一批登录会话。多开轮询有没有冲突未验证，建议部署前后不要并发查询。
