// Extract evenly-spaced frames from a simulator screen recording.
//   swift frames.swift <in.mov> <outDir> <prefix> <fps>
// Screenshots via `simctl io screenshot` cost ~0.8s each, which cannot catch a
// ~700ms shell flight. A recording catches everything; this pulls the frames.
import Foundation
import AVFoundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let a = CommandLine.arguments
guard a.count >= 5, let fps = Double(a[4]) else { print("usage"); exit(1) }
let url = URL(fileURLWithPath: a[1]), outDir = a[2], prefix = a[3]
try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)

let asset = AVURLAsset(url: url)
let sem = DispatchSemaphore(value: 0)
var dur: Double = 0
Task {
    if let d = try? await asset.load(.duration) { dur = CMTimeGetSeconds(d) }
    sem.signal()
}
sem.wait()
guard dur > 0 else { print("zero-length recording"); exit(1) }

let gen = AVAssetImageGenerator(asset: asset)
gen.appliesPreferredTrackTransform = true
gen.requestedTimeToleranceBefore = .zero
gen.requestedTimeToleranceAfter = .zero

var n = 0
var t = 0.0
while t < dur {
    let time = CMTime(seconds: t, preferredTimescale: 600)
    if let cg = try? gen.copyCGImage(at: time, actualTime: nil) {
        n += 1
        let path = String(format: "%@/%@-%03d.png", outDir, prefix, n)
        if let dst = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL,
                                                     UTType.png.identifier as CFString, 1, nil) {
            CGImageDestinationAddImage(dst, cg, nil)
            CGImageDestinationFinalize(dst)
        }
    }
    t += 1.0 / fps
}
print("extracted \(n) frames over \(String(format: "%.1f", dur))s")
