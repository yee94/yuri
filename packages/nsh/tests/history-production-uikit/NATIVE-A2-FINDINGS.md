# native a2：deadline修复与只读证据结论

来源为main保留的 `.scratch/nsh/history-production-cec5b612-native-diagnostic-a2/`。本轮不写该目录、不把手动保全当finalization；main已经终止隔离App，worker没有执行engine、设备、Host、Git或SDK/build。原生产三region −53pt仍红，adoption未证明及1033ms编码缺口不变。

## a2实际做到了什么

手动保全文件含3669个native样本，startupSweeps=1/rejected=0/mutations=0、overflow=false。runner没有写最终result；actions最后一条flush没有return观察，不能认作ACK或已完成。前一个flush有真实returncode0及receipt；最后一个gesture end也确有CLI returncode0。这与main报告的“无残留touch证据”一致，但CLI返回不是UIKit接收ACK。`manual-preservation.json`明确声明不是acceptance，保留原义。

| 证据 | 可确认事实 |
| --- | --- |
| Host journal | 20个history-response全部requestCursor=null，反复返回同一组hp-0480…0499，nextCursor始终history.before.480；older request=0、older response=0、complete response=0 |
| 事前mark | 0；全部是探索，没有合格的三anchor诊断窗口 |
| 实际滚动 | scope seq569→3669，offset从3966降到3063.3333，仅推进902.6667pt；footer仍约−3063.3333pt，没有到旧端边界 |
| 输入可达性 | 首两次目标拖动约268.07、436.07pt，随后85.41pt，再连续降到10.073pt；后续CLI仍返回0，但native pan generation最大只有3，出现raw state5，offset/footer停住 |
| 完整旧body | root层完整三body仅seq795–816约350.710ms；扣除compact顶部780外界限后仅seq795–801约100.607ms，且处于运动中，不满足250ms静止基线 |
| 三body几何 | pagination-01必要平移区间仅约[2.667,27.667]pt；02及后续观察到的0494/0495/0497三body跨度1272.9998pt，比780pt外界限多492.9998pt，这个具体三元组不可能同时完整容纳。不能外推为全部历史始终不可能 |

原review取样是两个用户短气泡与assistant动作栏，不等同于当前三完整body；旧review没有raw message pages。本轮不臆造原Host payload，也不放宽当前三body门槛。

## 是否观察到额外位移

在探索scope seq569–3669的**已记录**同实例样本中：

- contentHeight一直4840pt；同一viewport实例，x/y/width无变化，height数值范围仅约9.1e−13pt。
- 已观察同实例body/turn-row没有>1.1pt的高度变化。footer近端三个祖先一直44pt，其他观察祖先为全屏874pt；没有观察到footer footprint释放或body自然增高。
- 4213个相邻静止body采样对的最大screen step为0；767个连续changed输入/body采样对的最大`screenDelta-panTranslationDelta`约3.41e−13pt。所有9207个可比相邻body对的`screenDelta+offsetDelta`为0，屏幕移动与实际scroll offset对应。
- pagination-02→03之间约53pt的footer/screen移动对应offset 3193.6667→3140.6667，两个端点native flags仍在运动中；它不构成额外53pt信号，更不能冒认原生产−53pt。

**这些数值不是稳定通过。** 存在33个>50ms的native观察gap，最大534.741ms（seq2854→2855）；其中32个gap内有实际native flush事件。另两个大gap为503.297ms（2841→2842）和484.221ms（3660→3661）。旧Observer在main actor同步序列化/写capture，flush相关采样暂停是优先解释，但没有覆盖缺口内部的显示过程。没有三anchor mark、没有older分页、没有后clock/final flush ACK，因此本轮只能inconclusive，不能排除缺口内瞬态，不能替代像素验收。

## 基于a2的优先级，而非盲修production

| 排名 | 解释/状态 | a2支持或限制 | 下一步 |
| --- | --- | --- | --- |
| 1 | 驱动固定0.76终点使探索退化为极短未识别手势 | 目标起点y≈0.74847，拖到0.76只有10.073pt；多次命令后pan generation/offset不前进 | 已改为实际composer/viewport边缘内一屏幕像素的终点界限；不再重复<32pt导航尝试。32pt只是驱动导航准入，不是UIKit阈值或位移验收阈值 |
| 2 | flush相关native采样暂停 | 33个gap中32个包含native flush；最大534.741ms | 不把gap抹平或放宽50ms；a3缩短到首个older事件，保留实际缺口。旧Observer/tools不改 |
| 3 | 三body可见窗口过窄/被大拖动跳过 | 初始有约25pt必要区间；仅100.607ms处于composer外界限内且移动；后续具体三元组跨度1273>780 | 不换成copy图标、不事后mark。先取得实际older事件原始native反馈，三body仍不合格时明确标未完成 |
| 4 | 原footer释放/倒序List采用补偿 | a2从未请求older，footer祖先未收缩，contentHeight不变 | 本轮没有触发条件，不能支持或否定其为原53pt根因；必须先触发真分页/终页 |
| 5 | 原旧row自然增长 | 一次hp0499 exact-fill发生在探索scope之前，scope内观察到的旧row/body高度稳定 | a2没有单独增长阶段证据，不能关闭该范围；不把tail读取的growthGeneration计数当实际增长（growth=false） |

## deadline与未完成操作修复

旧SIGALRM handler直接raise，可在`setitimer(0)`自身被投递，跳过整个finally。新handler只记录expired，不抛异步异常；结束工作时先屏蔽SIGALRM、记录pending、取消timer并设为ignore，丢弃pending后才恢复mask进入清理，清理后恢复原handler。所有超时导致顶层inconclusive。

开始时就原子写入running/inconclusive checkpoint；每条命令执行前保存in-flight动作，Popen超时/取消会kill并有界回收，记录实际returncode/stdout/cancellation，绝不把迟到stdout当ACK。flush只有客户端实际返回且nonce/revision/sequence与capture匹配后才标ACK；不匹配raw另存unacknowledged，不产生final-capture。touch-end、clock、flush、离线分析任一失败，actions/phases/attempts/result仍分别尝试原子保存。70秒后不再发新的设备/读口子进程；不能保证被SIGKILL或磁盘永久不可写时完成文件，但正常超时/清理异常不会再跳过结果记录。

## 最窄a3动作

main重启同一已装cec5b612，无需重build；只跑pagination，最多12次导航，首个真实older响应即停止探索并保存inconclusive证据，不再让未mark探索追完整终页。两次没有实际scroll/page进展也提前停止。

```sh
python3 packages/nsh/tests/history-production-uikit/native-diagnostic.py \
  --config .scratch/nsh/history-production-cec5b612-smoke-a1/config.json \
  --output .scratch/nsh/history-production-cec5b612-native-diagnostic-a3 \
  --modes pagination --max-navigation 12 --pan-distance 0.5 \
  --execute-main-only
```

a3只回答“有界真实输入能否到达首个older request/response、其前后原生几何如何”，不承诺三anchor或原53pt复现。normal/terminal现有fixture均从500条tail起步，完整终页需25页；若需短程直接验证完整footer释放，应另派独立minimized terminal builder/artifact，显式`original53ptSameScenario=false`，不能改旧cec数据、不能假原payload。本轮只修driver，没有新增该carrier。

只读重放本报告的原始统计（exit2=inconclusive，不写旧目录）：

```sh
python3 packages/nsh/tests/history-production-uikit/native-diagnostic.py \
  --audit-saved .scratch/nsh/history-production-cec5b612-native-diagnostic-a2
```

证据SHA256：manual-preserved-capture `513a058d9a66d855f21fa0cf6855ed2bb5887a42a233bd485e2f5dfadcbff484`；actions `c46bcd64ece6bcff28fe2677115d54eb37a13d1c4d3a48b2001d100c8ed0d203`；phases `325e027f550a2611dd1ffd0eda4ab5f0824542b52ba8d5fb1c54ed8943ad9aaa`；manual-preservation `8aaad6a64d1adf2ad594b6ffa2a97d376484fac1733d622789e5c54c785c6d5d`。

## 本轮验证记录

- 两个focused Vitest入口通过：`native-diagnostic.test.ts`与`feedback.test.ts`，内部共42项Python纯测（26+16），覆盖真实pending SIGALRM、取消timer时投递alarm、清理异常保全、子进程取消及flush ACK匹配。
- 真实a2只读重放得到上述分页、几何和gap统计；三份修改过的Python文件通过AST语法检查。
- a2四份核心证据SHA256与记录一致；a2记录的strict smoke/moving源码SHA、冻结cec5b612 App/tools以及stationary checker均核对未变。
- `bun run dead-code`已完成并审阅：报告没有`history-production-uikit`条目；仓库其他模块仍有unused/duplicate报告，并提示`packages/nsh`的74个unused files需细化入口配置。该检查不证明Python动态加载可达性，其加载路径由focused纯测覆盖；本轮未改其他owner文件。
- 未运行engine、SDK/build、设备、真实Host或Git。修后a3尚未由main执行；静态检查和纯测不构成原生运行、连续显示或原53pt验收证据。
