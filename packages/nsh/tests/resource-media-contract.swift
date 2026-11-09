import Foundation

@main struct ResourceMediaContract {
    static func main() {
        func require(_ value: Bool, _ label: String) { precondition(value, label) }
        for ext in ["mp4", "m4v", "webm", "mov", "ogv", "ogg"] {
            require(ResourceMediaPolicy.kind(path: "/fixture/CLIP.\(ext.uppercased())", mime: "application/octet-stream", binary: true, containsNull: true) == "video", "Web video: \(ext)")
        }
        for ext in ["mp3", "m4a", "aac", "wav", "wave", "aif", "aiff", "caf", "flac", "oga", "opus"] {
            require(ResourceMediaPolicy.kind(path: "/fixture/sound.\(ext)", binary: true) == "audio", "audio: \(ext)")
        }
        require(ResourceMediaPolicy.kind(path: "/fixture/opaque", mime: " Video/MP4; codecs=avc1 ") == "video", "MIME video")
        require(ResourceMediaPolicy.kind(path: "/fixture/opaque", mime: "audio/mpeg") == "audio", "MIME audio")
        require(ResourceMediaPolicy.kind(path: "/fixture/sound.ogg", mime: "audio/ogg") == "audio", "ambiguous Ogg")
        for ext in ["m3u", "m3u8", "pls", "mpd"] {
            require(ResourceMediaPolicy.kind(path: "/fixture/list.\(ext)", mime: "video/mp4") == "binary", "reject playlist: \(ext)")
        }
        for mime in ["application/vnd.apple.mpegurl", "application/x-mpegurl", "audio/mpegurl", "audio/x-mpegurl", "application/dash+xml"] {
            require(ResourceMediaPolicy.kind(path: "/fixture/list.mp4", mime: mime) == "binary", "reject manifest MIME")
        }
        require(ResourceMediaPolicy.kind(path: "/fixture/image.PNG", binary: true) == "image", "image")
        require(ResourceMediaPolicy.kind(path: "/fixture/file.pdf", binary: true) == "pdf", "PDF")
        require(ResourceMediaPolicy.kind(path: "/fixture/mp4") == "text", "no extension")
        require(ResourceMediaPolicy.kind(path: "/fixture/.mp4") == "text", "hidden name has no extension")
        require(ResourceMediaPolicy.kind(path: "/fixture/file.bin", containsNull: true) == "binary", "binary")
        require(ResourceMediaPolicy.binaryLimit == 26_214_400 && ResourceMediaPolicy.textLimit == 1_000_000, "unchanged bounded limits")
        require(ResourceMediaPolicy.kind(path: "/fixture/image.SVG", binary: true) == "svg", "SVG extension")
        require(ResourceMediaPolicy.kind(path: "/fixture/opaque", mime: "image/svg+xml") == "svg", "SVG MIME")
        print("Resource media Foundation contract passed")
    }
}
