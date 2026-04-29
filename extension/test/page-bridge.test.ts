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

test("page bridge resolves current bangumi episode from playinfo when season page has no initial state", () => {
  const detail = readFestivalVideoDetailFromSources({
    playInfo: {
      result: {
        arc: {
          bvid: "BV17W411y74a",
          cid: 55445162,
        },
        supplement: {
          ogv_episode_info: {
            episode_id: 508404,
            index_title: "46",
            long_title: "汤姆与小老鼠 Tom and Cherie",
          },
          play_view_business_info: {
            episode_info: {
              ep_id: 508404,
              cid: 55445162,
            },
          },
        },
      },
    },
    playerInput: {
      cid: undefined,
    },
    activeTitle: "第46话 汤姆与小老鼠 Tom and Cherie",
  });

  assert.deepEqual(detail, {
    epId: 508404,
    bvid: "BV17W411y74a",
    cid: 55445162,
    title: "第46话 汤姆与小老鼠 Tom and Cherie",
  });
});
