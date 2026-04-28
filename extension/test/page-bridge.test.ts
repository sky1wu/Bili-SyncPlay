import assert from "node:assert/strict";
import test from "node:test";
import { readFestivalVideoDetailFromSources } from "../src/content/page-bridge-detail";

test("page bridge preserves active episode id when falling back to player input", () => {
  const detail = readFestivalVideoDetailFromSources({
    initialState: {
      episodes: [
        {
          id: 1,
          bvid: "BVold",
          cid: 11,
          title: "上一话",
        },
      ],
    },
    playerInput: {
      bvid: "BVcurrent",
      cid: 987654,
    },
    activeEpId: "508404",
    activeCid: "987654",
    activeTitle: "第46话",
  });

  assert.deepEqual(detail, {
    epId: "508404",
    bvid: "BVcurrent",
    cid: 987654,
    title: "第46话",
  });
});

test("page bridge preserves active cid when matched candidate lacks cid", () => {
  const detail = readFestivalVideoDetailFromSources({
    initialState: {
      videoInfo: {
        bvid: "BVcurrent",
        title: "第46话",
      },
    },
    activeCid: "987654",
    activeTitle: "第46话",
  });

  assert.deepEqual(detail, {
    epId: undefined,
    bvid: "BVcurrent",
    cid: "987654",
    title: "第46话",
  });
});
