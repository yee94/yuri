# Identity-only短程包：main操作协议

这是独立可安装iOS Simulator包的短程身份诊断，不是历史稳定性验收。默认不注册CADisplayLink，不进行周期几何采样。main明确发出**唯一一次**prepare-ax后，才收集最长600ms/最多24帧的真实native基线，目标275ms；250ms稳定门槛与每读≤5ms不变。基线结束即停止采集，再执行原setter/public getter立即读回。随后read-ax只读取当前状态，不启动周期采样；mark在本profile直接拒绝。没有pan入口。

保留当前v4 typed snapshot/geometry/writer/reader源码，未换schema或删字段。短程baseline的displayLinkTimestampMs明确为null，samplingSource=explicit-identity-baseline；不能伪装成display-link连续记录或用seq换算fps。ready、manifest与导出metadata均标识identity-only/periodicSampling=false/historyDriverAdmission=false。

## main已经取得的独立证据

`.scratch/nsh/coverage-uikit-b1fe65f6/result.json` 已实际返回status=pass、assertionsEnabled=true，调用三个原函数：siblingOverflow、snapshotRejects、typedGeometryParity。sourceHash为 `9a7cf30b3471f17ffcb8490ddb7d71aa46e8a9913a51bf29608e269b2e635b3b`，范围不含Observer/writer/Host/pan。此真实UIKit结果已成立，不再把它写成仅编译；它也不是built Observer token读回或长时性能的运行证明。

## 安装与启动（仅main执行）

新artifact的实际相对路径、bundle ID、可执行文件/bytecode/tool hash见 [5e595357产物冻结](../IDENTITY-5E595357-ARTIFACT.md) 和 [machine-readable索引](../IDENTITY-ARTIFACT.json)。该App是arm64 iOS Simulator目标，adhoc签名，不冒充真机development签名。

先设置 `HP_BUILD` 为该新artifact目录、`HP_UDID`为main选定的已启动Simulator、`HP_HELPER`为main已有serve-sim helper的loopback origin。worker不会启动/查询设备或helper。

```sh
HP_BUNDLE_ID=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["bundleID"])' "$HP_BUILD/manifest.json")
xcrun simctl install "$HP_UDID" "$HP_BUILD/HistoryProductionUIKit.app"
env -u SIMCTL_CHILD_HISTORY_SYNTHETIC_RUN_MODE -u SIMCTL_CHILD_HISTORY_SYNTHETIC_DENSITY -u SIMCTL_CHILD_HISTORY_SYNTHETIC_APPEARANCE -u SIMCTL_CHILD_HISTORY_SYNTHETIC_DIFF_LAYOUT xcrun simctl launch "$HP_UDID" "$HP_BUNDLE_ID"
```

不要继承ui-parity/density/reference appearance环境；ui-parity仍由main原分支拥有，故意没有identity recorder ready。identity包不改其main安装或Host schema。必须使用全新bundle/sandbox；完成后不重复prepare，不删除旧段来伪造新run。已有segments的重启会按fresh-directory合同拒绝，第二次验证另建独立artifact。

## 导航scheme与精确控件

本包**未注册业务URL deep-link scheme**，不要发明openurl。这里的操作scheme是原App的公开AX控件路径：

1. 保持在「项目」Tab，读取一次真实AX：`GET "$HP_HELPER/helper/$HP_UDID/ax"`。root应用应为History Production QA。
2. 若 `project-session-history-production-500` 尚未可见，点击唯一可见且enabled的 `projects-toggle-history-project` 展开项目，然后重新读取AX。不要按离屏/缺失节点猜坐标。
3. 点击唯一可见且enabled的 `project-session-history-production-500` 进入Chat。只做这次导航，不点load older，不拖动，不输入，不打开菜单。
4. 再读取AX，确认 `chat-header-metadata`、`chat-selection` 和当前 `chat-composer-expanded` 或 `chat-composer-compact` 可见。编辑器AX label为「输入消息」，其实际 `yuri-input-editor-*` 后缀以AX为准，不把Composer metadata成功当作正文token成功。
5. 点击若由serve-sim执行，使用AX实际frame中心归一化后的tap（`tap X Y -d "$HP_UDID" --url "$HP_HELPER"`），不使用gesture begin/end模拟tap。没有唯一合法目标就停止并保存AX，不能fallback猜坐标。

读取AX的准确existing-helper路径沿用原driver：

```sh
curl --fail --silent --show-error "$HP_HELPER/helper/$HP_UDID/ax" > "$HP_EVIDENCE/chat-before-prepare-ax.json"
HP_DATA=$(xcrun simctl get_app_container "$HP_UDID" "$HP_BUNDLE_ID" data)/Documents/history-production-v4
```

在发prepare之前检查 `$HP_DATA/ready.json`：observerProfile=identity-only、periodicSampling=false、automaticInput=false、identity与新manifest一致。这里应没有周期产生的frame段，Host来源event可以有限积累；ready不是SDK adopt ACK。

## 唯一短程序列

导航完成且UI已停稳后，main运行冻结工具：

```sh
python3 "$HP_BUILD/tools/identity-probe.py" --build "$HP_BUILD" --data "$HP_DATA" --output "$HP_EVIDENCE/identity-sequence" --helper-origin "$HP_HELPER" --udid "$HP_UDID"
```

该工具只按次序执行：

1. 冻结clock-client `prepare-ax`（触发唯一有限基线与一次赋值/立即读回）；
2. 冻结clock-client `read-ax`；
3. existing helper `GET /helper/<UDID>/ax`，保留原始AX；
4. 冻结clock-client `read-ax`。

没有自动导航、tap、mark、pan、重试、第二次prepare或等待长时profile。原始receipt先保存再核验process/build/nonce、实际durable manifest/hash/revision/seq；慢读窗仍保存，summary明确readExposureWithin5ms=false。若transport/ACK/identity不匹配，工具保存收到的材料后拒绝，main另保全App的failure.json及全部segments，不用旧ACK兜底。

输出为ready.json、prepare.json、native-before.json、ax.json、native-after.json、summary.json。summary的status=collected仅表示这次采集结束；identityReadbacksConfirmed、AX matching count是独立字段，automaticPan/strictAcceptance始终false，SDK adopt始终unknown。读取最终receipt所指manifest可再用冻结 `tools/stream_reader_v4.py` 流式完整核验；不要json.load全capture或调用旧strict/pan driver。

main查看prepare.result.assignmentReadbacks、writeAttemptCount/readbackConfirmedCount、两次binding.valid/retirementReason/firstRetirementObservation、view/body/outer实例与完整geometry，以及AXUniqueId原值。public getter立即非ours即本次身份路径失败，不再prepare抢ID；仍可按上述两次只读＋AX保留失效证据，然后终止自有App。若基线本身未满足250ms/5ms、仍在transition或目标不明，不会赋值；不得因此降低门槛。

只有main看过新包实际结果后才评估是否回到原历史场景。原−53pt仍红、SDK adopt unknown，durable ACK只证明导出完成。此包不授权自动pan，也不把本次编译或先前独立UIKit pass签成built Observer运行通过。
