import Foundation

func cssWeight(_ candidates: [UInt16], _ requested: UInt16) -> UInt16? {
    if candidates.contains(requested) { return requested }
    let below = candidates.filter { $0 < requested }.max()
    let above = candidates.filter { $0 > requested }.min()
    if requested < 400 { return below ?? above }
    if requested > 500 { return above ?? below }
    return below.flatMap { $0 >= 400 ? $0 : nil } ?? above ?? below
}

let atkinson: [UInt16] = [400, 700]
precondition(cssWeight(atkinson, 400) == 400)
precondition(cssWeight(atkinson, 500) == 400)
precondition(cssWeight(atkinson, 600) == 700)
precondition(cssWeight(atkinson, 300) == 400)
precondition(cssWeight(atkinson, 900) == 700)

let complete: [UInt16] = [400, 500, 600]
precondition(cssWeight(complete, 400) == 400)
precondition(cssWeight(complete, 500) == 500)
precondition(cssWeight(complete, 600) == 600)
precondition(cssWeight(complete, 450) == 400)
precondition(cssWeight(complete, 550) == 600)
precondition(cssWeight([], 500) == nil)
print("css-font-weight-matching-keeps-atkinson-two-faces")
