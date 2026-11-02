# agentid-sniper 修改说明（v3e · C 方案 + 退款期 1～10 天 + 没有官网不打）

打包时间：2026-11-02 10:50（Asia/Shanghai）；v3e 追加于 11:50
闸门版本：`GATE_VERSION = v3e`、`SITE_VERSION = v1`（`gate.mjs` / `site.mjs` 导出的常量可直接核验）

## 一、本包相对上游的改动清单

| 文件 | 状态 | 说明 |
|---|---|---|
| `gate.mjs` | **新增/重写（v3e）** | 进场闸门：四条硬条件 + 退款期软条件 + 官网检查挂钩 |
| `site.mjs` | **新增（v1）** | 官网判定：位元码字串 / 链上 getter / 群里网址 / DexScreener / 人工白名单 |
| `gate-site-test.mjs` | 新增 | 9 个离线案例验证「有官网放行、没官网拦下」（不联网） |
| `site-backtest.mjs` | 新增 | 用真实合约测「官网能不能看出来」 |
| `gate-window-test.mjs` | 新增 | 8 个离线假合约单元测试，验证「1～10 天」判定 |
| `gate-backtest.mjs` | 新增 | 用历史 `watch.log` 回测闸门通过率 |
| `gate-test.mjs` | 新增 | 单合约闸门诊断工具 |
| `lpwatch.mjs` | 新增 | 开池后 LP 锁仓验证（读 pair.totalSupply / balanceOf(dead)） |
| `lpwatch-loop.mjs` | 新增 | LP 看门狗常驻进程，20 分钟一轮 |
| `refundprobe.mjs` | 新增 | `refund()` 真实 `eth_call` 探测（带 0xdeadbeef 对照组） |
| `probe-lp.mjs` / `probe-lp2.mjs` / `probe-v3.mjs` / `_capscan.mjs` / `_diag.mjs` | 新增 | 一次性调研脚本（LP 检测 / 总量扫描 / 诊断） |
| `watch.mjs` | 修改 | autoMint 里插入闸门调用（NFT 过滤、免费判定之后，模拟签名之前） |
| `config.json` | 修改 | 新增 `sniping` 段全部参数（见下） |

## 二、闸门判定顺序（fail-closed：读不到就不打）

1. **总量读得到**：`requireCap:true`、`capMin:5`（数值不限，任意总量均可）
2. **有买家退款入口**：`requireRefund:true`，字节码需含 `refund / claimRefund / refundAll` 等选择器
3. **没有提款函数**：`requireNoWithdraw:true`，禁止 `withdraw / rescue / sweep / skim / emergencyWithdraw`
4. **管理权限 ≤2**：`maxAdminPerms:2`，白名单只放行 `pause/unpause/setPaused` 与 `setMintStart/setStartTime/setMintTime`
5. **（软）退款期 1～10 天**：`requireRefundWindow:"auto"`，扫到秒/区块常量就校验区间；扫不到不否决（由事后探测证明）
6. LP 相关全部关闭：`requireAutoLp:false`、`lpMode:"off"`、`requireLpBurn:false` —— 改为开池后由 `lpwatch-loop.mjs` 事后验证
7. **（v3e）没有官方网站不打**：`requireWebsite:true`，由 `site.mjs` 找官网；找到还要 `siteVerify` 证明首页打得开且提到这个币

> 手动 `打 0x...` 不受上述限制，只约束自动流程。

## 三之二、官网判定（v3e）

来源按「先便宜后贵」顺序，找到就停：

| 顺序 | 来源 | 说明 |
|---|---|---|
| ① | `data/site_allow.txt` | 人工认可：一行一个合约地址或网域，直接放行、不再验证 |
| ② | 群里传过的网址 | `watch.mjs` 的 TG 群监控把网域对到合约（需先 `node watch.mjs --tg-login` 登入一次） |
| ③ | 合约位元码里的网址字串 | 扫 ASCII 里的 `https://…` 与域名 |
| ④ | 链上 getter | `website() / site() / url() / homepage() / officialSite() / socials() / info() / description()` 等 15 个 |
| ⑤ | DexScreener | `info.websites`（开池后才有，事前等于没有） |

`siteVerify:true` 时会真的抓一次首页（8 秒超时）：**打不开**或**页面完全没提到这个币**都算没有官网（防假官网／死网址）。

## 三之三、退款期参数

```json
"requireRefundWindow": "auto",      // auto | true | false
"refundWindowMinDays": 1,
"refundWindowMaxDays": 10,
"refundProbeAfterMint": true
```

- `auto`：字节码里若出现天数常量（86400～864000 秒，或 28800～288000 区块），要求落在 1～10 天；没有常量则放行。
- `true`：必须扫到 1～10 天常量，否则拦截（实测通过率归零，因为发射台合约的窗口多来自构造函数/immutable）。
- 事后由 `refundprobe.mjs` 用真实地址 `eth_call refund()`，附 `0xdeadbeef` 对照组，能区分「有入口」「自定义错误码」「空 revert 不可判定」。

## 四、如何运行

```powershell
cd agentid-sniper-review
node gate-window-test.mjs                     # 8 个离线案例
node gate-backtest.mjs .\data\watch.log 80    # 回测通过率
node watch.mjs                                # 狙击引擎
node lpwatch-loop.mjs                         # LP 看门狗（另开窗口/后台）
node refundprobe.mjs --watch                  # 退款探测（另开窗口/后台）
```

## 五、验证结果（打包时的实测数字）

- `gate-window-test.mjs`：**8/8** 案例符合预期（1/3/7/10 天放行，20/30 天拦下，区块写法放行，无常量 auto 放行）
- `gate-backtest.mjs`（最近 80 个合约）：**21/80 = 26.3%** 通过；严格窗口模式下 0/80
- `refundprobe.mjs`（40 笔已铸币）：24 笔自定义错误（其中 `0x13112018` = `RefundClosed()`）、16 笔不可判定、0 笔无入口
- `lpwatch-loop.mjs`（184 个已铸币）：有交易对 **0** 个 —— 这批免费项目至今无一开池

## 六、注意事项

1. `config.json` 里 `telegram.botToken` 为空，告警只落文件，不推送。
2. `data/` 未打包（含 `watch.log` 2.9MB、`watch_state.json` 2.3MB、探测 JSON），需要可单独取。
3. `watch.mjs` 的 4 处免费补丁（`paid.freeOnly`）是上游之外的修改，重装或更新上游会丢失，需重新打。
4. 若上游覆盖 `gate.mjs`，闸门即失效；升级后先跑一次 `node gate-window-test.mjs` 确认仍是 v3d。
