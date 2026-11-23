import assert from "node:assert/strict";
import test from "node:test";
import { projectLink, projectsFromJson } from "../src/nft/projects.js";

const one = "0x1111111111111111111111111111111111111111";
const two = "0x2222222222222222222222222222222222222222";

test("JSON tổng hợp lấy link, chain và contract", () => {
  const projects = projectsFromJson({
    projects: [
      {
        name: "Một",
        chain: "Base",
        mintUrl: "https://mint-one.example/drop",
        contract: one,
        image: "https://cdn.example/one.png",
      },
      {
        name: "Hai",
        network: "elysium",
        website: "https://mint-two.example",
        contractAddress: two,
      },
      { chainId: 1, address: one },
    ],
  });
  assert.equal(projects.length, 3);
  assert.equal(projectLink(projects[0]), "base https://mint-one.example/drop");
  assert.equal(projectLink(projects[1]), "elysium https://mint-two.example");
  assert.equal(projectLink(projects[2]), `eth https://nft.local/eth/${one}`);
  assert.equal(JSON.stringify(projects).includes("cdn.example"), false);
});

test("JSON hỏng hoặc không có dự án thì báo lỗi", () => {
  assert.throws(() => projectsFromJson("{"), /không đọc được/);
  assert.throws(() => projectsFromJson({ note: "không có mint" }), /không có link mint/);
});
