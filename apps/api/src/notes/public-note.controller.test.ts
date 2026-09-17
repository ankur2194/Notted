import { describe, expect, it, vi } from "vitest";

import { PublicNoteController } from "./public-note.controller";

import type { PublicNoteService } from "./public-note.service";
import type { Request } from "express";

function request(token: string): Request {
  return { params: { token } } as unknown as Request;
}

describe("PublicNoteController", () => {
  it("returns the resolved note", async () => {
    const note = { title: "Hi", content: { type: "doc" }, pageSize: "letter", updatedAt: "now" };
    const resolve = vi.fn().mockResolvedValue(note);
    const controller = new PublicNoteController({ resolve } as unknown as PublicNoteService);
    await expect(controller.get(request("a".repeat(32)))).resolves.toBe(note);
    expect(resolve).toHaveBeenCalledWith("a".repeat(32));
  });

  it("404s when the token does not resolve", async () => {
    const resolve = vi.fn().mockResolvedValue(null);
    const controller = new PublicNoteController({ resolve } as unknown as PublicNoteService);
    await expect(controller.get(request("a".repeat(32)))).rejects.toMatchObject({ status: 404 });
  });
});
