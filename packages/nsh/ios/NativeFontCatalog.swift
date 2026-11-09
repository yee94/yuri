import Foundation

/// Snapshot of Web fontOptions + fontLoader's Latin/normal Fontsource resources.
/// Versions and SHA-256 identify bytes; family names alone never authorize a font.
struct NativeFontFace: Hashable {
    let id: String
    let version: String
    let weight: Int
    let sha256: String
    let byteCount: Int
    var filename: String { "\(id)-latin-\(weight)-normal.woff2" }
    var url: URL { URL(string: "https://cdn.jsdelivr.net/npm/@fontsource/\(id)@\(version)/files/\(filename)")! }
    var key: String { "\(id)@\(version)/latin/normal/\(weight)/\(sha256)" }
}

struct NativeFontDefinition {
    let id: String
    let family: String
    let kind: String
    let version: String
    let faces: [NativeFontFace]
}

enum NativeFontCatalog {
    static let fonts: [NativeFontDefinition] = [
        font("inter", "Inter", "ui", "5.3.0", "8909904ab6c872eb994093482a88a28eca2cd95912d7b6fecd72103b0dc07edc:23664 f3779f1efccc4bdcdf9c0a02ab95bf6bd092ed09c48c08cedc725889edd1d19f:24272 f9a06e79cd3a2a20951c0f0e28f66dd0e6d3fda73911d640a2125c8fcb78f21a:24452"),
        font("geist-sans", "Geist Sans", "ui", "5.3.0", "e6ef6abb39c762ed2259cc814e6f16888c540cd84835962227b56ab2354f27f1:33400 40073e90816315c92e4f4381bd50b6fdc950b22b0dd010a4179046cf588d4f12:34716 9d99fbd791968493fa507ac846de561cee47b00f8100c23cad333b3cb78392d6:35292"),
        font("atkinson-hyperlegible", "Atkinson Hyperlegible", "ui", "5.3.0", "d64ba838ef5472bba248620ec4fd8b5aa7cf0db2908e0bb230600caf279ba7bc:17208 140e2bd25a7315c8a062508391426b0d8c3297400c947b8d847be28f73a199f0:17524", weights: [400, 700]),
        font("source-sans-3", "Source Sans 3", "ui", "5.3.1", "0f73f35e08cde0a2f10c109c6e01d71459d97e4099ecd9a50f1b6c0209e4de2b:15696 3b3a8b8e4a422ff71c9ffb0836a4d48ff337a4419b878214f65d6ebe0f59fa51:15652 14527d193b0e30bc32ef931549a246cdfd286573bb12869b7e052b8101a39d38:15668"),
        font("roboto", "Roboto", "ui", "5.3.0", "425c0713a8176f92273d378599c7eac57de7fafabd4bd0ed457b70eb8f80d371:21884 5bcc3aa180e7f26f643cd5b2621cd7c2de193d0661d913a94afd3d4881a7a34b:22200 3eac5e2f468629b4673394bb25a387aba117e0dfa646b7f371a2cbd2bbf91d87:22240"),
        font("noto-sans", "Noto Sans", "ui", "5.3.0", "09aee8065d25508f23a4c3d92cd777ac869c52d93fd868a88f025d888a7937d6:13120 1d35aaecc5c7a375d87c12787e1e4c5d6a695315b757e1e18a479d1a2f84e973:13496 79e274470d1c5a0118eb325e2ea6f2eb2a449336d7fde1a4f20a2f32fe1119ed:13496"),
        font("dm-sans", "DM Sans", "ui", "5.3.0", "4ab51eb2cd7305d177187908d6397474d4520663f6c6e572feb0a64f4fa80006:14200 19bf1984956517c35c2bd35b6cdedac12a21d6fcd3596c614ecdfb88b648909d:14304 6bb2b2645ba5eeaecf56322c543fa3a75b87b927977b9c03b1dabc4205089120:14144"),
        font("manrope", "Manrope", "ui", "5.3.0", "849290ef12a2eeb9af5c11924120d11aa4ae8b435ed3347d7fc8bc240c293ca3:14108 19874318747181a650eda439c37955220b849d9c4797c9e0718ee67d4bf929bc:14044 f7ac6258da20ab7541939b59851155753d1d24f1b30cbcb949077a3faa3d1593:14172"),
        font("jetbrains-mono", "JetBrains Mono", "mono", "5.3.0", "14425ba9c695763c1547f48a206b7aa60350a33ae23de09f0407877f3fcd89eb:21168 cb182feeed4d798ff6961d3c79f7026279448fca0676438aaecb21f3fc39553a:21832 400c6bfda18d5d14acad1c15d6dcb9f8e13c015e7286317e0b9a482539bef147:21860"),
        font("fira-code", "Fira Code", "mono", "5.3.0", "6dc9da171ccea71d525379ee1cbf51d143e31acac330a251bb71b3d6060e687c:23312 9e4da5ad2c147be02544df5a732d22830a82b1e9800dc06267ba656f5c40f7e9:23316 53bd904d81c086b103b9e01ef84a98640b2124b78c789bb47ddabb4c41fc94b2:23316"),
        font("geist-mono", "Geist Mono", "mono", "5.3.0", "3f98383b122fe015a48536cd4a1cda855a201718923ffe74931a01597107b9b5:9864 72971bd4908d3984fa1b1426bb363730e4957e16a0f58bfbca76993095715488:10116 8b111a81bab818cf5393b81149c69d6a1756f3acc3a846decafef01974d12bd3:10144"),
        font("commit-mono", "Commit Mono", "mono", "5.3.0", "86132abb57fc615f2ab900cde4cd9d5796e9791daf1f85d79fc933aa50b3b15c:48128 ff7e7c2446edb30d854a636c0e5edefbf90c5739476779636d83448797e2e2de:47920 48b7064512777b347f5338f1e30b69e27c1164f5e4a9e8d5310b5f953fe50bde:48056"),
        font("source-code-pro", "Source Code Pro", "mono", "5.3.1", "75aa8cacfd459d58d7c093f3ff0ab8745cc878dfc93c5d4cda052791aeace878:11656 8966fa3fbe70f63675bbededb8389023c07258bc46a831fd6d146cb062a5811f:11604 0d1ec7219990cad29c487df2e1fc6651671fd5224daec191cae5f649824cb7bd:11628"),
        font("cascadia-code", "Cascadia Code", "mono", "5.3.0", "923fd5a61f1618f4597422b66172d0d8615577f81eb9382724390ec8cb8bfd5d:29452 d4994c01c11d6b9a49a2b44e0a3711934c99a35268ab9303a7b9dcc30495341e:29888 be5e5cbe3958e21cf2c7404e09853dcc83cf667e71327264274dd26fc8d92d9b:30356"),
        font("roboto-mono", "Roboto Mono", "mono", "5.3.0", "e03013e0baa5690a803c188da2214d920c3245b25ad78421ecc8ae86cd842ae9:12680 ce7027efa5c894e8b244b0ca05ec121b6a85655957afd9c76c59b56910de7d4e:12936 0ee2e6f8f9dcd2af7bc0c6b519c283954242824258b652cdb6017bc578e2c493:12932"),
        font("iosevka", "Iosevka", "mono", "5.3.0", "edd37efeaa39d005a13b7e1770f42a474cfd7dc22e4b7091c5783cec9dcdc794:984084 303500455d9bed7f67d7c1488a6682dc4ccf7ef8dc0ee4402b9193b6b248fd19:991004 e62b5c737cb05005f2e8746e8e51db0f1932168c200e015a788409ea0f2172ce:992472")
    ]
    private static func font(_ id: String, _ family: String, _ kind: String, _ version: String, _ records: String, weights: [Int] = [400, 500, 600]) -> NativeFontDefinition {
        let faces = zip(weights, records.split(separator: " ")).map { weight, record -> NativeFontFace in
            let fields = record.split(separator: ":")
            return NativeFontFace(id: id, version: version, weight: weight, sha256: String(fields[0]), byteCount: Int(fields[1])!)
        }
        return NativeFontDefinition(id: id, family: family, kind: kind, version: version, faces: faces)
    }
    static func family(_ family: String) -> NativeFontDefinition? { fonts.first { $0.family == family } }
    static func allows(_ face: NativeFontFace) -> Bool { fonts.contains { $0.faces.contains(face) } }
}
