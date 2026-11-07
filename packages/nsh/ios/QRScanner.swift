import UIKit
@preconcurrency import AVFoundation

@MainActor final class QRScanner: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var complete: ((String?) -> Void)?
    private let capture = AVCaptureSession()
    private let captureQueue = DispatchQueue(label: "com.yee94.yuri.nsh.camera")
    private var preview: AVCaptureVideoPreviewLayer?
    private var finished = false
    override func viewDidLoad() {
        super.viewDidLoad(); view.backgroundColor = .black
        let close = UIButton(type: .system); close.setTitle("取消", for: .normal)
        close.addTarget(self, action: #selector(cancel), for: .touchUpInside)
        close.frame = CGRect(x: 20, y: 60, width: 60, height: 44); view.addSubview(close)
        Task {
            let granted = await AVCaptureDevice.requestAccess(for: .video)
            guard !finished else { return }
            guard granted, let camera = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: camera), capture.canAddInput(input) else { finish(nil); return }
            capture.addInput(input)
            let output = AVCaptureMetadataOutput()
            guard capture.canAddOutput(output) else { finish(nil); return }
            capture.addOutput(output); output.setMetadataObjectsDelegate(self, queue: .main); output.metadataObjectTypes = [.qr]
            let preview = AVCaptureVideoPreviewLayer(session: capture); preview.videoGravity = .resizeAspectFill
            preview.frame = view.bounds; view.layer.insertSublayer(preview, at: 0); self.preview = preview
            let capture = self.capture
            captureQueue.async { capture.startRunning() }
        }
    }
    override func viewDidLayoutSubviews() { super.viewDidLayoutSubviews(); preview?.frame = view.bounds }
    override func viewDidDisappear(_ animated: Bool) { super.viewDidDisappear(animated); if !finished { finish(nil) } }
    @objc private func cancel() { finish(nil) }
    private func finish(_ value: String?) {
        guard !finished else { return }; finished = true
        let capture = self.capture
        captureQueue.async { capture.stopRunning() }
        complete?(value); complete = nil
    }
    nonisolated func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        let value = (metadataObjects.first as? AVMetadataMachineReadableCodeObject)?.stringValue
        if let value { Task { @MainActor in self.finish(value) } }
    }
}
