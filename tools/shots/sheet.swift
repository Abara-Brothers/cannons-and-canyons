// Contact sheet for triaging a burst or an extracted recording.
//   swift sheet.swift <out.png> <cols> <cellW> <in1.png> ...
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
let a = CommandLine.arguments
guard a.count > 4, let cols = Int(a[2]), let cellW = Int(a[3]) else { print("usage"); exit(1) }
let out = a[1], paths = Array(a.dropFirst(4))
func load(_ p: String) -> CGImage? {
    guard let s = CGImageSourceCreateWithURL(URL(fileURLWithPath: p) as CFURL, nil) else { return nil }
    return CGImageSourceCreateImageAtIndex(s, 0, nil)
}
guard let first = load(paths[0]) else { exit(1) }
let cellH = Int(Double(cellW) * Double(first.height) / Double(first.width))
let pad = 8, rows = (paths.count + cols - 1) / cols
let W = cols * cellW + pad * (cols + 1), H = rows * cellH + pad * (rows + 1)
let ctx = CGContext(data: nil, width: W, height: H, bitsPerComponent: 8, bytesPerRow: 0,
                    space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
ctx.setFillColor(CGColor(red: 0.02, green: 0.03, blue: 0.08, alpha: 1))
ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))
for (i, p) in paths.enumerated() {
    guard let img = load(p) else { continue }
    let c = i % cols, r = i / cols
    ctx.draw(img, in: CGRect(x: pad + c * (cellW + pad),
                             y: H - (pad + (r + 1) * cellH + r * pad), width: cellW, height: cellH))
}
guard let image = ctx.makeImage(),
      let dst = CGImageDestinationCreateWithURL(URL(fileURLWithPath: out) as CFURL,
                                                UTType.png.identifier as CFString, 1, nil) else { exit(1) }
CGImageDestinationAddImage(dst, image, nil)
CGImageDestinationFinalize(dst)
print("sheet \(W)x\(H), \(paths.count) frames")
