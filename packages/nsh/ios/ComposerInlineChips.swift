import UIKit
import NativeShell

/**
 * Inline reference chips over the real multiline Input.
 *
 * The Input remains the only editor: its text, selection, IME, spellcheck,
 * metadata and draft are untouched. The bridge finds the same UITextView the
 * metadata/spellcheck bridges use, overlays an icon on each durable reference's
 * stored `@` trigger, and colors the label after it. Text storage attributes
 * change layout, not characters, so no visual placeholder can reach a send.
 */
@MainActor enum NativeComposerInlineChips {
    static func install(on surface: NshAppView) {
        surface.register(component: "yuri.composer.inlineChips") { ComposerInlineChipsOwner($0) }
    }
}

@MainActor private final class ComposerInlineChipsRegistration: UIView {
    var changed: (() -> Void)?
    override func didMoveToSuperview() { super.didMoveToSuperview(); changed?() }
    override func didMoveToWindow() { super.didMoveToWindow(); changed?() }
    override func layoutSubviews() { super.layoutSubviews(); changed?() }
}

@MainActor private final class ComposerInlineChipsOwner: NshComponent {
    private static let marker = NSAttributedString.Key("YuriComposerInlineChip")
    private static var iconCache: [String: UIImage] = [:]
    private static var imageCache: [String: UIImage] = [:]
    private static var imageCacheBytes = 0
    private let registration = ComposerInlineChipsRegistration(frame: .zero)
    var view: UIView { registration }
    private var plan: ComposerInlineChipPlan.Config?
    private weak var editor: UITextView?
    private var changeObserver: NSObjectProtocol?
    private var applied: [(start: Int, label: NSRange, color: String)] = []
    private var appliedLength = -1
    private var appliedFont: UIFont?
    private var iconViews: [UIImageView] = []
    private var boundsObserver: NSKeyValueObservation?
    private var scheduled = false, removed = false, applying = false, retried = false

    init(_ context: NshComponentContext) {
        registration.isAccessibilityElement = false
        registration.accessibilityElementsHidden = true
        registration.isUserInteractionEnabled = false
        registration.changed = { [weak self] in self?.schedule() }
    }

    deinit {
        for observer in [changeObserver].compactMap({ $0 }) { NotificationCenter.default.removeObserver(observer) }
        boundsObserver?.invalidate()
        MainActor.assumeIsolated { for icon in iconViews { icon.removeFromSuperview() } }
    }

    func setProp(_ name: String, _ value: Any?) {
        guard name == "config", !removed else { return }
        plan = ComposerInlineChipPlan.parse(value)
        retried = false
        if plan == nil { clear() }
        schedule()
    }

    func command(_ name: String, _ args: Any?) {
        guard name == "retire", !removed else { return }
        removed = true
        plan = nil
        clear()
        if let changeObserver { NotificationCenter.default.removeObserver(changeObserver) }
        changeObserver = nil
        boundsObserver?.invalidate(); boundsObserver = nil
        editor = nil
    }

    private func schedule() {
        guard !removed, !scheduled else { return }
        scheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.scheduled = false
            self.reconcile()
        }
    }

    private func resolve() -> UITextView? {
        guard let plan, let window = registration.window,
              let host = registration.superview, let owner = host.superview,
              owner.accessibilityIdentifier == plan.ownerID,
              host.window === window, owner.window === window else { return nil }
        let containers = owner.subviews.filter { $0 !== host && $0.accessibilityIdentifier == plan.inputID }
        guard containers.count == 1, let container = containers.first,
              container.superview === owner, container.window === window else { return nil }
        let editors = container.subviews.filter { $0 is UITextView }
        guard editors.count == 1, let editor = editors.first as? UITextView,
              editor.superview === container, editor.window === window else { return nil }
        return editor
    }

    private func reconcile() {
        guard !removed, let plan else { return }
        guard let found = resolve() else {
            if !retried {
                retried = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.016) { [weak self] in self?.schedule() }
            }
            return
        }
        if found !== editor {
            clear()
            editor = found
            observe(found)
        }
        guard let editor, editor.markedTextRange == nil else { return }
        let text = editor.text ?? ""
        let length = (text as NSString).length
        guard length == plan.textLength else {
            if !retried {
                retried = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.016) { [weak self] in self?.schedule() }
            }
            return
        }
        retried = false
        let ns = text as NSString
        let chips = plan.chips.filter { chip in
            chip.end <= ns.length && ns.substring(with: NSRange(location: chip.start, length: 1)) == "@"
        }
        let font = editor.font ?? UIFont.preferredFont(forTextStyle: .body)
        if appliedLength == length, appliedFont?.isEqual(font) == true, chips.count == plan.chips.count, isApplied(chips) { positionIcons(); return }
        let em = font.pointSize
        let base = editor.textColor ?? UIColor.label
        applying = true
        let storage = editor.textStorage
        storage.beginEditing()
        let all = NSRange(location: 0, length: storage.length)
        storage.removeAttribute(.attachment, range: all)
        storage.removeAttribute(.kern, range: all)
        storage.removeAttribute(Self.marker, range: all)
        storage.addAttribute(.foregroundColor, value: base, range: all)
        var next: [(start: Int, label: NSRange, color: String)] = []
        for icon in iconViews { icon.removeFromSuperview() }; iconViews = []
        for chip in chips {
            guard let color = UIColor(composerHex: chip.color), let icon = icon(chip.icon, color: color, em: em) else { continue }
            let triggerWidth = ("@" as NSString).size(withAttributes: [.font: font]).width
            storage.addAttributes([.foregroundColor: UIColor.clear, .kern: max(0, em * 1.2 - triggerWidth), Self.marker: chip.kind], range: NSRange(location: chip.start, length: 1))
            let image = UIImageView(image: icon)
            image.isUserInteractionEnabled = false; image.isAccessibilityElement = false
            image.accessibilityIdentifier = "yuri-inline-chip-icon"
            image.contentMode = .scaleAspectFit
            editor.addSubview(image); iconViews.append(image)
            let label = NSRange(location: chip.start + 1, length: max(0, chip.end - chip.start - 1))
            if label.length > 0 {
                storage.addAttributes([.foregroundColor: color, Self.marker: chip.kind], range: label)
            }
            next.append((chip.start, label, chip.color))
        }
        storage.endEditing()
        applied = next
        appliedLength = length
        appliedFont = font
        applying = false
        editor.invalidateIntrinsicContentSize()
        positionIcons()
    }

    private func observe(_ editor: UITextView) {
        if let changeObserver { NotificationCenter.default.removeObserver(changeObserver) }
        changeObserver = NotificationCenter.default.addObserver(
            forName: NSTextStorage.didProcessEditingNotification, object: editor.textStorage, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, !self.applying else { return }
                self.schedule()
            }
        }
        boundsObserver?.invalidate()
        boundsObserver = editor.observe(\.bounds, options: [.old, .new]) { [weak self] _, change in
            MainActor.assumeIsolated {
                if change.oldValue?.size != change.newValue?.size { self?.schedule() }
            }
        }
    }

    private func positionIcons() {
        guard let editor, editor.markedTextRange == nil else { return }
        let manager = editor.layoutManager, container = editor.textContainer
        manager.ensureLayout(for: container)
        let em = (editor.font ?? UIFont.preferredFont(forTextStyle: .body)).pointSize
        for (index, chip) in applied.enumerated() where index < iconViews.count {
            guard chip.start < editor.textStorage.length else { iconViews[index].isHidden = true; continue }
            let range = manager.glyphRange(forCharacterRange: NSRange(location: chip.start, length: 1), actualCharacterRange: nil)
            let rect = manager.boundingRect(forGlyphRange: range, in: container)
            iconViews[index].frame = CGRect(x: rect.minX + editor.textContainerInset.left,
                y: rect.midY + editor.textContainerInset.top - em / 2, width: em * 1.2, height: em)
            iconViews[index].isHidden = false
        }
    }

    private func isApplied(_ chips: [ComposerInlineChipPlan.Chip]) -> Bool {
        guard applied.count == chips.count, let editor else { return false }
        let storage = editor.textStorage
        for (index, chip) in chips.enumerated() {
            guard applied[index].start == chip.start,
                  applied[index].color == chip.color,
                  storage.attribute(Self.marker, at: chip.start, effectiveRange: nil) as? String == chip.kind,
                  index < iconViews.count, iconViews[index].superview === editor else { return false }
        }
        return true
    }

    private func clear() {
        guard let editor else { applied = []; appliedLength = -1; return }
        let base = editor.textColor ?? UIColor.label
        applying = true
        let storage = editor.textStorage
        storage.beginEditing()
        let all = NSRange(location: 0, length: storage.length)
        storage.removeAttribute(.attachment, range: all)
        storage.removeAttribute(.kern, range: all)
        storage.removeAttribute(Self.marker, range: all)
        storage.addAttribute(.foregroundColor, value: base, range: all)
        storage.endEditing()
        applying = false
        applied = []
        appliedLength = -1
        appliedFont = nil
        for icon in iconViews { icon.removeFromSuperview() }; iconViews = []
    }

    private func icon(_ kind: String, color: UIColor, em: CGFloat) -> UIImage? {
        let key = "\(kind)|\(color.description)|\(Int(em * UIScreen.main.scale))"
        if let cached = Self.imageCache[key] { return cached }
        let base: UIImage
        if let cached = Self.iconCache[kind] { base = cached }
        else {
            guard let encoded = ComposerInlineChipIcons.base64[kind], let data = Data(base64Encoded: encoded),
                  let decoded = UIImage(data: data) else { return nil }
            base = decoded
            Self.iconCache[kind] = decoded
        }
        let tinted = base.withTintColor(color, renderingMode: .alwaysOriginal)
        let size = CGSize(width: em * 1.2, height: em)
        let format = UIGraphicsImageRendererFormat.default()
        format.opaque = false
        format.scale = UIScreen.main.scale
        let image = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            tinted.draw(in: CGRect(origin: .zero, size: CGSize(width: em, height: em)))
        }
        let bytes = image.cgImage.map { $0.bytesPerRow * $0.height } ?? 0
        if Self.imageCache.count >= 128 || Self.imageCacheBytes + bytes > 4 * 1024 * 1024 {
            Self.imageCache.removeAll(); Self.imageCacheBytes = 0
        }
        if bytes <= 4 * 1024 * 1024 { Self.imageCache[key] = image; Self.imageCacheBytes += bytes }
        return image
    }
}

private extension UIColor {
    convenience init?(composerHex: String) {
        guard composerHex.first == "#", composerHex.count == 7 else { return nil }
        let value = String(composerHex.dropFirst())
        guard let number = UInt32(value, radix: 16) else { return nil }
        self.init(
            red: CGFloat((number >> 16) & 0xff) / 255,
            green: CGFloat((number >> 8) & 0xff) / 255,
            blue: CGFloat(number & 0xff) / 255,
            alpha: 1
        )
    }
}
