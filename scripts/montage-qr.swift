import CoreImage
import Foundation

let message = FileHandle.standardInput.readDataToEndOfFile()
guard let filter = CIFilter(name: "CIQRCodeGenerator") else { exit(1) }
filter.setValue(message, forKey: "inputMessage")
filter.setValue("M", forKey: "inputCorrectionLevel")
guard let qr = filter.outputImage else { exit(1) }

let white = CIImage(color: .white).cropped(to: qr.extent.insetBy(dx: -4, dy: -4))
let image = qr.composited(over: white).samplingNearest().transformed(by: CGAffineTransform(scaleX: 8, y: 8))
guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
      let png = CIContext(options: [.useSoftwareRenderer: true]).pngRepresentation(
        of: image, format: .RGBA8, colorSpace: colorSpace
      ) else { exit(1) }
FileHandle.standardOutput.write(png)
