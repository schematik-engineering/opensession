import { expect, test } from "bun:test";
import {
  openLightbox,
  registerMediaLightboxHost,
  type LightboxRequest,
} from "../lib/media-lightbox";

test("openLightbox forwards a render-free request to the mounted host", () => {
  let request: LightboxRequest | undefined;
  const unregister = registerMediaLightboxHost((next) => {
    request = next;
  });

  openLightbox(
    [{ kind: "image", src: "data:image/png;base64,AA==" }],
    0,
    undefined,
    { startCommenting: true },
  );

  expect(request).toEqual({
    items: [{ kind: "image", src: "data:image/png;base64,AA==" }],
    index: 0,
    origin: undefined,
    startCommenting: true,
  });
  unregister();
});

test("unmounting an old host cannot unregister its replacement", () => {
  let firstCalls = 0;
  let secondCalls = 0;
  const unregisterFirst = registerMediaLightboxHost(() => {
    firstCalls += 1;
  });
  const unregisterSecond = registerMediaLightboxHost(() => {
    secondCalls += 1;
  });

  unregisterFirst();
  openLightbox([{ kind: "video", src: "clip.mp4" }], 0);

  expect(firstCalls).toBe(0);
  expect(secondCalls).toBe(1);
  unregisterSecond();
});
