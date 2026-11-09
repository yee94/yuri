# 既有NSH TextView身份写入：需要SDK owner的公开合同

当前e626a8d的NshView identifier getter读取内部props.test_id，UIKit继承setter不写同一backing。main已在92aa真实证实十次即时nil。Observer不能通过当前NshAppView/ViewRef公开接口更新既有TextView内部test_id；原公开TextView root testID也不能替代正文叶子身份。源码/二进制证据见 [CONTROL-READ-SHARING-RESULTS.md](CONTROL-READ-SHARING-RESULTS.md)。

在本轮只改Observer/v4/build合同、不改SDK或其它production的范围内，这个身份根因无法被安全修成成功。新control包会保留失败而非删除bindings、换label、用几何猜身份或制造SDK adoption。需要SDK owner实现并交付以下一种正式能力，再由main用新隔离包唯一复验：

1. SDK正常实现公开UIKit `setAccessibilityIdentifier:`，使其与当前getter使用同一NSH native AX backing；或提供等价的公开native AX metadata更新端口。具体Rust存储及engine props协调由SDK owner决定，Observer不触碰内部ivar。
2. 能作用于明确的既有native text对象，检查预期旧值，写入合成token并立即通过同一public getter读回；nil恢复原值语义明确，不产生layout/scroll/业务状态修改。
3. 应用之后按正常testID props更新覆盖token时，Observer照常将绑定退役，不强抢、不重试。对象回收/复用保持weak registry与runNonce/generation边界。
4. SDK回归必须覆盖现有TextView实际setter→getter、UIKit标准UIView、NSString/nil、相同对象、后续props覆盖、恢复旧值及无layout mutation。不能仅在UILabel mock通过。

该端口只提供外部AX可观测身份，不等同SDK row-key adoption、整页adopt ACK或文字锚点稳定。原SDK adoption port仍独立unknown。交付应包括SDK源码revision、framework/Swift interface哈希、编译配置和main一次实际getter读回；不改变任何5ms或历史稳定性门槛。
