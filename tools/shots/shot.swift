// Store-screenshot pipeline for Cannons & Canyons.
//
//   swift shot.swift probe   <in.png>
//   swift shot.swift build   <in.png> <out.png> <W> <H> <x0> <x1>
//
// The app renders landscape via a CSS rotate shim, so the simulator framebuffer
// is portrait and has to be rotated. The simulator also composites the Dynamic
// Island as a black pill, which a real device screenshot does NOT contain — so
// columns x0…x1 are rebuilt by interpolating between the clean columns either
// side of it, per row. Only the island's own bounding box is touched; the app
// keeps its content clear of that area via safe-area insets, so the source
// columns are always background. Pass x0 > x1 to skip the patch entirely.
// Output is written with no alpha channel, which App Store Connect requires.

import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

func die(_ m: String) -> Never { FileHandle.standardError.write((m + "\n").data(using: .utf8)!); exit(1) }

func load(_ path: String) -> CGImage {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { die("cannot read \(path)") }
    return img
}

/// RGBA8 pixel buffer, top-left origin.
func pixels(_ img: CGImage) -> (buf: [UInt8], w: Int, h: Int) {
    let w = img.width, h = img.height
    var buf = [UInt8](repeating: 0, count: w * h * 4)
    buf.withUnsafeMutableBytes { raw in
        let ctx = CGContext(data: raw.baseAddress, width: w, height: h,
                            bitsPerComponent: 8, bytesPerRow: w * 4,
                            space: CGColorSpaceCreateDeviceRGB(),
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    }
    return (buf, w, h)
}

let args = CommandLine.arguments
guard args.count >= 3 else { die("usage: shot.swift probe|build ...") }
let mode = args[1]

// ---- rotate the portrait framebuffer to landscape (matches `sips --rotate 270`)
func rotated(_ img: CGImage) -> CGImage {
    let w = img.width, h = img.height
    let ctx = CGContext(data: nil, width: h, height: w, bitsPerComponent: 8, bytesPerRow: 0,
                        space: CGColorSpaceCreateDeviceRGB(),
                        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    ctx.interpolationQuality = .high
    ctx.translateBy(x: CGFloat(h) / 2, y: CGFloat(w) / 2)
    ctx.rotate(by: .pi / 2)
    ctx.translateBy(x: -CGFloat(w) / 2, y: -CGFloat(h) / 2)
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    return ctx.makeImage()!
}

if mode == "flat" {
    // flat <in.png> <out.png> <W> <H> — resize as-is and drop the alpha channel.
    // Chrome writes RGBA; App Store Connect rejects screenshots that carry alpha.
    let img = load(args[2])
    let tw = Int(args[4])!, th = Int(args[5])!
    let ctx = CGContext(data: nil, width: tw, height: th, bitsPerComponent: 8, bytesPerRow: 0,
                        space: CGColorSpaceCreateDeviceRGB(),
                        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    ctx.interpolationQuality = .high
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: tw, height: th))
    let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: args[3]) as CFURL,
                                               UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
    guard CGImageDestinationFinalize(dest) else { die("write failed") }
    print("\(args[3]) \(tw)x\(th)")
    exit(0)
}

if mode == "sheet" || mode == "sheet2" {
    // sheet  <out.png> <cols> <cellW> <in.png>...  — tile, rotating each frame
    // sheet2 <out.png> <cols> <cellW> <in.png>...  — tile as-is (already upright)
    let rot = mode == "sheet"
    let out = args[2], cols = Int(args[3])!, cw = Int(args[4])!
    let ins = Array(args[5...])
    let first = load(ins[0])
    let (fw, fh) = rot ? (first.height, first.width) : (first.width, first.height)
    let ch = cw * fh / fw
    let rows = (ins.count + cols - 1) / cols
    let ctx = CGContext(data: nil, width: cols * cw, height: rows * ch, bitsPerComponent: 8,
                        bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    ctx.interpolationQuality = .high
    for (i, p) in ins.enumerated() {
        let r = i / cols, c = i % cols
        // CG origin is bottom-left; lay the grid out top-to-bottom.
        let img = load(p)
        ctx.draw(rot ? rotated(img) : img,
                 in: CGRect(x: c * cw, y: (rows - 1 - r) * ch, width: cw, height: ch))
    }
    let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: out) as CFURL,
                                               UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
    _ = CGImageDestinationFinalize(dest)
    print("\(out) \(cols * cw)x\(rows * ch) — \(ins.count) frames, row-major")
    exit(0)
}

if mode == "crop" {
    // crop <in.png> <out.png> <x> <y> <w> <h> [zoom] — inspect the rotated frame
    let rot = rotated(load(args[2]))
    let x = Int(args[4])!, y = Int(args[5])!, cw = Int(args[6])!, ch = Int(args[7])!
    let z = args.count > 8 ? Int(args[8])! : 1
    let sub = rot.cropping(to: CGRect(x: x, y: y, width: cw, height: ch))!
    let ctx = CGContext(data: nil, width: cw * z, height: ch * z, bitsPerComponent: 8, bytesPerRow: 0,
                        space: CGColorSpaceCreateDeviceRGB(),
                        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    ctx.interpolationQuality = .none
    ctx.draw(sub, in: CGRect(x: 0, y: 0, width: cw * z, height: ch * z))
    let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: args[3]) as CFURL,
                                               UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
    _ = CGImageDestinationFinalize(dest)
    print("\(args[3]) \(cw * z)x\(ch * z)")
    exit(0)
}

if mode == "probe" {
    let rot = rotated(load(args[2]))
    let (buf, w, h) = pixels(rot)
    var minX = Int.max, maxX = -1, minY = Int.max, maxY = -1
    for y in 0..<h {
        for x in 0..<min(500, w) {
            let i = (y * w + x) * 4
            if buf[i] < 10 && buf[i + 1] < 10 && buf[i + 2] < 10 {
                minX = min(minX, x); maxX = max(maxX, x)
                minY = min(minY, y); maxY = max(maxY, y)
            }
        }
    }
    print("rotated: \(w)x\(h)")
    print(maxX < 0 ? "no pure-black pixels in left 500px" :
          "black bbox x[\(minX)...\(maxX)] y[\(minY)...\(maxY)]  w=\(maxX-minX+1) h=\(maxY-minY+1)")
    exit(0)
}

guard mode == "build", args.count >= 8 else { die("usage: shot.swift build <in> <out> <W> <H> <x0> <x1>") }
let outPath = args[3]
let tw = Int(args[4])!, th = Int(args[5])!
let x0 = Int(args[6])!, x1 = Int(args[7])!

let rot = rotated(load(args[2]))
var (buf, w, h) = pixels(rot)

// Rebuild the island columns by interpolating between the clean column on each
// side of it. Local, per-row, and invisible against the background gradient.
if x1 >= x0, x0 > 0, x1 < w - 1 {
    let span = x1 - x0 + 2
    for y in 0..<h {
        let row = y * w * 4
        let l = row + (x0 - 1) * 4, r = row + (x1 + 1) * 4
        for x in x0...x1 {
            let t = Double(x - x0 + 1) / Double(span)
            let d = row + x * 4
            for c in 0..<3 {
                buf[d + c] = UInt8((Double(buf[l + c]) * (1 - t) + Double(buf[r + c]) * t).rounded())
            }
            buf[d + 3] = 255
        }
    }
}

let patched: CGImage = buf.withUnsafeMutableBytes { raw in
    CGContext(data: raw.baseAddress, width: w, height: h, bitsPerComponent: 8,
              bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(),
              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!.makeImage()!
}

// Resize to the exact store size, opaque (noneSkipLast => PNG without an alpha channel).
let out = CGContext(data: nil, width: tw, height: th, bitsPerComponent: 8, bytesPerRow: 0,
                    space: CGColorSpaceCreateDeviceRGB(),
                    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
out.interpolationQuality = .high
out.draw(patched, in: CGRect(x: 0, y: 0, width: tw, height: th))

guard let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: outPath) as CFURL,
                                                 UTType.png.identifier as CFString, 1, nil)
else { die("cannot write \(outPath)") }
CGImageDestinationAddImage(dest, out.makeImage()!, nil)
guard CGImageDestinationFinalize(dest) else { die("write failed") }
print("\(outPath) \(tw)x\(th)")
