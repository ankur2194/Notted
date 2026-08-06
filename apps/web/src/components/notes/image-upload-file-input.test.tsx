import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";

import { ImageUploadFileInput } from "./ImageUploadFileInput";

import type { ImageUploadFileInputHandle } from "./ImageUploadFileInput";

function pngFile(name: string): File {
  return new File([new Uint8Array([1])], name, { type: "image/png" });
}

function inputElement(): HTMLInputElement {
  const element = screen.getByTestId("note-image-file-input");
  if (!(element instanceof HTMLInputElement)) throw new Error("the file input is not an input");
  return element;
}

describe("ImageUploadFileInput", () => {
  it("accepts multiple files of exactly the shared image types", () => {
    render(<ImageUploadFileInput onFiles={vi.fn()} />);
    const input = inputElement();
    expect(input.type).toBe("file");
    expect(input.multiple).toBe(true);
    expect(input.accept).toContain("image/png");
    expect(input.accept).not.toContain("application/pdf");
  });

  it("stays out of the tab order and out of the accessibility tree", () => {
    // The visible, accessible controls are the toolbar button and the `/image`
    // command; a second unlabelled tab stop announcing "Choose files" would be
    // noise, not access.
    render(<ImageUploadFileInput onFiles={vi.fn()} />);
    const input = inputElement();
    expect(input.tabIndex).toBe(-1);
    expect(input.getAttribute("aria-hidden")).toBe("true");
    expect(input.hidden).toBe(true);
  });

  it("opens the native picker through its imperative handle", () => {
    const ref = createRef<ImageUploadFileInputHandle>();
    render(<ImageUploadFileInput ref={ref} onFiles={vi.fn()} />);
    const click = vi.spyOn(inputElement(), "click").mockImplementation(() => undefined);

    ref.current?.open();
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("does nothing when uploading is disabled", () => {
    const ref = createRef<ImageUploadFileInputHandle>();
    render(<ImageUploadFileInput ref={ref} onFiles={vi.fn()} disabled />);
    const click = vi.spyOn(inputElement(), "click").mockImplementation(() => undefined);

    ref.current?.open();
    expect(click).not.toHaveBeenCalled();
    expect(inputElement().disabled).toBe(true);
  });

  it("reports the picked files and clears its value so the same file fires again", () => {
    const onFiles = vi.fn();
    render(<ImageUploadFileInput onFiles={onFiles} />);
    const input = inputElement();

    // jsdom implements neither `DataTransfer` nor a constructible `FileList`, so
    // the selection is supplied the way Testing Library documents for file
    // inputs: through the change event's target.
    fireEvent.change(input, { target: { files: [pngFile("a.png"), pngFile("b.png")] } });

    expect(onFiles).toHaveBeenCalledTimes(1);
    expect(onFiles.mock.calls[0]?.[0]).toHaveLength(2);
    // Without the reset, picking the identical file a second time is silently
    // ignored, which reads as a broken button.
    expect(input.value).toBe("");
  });

  it("ignores an empty selection, such as a cancelled dialog", () => {
    const onFiles = vi.fn();
    render(<ImageUploadFileInput onFiles={onFiles} />);
    fireEvent.change(inputElement(), { target: { files: [] } });
    expect(onFiles).not.toHaveBeenCalled();
  });
});
