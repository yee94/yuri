# scroll-insets-v1 变更前性能冻结

本冻结在新增scroll inset读取前建立，不改旧artifact或原纯压力输入。旧可安装5e595357的manifest/executable/bytecode及源码哈希仍见 `IDENTITY-5E595357-ARTIFACT.md`，其不含scroll inset，不能当新revision的字段或性能证据。

| 变更前输入/源码 | SHA-256 |
| --- | --- |
| Observer.swift | `ccd7fb08160dafb9b18ad61df44b5c52153f1535dc8abd327f284470eb2e26b9` |
| build.mjs | `28e0c22b322369bda521a3142464875ff07b2d4de201c0ceac175b0a8c13e4f2` |
| v4/TypedGeometry.swift | `eb274b6e4ccfa672bcfea429dded4684ac45d6acd1d46cd51f552e23dfdeed7c` |
| v4/SnapshotValue.swift | `3784bcb2d0ddd68e98134309638d2b946a1425bbdc0c47ce5616417e24bf9f4a` |
| v4/SegmentWriter.swift | `b473233b9b213d2d0760aa8395f9b4029e4c876e8e1ace5a7567d0799eadc7fd` |
| v4/CapturePipeline.swift | `f89acc71d70eb1b7b51e6e8c9effe552ba6027787d77fb3e829948f2e94658c5` |
| v4/Profile.swift | `eefbf01ed1bd370cf36537a1e93e4602565cc45fc7391b1926c0923a0d433008` |
| v4/stream_reader.py | `0c72aeef8a18fe32243e779452e21fbc92d9e4676b9251ab86304ad8c8c145dd` |
| v4/run-pressure.py | `f8e0b266ab973bf0aa694444167626f00671de3180f7961fb73ca4a81950d240` |
| native-before.json（422568 bytes） | `419454f5ec34798a6967e21430b0143aed46136da0be8b115ebed035cba8b8d7` |

既有结果与输入不重写：完整8/16/32×18000 typed压力结果summary SHA为 `973fddec9f224b2f2a5bb27ac2e690a062e1631739c40709a669f94c4d79a3ed`；pool后32×18000复测summary SHA为 `ab89de19ff7651f529b05f981f67dbd03715f1ff486245f9592ea6a9d9a90ea2`。数字与限制见 `V4-EXPORT-RESULTS.md`：8/16 max RSS为29,753,344/32,948,224 bytes，32 pool后497,745,920 bytes；三组完整保全，均非真实UIKit读窗/性能签收。

新revision将增加每个已观测scroll两组四边值以及同轮读取时间，不删除原字段。旧Profile.swift/run-pressure.py、小输入、旧reader/writer和上述结果保持原指纹；增量字段的字节/纯值成本另测，不能借旧18000结果签新frame。main的独立UIKit三函数pass仍仅覆盖其原范围，built Observer新字段/实时成本待新包实际测量。

public API核对：当前iOS Simulator SDK26.5的 `UIKit.framework/Headers/UIScrollView.h:91` 声明contentInset为public UIEdgeInsets属性，`:101`声明adjustedContentInset为public readonly UIEdgeInsets（iOS11+）。Apple文档说明后者包含contentInset与safe-area调整，不能把windowSafeAreaInsets代替它；见 https://developer.apple.com/documentation/uikit/uiscrollview/adjustedcontentinset 。本轮没有测量证据证明getter会触发额外layout，不据猜测保留永久缺字段，也不调用layoutIfNeeded来“刷新”值。实际getter成本放进新的native读窗，超过5ms仍拒绝控制准入。
