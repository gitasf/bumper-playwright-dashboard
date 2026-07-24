import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AttachmentsTab } from "@/trace-viewer/components/attachments-tab";
import {
  makeAction,
  makeBridge,
  makeModel,
  makeTabProps,
} from "./trace-viewer-fixture";
import { installTraceViewerDomStubs } from "./trace-viewer-test-env";

/**
 * Component tests for the Attachments detail tab — visibility filtering
 * (leading-underscore attachments hidden), image/JSON previews resolved
 * through the bridge, the inline media lightbox, and sha1-backed downloads —
 * against the shared synthetic fixture (`trace-viewer-fixture.ts`).
 */

let restoreDomStubs: () => void;

beforeEach(() => {
  // Shared happy-dom gap stubs — see trace-viewer-test-env.ts for the
  // rationale behind each option.
  restoreDomStubs = installTraceViewerDomStubs({
    layout: true,
    objectUrl: true,
    scrollIntoView: true,
    pointerCapture: true,
    getAnimations: true,
  });
});

afterEach(() => {
  cleanup();
  restoreDomStubs();
});

describe("AttachmentsTab", () => {
  it("shows only visible attachments (leading-underscore ones are filtered out)", () => {
    render(<AttachmentsTab {...makeTabProps()} />);
    expect(screen.getByText("shot.png")).toBeTruthy();
    expect(screen.getByText("notes.json")).toBeTruthy();
    expect(screen.queryByText("_hidden")).toBeNull();
  });

  it("renders an image attachment preview once the bridge resolves the blob", async () => {
    const bridge = makeBridge({ "sha1/imgsha1.png": new Blob(["x"]) });
    render(<AttachmentsTab {...makeTabProps({ bridge })} />);
    expect(await screen.findByAltText("shot.png")).toBeTruthy();
  });

  it("expands a JSON attachment's chevron to show its pretty-printed contents", async () => {
    const user = userEvent.setup();
    const bridge = makeBridge({ "sha1/textsha1.json": '{"k":1}' });
    render(<AttachmentsTab {...makeTabProps({ bridge })} />);
    await user.click(
      screen.getByRole("button", { name: "Preview attachment contents" }),
    );
    expect(await screen.findByText(/"k":\s*1/)).toBeTruthy();
  });

  it("opens an image attachment full-size in the inline lightbox", async () => {
    const user = userEvent.setup();
    const bridge = makeBridge({ "sha1/imgsha1.png": new Blob(["x"]) });
    render(<AttachmentsTab {...makeTabProps({ bridge })} />);

    // shot.png is the fixture's only media attachment — one View button.
    await user.click(screen.getByRole("button", { name: "View" }));

    const dialog = await screen.findByRole("dialog");
    const full = await within(dialog).findByAltText("shot.png");
    expect(full.getAttribute("src")).toContain("blob:");
  });

  it("opens the lightbox from the image thumbnail too", async () => {
    const user = userEvent.setup();
    const bridge = makeBridge({ "sha1/imgsha1.png": new Blob(["x"]) });
    render(<AttachmentsTab {...makeTabProps({ bridge })} />);

    const thumbnail = await screen.findByAltText("shot.png");
    await user.click(thumbnail);

    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("plays a video attachment inline in the lightbox", async () => {
    const user = userEvent.setup();
    const model = makeModel({
      actions: [
        makeAction({
          callId: "call@v",
          method: "click",
          startTime: 1000,
          endTime: 1200,
          attachments: [
            {
              name: "clip.webm",
              contentType: "video/webm",
              sha1: "vidsha1.webm",
            },
          ],
        }),
      ],
    });
    const bridge = makeBridge({ "sha1/vidsha1.webm": new Blob(["v"]) });
    render(<AttachmentsTab {...makeTabProps({ model, bridge })} />);

    await user.click(screen.getByRole("button", { name: "View" }));

    const dialog = await screen.findByRole("dialog");
    await waitFor(() => {
      expect(dialog.querySelector("video")?.getAttribute("src")).toContain(
        "blob:",
      );
    });
  });

  it("downloads sha1-backed attachments through the trace-viewer SW route in a new tab", () => {
    render(<AttachmentsTab {...makeTabProps()} />);
    const links = screen.getAllByRole("link", { name: /download/i });
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link.getAttribute("href")).toContain("/trace-viewer/sha1/");
      expect(link.getAttribute("target")).toBe("_blank");
    }
  });
});
