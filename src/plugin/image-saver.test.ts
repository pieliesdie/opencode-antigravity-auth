import { beforeEach, describe, expect, it, vi } from "vitest"

import { join, sep } from "node:path"

const mkdirSync = vi.fn()
const writeFileSync = vi.fn()
const homedir = vi.fn(() => "/tmp/fake-home")

vi.mock("node:fs", () => ({
  mkdirSync: (...args: unknown[]) => mkdirSync(...args),
  writeFileSync: (...args: unknown[]) => writeFileSync(...args),
}))

vi.mock("node:os", () => ({
  homedir: () => homedir(),
}))

import { processImageData, saveImageToDisk } from "./image-saver"

describe("saveImageToDisk", () => {
  beforeEach(() => {
    mkdirSync.mockReset().mockReturnValue(undefined)
    writeFileSync.mockReset().mockReturnValue(undefined)
    homedir.mockReset().mockReturnValue("/tmp/fake-home")
  })

  it("returns a path in the generated-images dir with an extension from the mime type", () => {
    const filePath = saveImageToDisk(Buffer.from("hello").toString("base64"), "image/jpeg")
    expect(filePath.startsWith(join("/tmp/fake-home", ".opencode", "generated-images") + sep)).toBe(true)
    expect(filePath.endsWith(".jpg")).toBe(true)
  })

  it("writes the decoded buffer durably before returning the path", () => {
    const base64 = Buffer.from("payload").toString("base64")
    const filePath = saveImageToDisk(base64, "image/png")

    // The write must have completed by the time the path is returned.
    expect(mkdirSync).toHaveBeenCalledWith(join("/tmp/fake-home", ".opencode", "generated-images"), {
      recursive: true,
    })
    expect(writeFileSync).toHaveBeenCalledTimes(1)
    const [writtenPath, writtenBuffer] = writeFileSync.mock.calls[0]!
    expect(writtenPath).toBe(filePath)
    expect(Buffer.isBuffer(writtenBuffer)).toBe(true)
    expect((writtenBuffer as Buffer).toString()).toBe("payload")
  })

  it("returns an empty path (failure propagated) when the write throws", () => {
    writeFileSync.mockImplementation(() => {
      throw new Error("disk full")
    })
    const filePath = saveImageToDisk(Buffer.from("x").toString("base64"), "image/png")
    // The path must NOT be reported as saved when persistence failed.
    expect(filePath).toBe("")
  })

  it("returns an empty path when mkdir throws", () => {
    mkdirSync.mockImplementation(() => {
      throw new Error("permission denied")
    })
    const filePath = saveImageToDisk(Buffer.from("x").toString("base64"), "image/png")
    expect(filePath).toBe("")
    expect(writeFileSync).not.toHaveBeenCalled()
  })

  it("returns an empty path when path setup (homedir) throws", () => {
    homedir.mockImplementation(() => {
      throw new Error("no home directory")
    })
    const filePath = saveImageToDisk(Buffer.from("x").toString("base64"), "image/png")
    // Path setup failure must be caught too, so callers can still fall back.
    expect(filePath).toBe("")
    expect(mkdirSync).not.toHaveBeenCalled()
    expect(writeFileSync).not.toHaveBeenCalled()
  })
})

describe("processImageData", () => {
  beforeEach(() => {
    mkdirSync.mockReset().mockReturnValue(undefined)
    writeFileSync.mockReset().mockReturnValue(undefined)
    homedir.mockReset().mockReturnValue("/tmp/fake-home")
  })

  it("returns null when there is no image data", () => {
    expect(processImageData({ mimeType: "image/png" })).toBeNull()
  })

  it("returns markdown referencing the saved file path on success", () => {
    const result = processImageData({
      mimeType: "image/png",
      data: Buffer.from("x").toString("base64"),
    })
    expect(result).toContain(`![Generated Image](${join("/tmp/fake-home", ".opencode", "generated-images")}${sep}`)
    expect(result).toContain("Image saved to:")
  })

  it("falls back to a base64 data URL when the write fails (payload not lost)", () => {
    writeFileSync.mockImplementation(() => {
      throw new Error("disk full")
    })
    const data = Buffer.from("x").toString("base64")
    const result = processImageData({ mimeType: "image/png", data })
    // Must NOT reference a nonexistent file; must embed the base64 payload instead.
    expect(result).toBe(`![Generated Image](data:image/png;base64,${data})`)
  })

  it("falls back to a base64 data URL when path setup (homedir) throws", () => {
    homedir.mockImplementation(() => {
      throw new Error("no home directory")
    })
    const data = Buffer.from("x").toString("base64")
    const result = processImageData({ mimeType: "image/png", data })
    expect(result).toBe(`![Generated Image](data:image/png;base64,${data})`)
  })
})
