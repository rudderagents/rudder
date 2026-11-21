import { describe, expect, test } from "bun:test"
import { EventHub } from "./event-hub"
import { eventFrame } from "./protocol"
import { BACKPRESSURE_CLOSE, backlogCount, MAX_BUFFERED_BYTES, sendGuarded } from "./ws-send"

function fakeSocket(answers: number[], buffered = 0) {
  const sent: string[] = []
  const closes: Array<{ code?: number; reason?: string }> = []
  return {
    sent,
    closes,
    buffered,
    send(raw: string) {
      sent.push(raw)
      return answers.shift() ?? raw.length
    },
    close(code?: number, reason?: string) {
      closes.push({ code, reason })
    },
    getBufferedAmount() {
      return this.buffered
    },
  }
}

describe("sendGuarded", () => {
  test("a sent frame leaves the socket open", () => {
    const socket = fakeSocket([5])
    expect(sendGuarded(socket, "hello")).toBe(true)
    expect(socket.closes).toEqual([])
  })

  test("a dropped frame closes the socket with 1013 backpressure, once", () => {
    const socket = fakeSocket([0, 0])
    expect(sendGuarded(socket, "a")).toBe(false)
    expect(sendGuarded(socket, "b")).toBe(false)
    expect(socket.closes).toEqual([{ code: BACKPRESSURE_CLOSE, reason: "backpressure" }])
    expect(socket.sent).toEqual(["a"])
  })

  test("backpressure is counted, and closes the socket past 8 MB buffered", () => {
    const socket = fakeSocket([-1, -1, -1], 1024)
    expect(sendGuarded(socket, "a")).toBe(true)
    expect(sendGuarded(socket, "b")).toBe(true)
    expect(backlogCount(socket)).toBe(2)
    expect(socket.closes).toEqual([])
    socket.buffered = MAX_BUFFERED_BYTES + 1
    expect(sendGuarded(socket, "c")).toBe(false)
    expect(socket.closes).toEqual([{ code: BACKPRESSURE_CLOSE, reason: "backpressure" }])
  })

  test("a large frame to a socket that asked for chunks leaves as binary chunks, FIN on the last", () => {
    const socket = { ...fakeSocket([]), data: { chunked: true }, binary: [] as Uint8Array[] }
    const chunked = Object.assign(socket, {
      sendBinary(data: Uint8Array) {
        socket.binary.push(data)
        return data.byteLength
      },
    })
    const frame = JSON.stringify({ text: "é".repeat(70_000) })
    expect(sendGuarded(chunked, frame)).toBe(true)
    expect(socket.sent).toEqual([])
    expect(socket.binary.map((chunk) => chunk[0])).toEqual([0, 0, 1])
    expect(socket.binary.map((chunk) => chunk.byteLength)).toEqual([65_001, 65_001, Buffer.byteLength(frame) - 130_000 + 1])
    expect(Buffer.concat(socket.binary.map((chunk) => chunk.subarray(1))).toString("utf8")).toBe(frame)
    // A small frame stays one text message.
    expect(sendGuarded(chunked, "small")).toBe(true)
    expect(socket.sent).toEqual(["small"])
  })

  test("a socket that did not ask for chunks gets a large frame whole", () => {
    const socket = { ...fakeSocket([]), data: { chunked: false }, sendBinary: () => 0 }
    const frame = "x".repeat(200_000)
    expect(sendGuarded(socket, frame)).toBe(true)
    expect(socket.sent).toEqual([frame])
  })

  test("a dropped chunk closes the socket and sends no more of the frame", () => {
    const binary: Uint8Array[] = []
    const answers = [65_001, 0]
    const socket = {
      ...fakeSocket([]),
      data: { chunked: true },
      sendBinary(data: Uint8Array) {
        binary.push(data)
        return answers.shift() ?? data.byteLength
      },
    }
    expect(sendGuarded(socket, "x".repeat(200_000))).toBe(false)
    expect(binary.length).toBe(2)
    expect(socket.closes).toEqual([{ code: BACKPRESSURE_CLOSE, reason: "backpressure" }])
  })

  test("the event hub closes a phone socket that dropped a live frame", () => {
    const hub = new EventHub(null)
    const socket = fakeSocket([0])
    hub.attach(socket)
    hub.invoked(socket)
    hub.publish(eventFrame("session.upsert", { id: "s" }))
    expect(socket.closes).toEqual([{ code: BACKPRESSURE_CLOSE, reason: "backpressure" }])
    hub.close()
  })
})
