import { expect, it } from "vitest";
import { lexiconTerms } from "./lexicon.js";

it("takes the terms before the colon and leaves distortions and notes to the editor", () => {
  expect(
    lexiconTerms(
      [
        "Kubernetes: кубернетис, cube nettis",
        "PostgreSQL, Redis",
        "# a comment",
        "Codex (the tool): кодекс",
        "",
        "  Grafana  ",
        "Kubernetes",
      ].join("\n"),
    ),
  ).toEqual(["Kubernetes", "PostgreSQL", "Redis", "Codex", "Grafana"]);
});

it("drops characters the recognizer rejects and terms it cannot accept", () => {
  expect(lexiconTerms(`<tag>\r\n${"x".repeat(101)}\nok`)).toEqual(["tag", "ok"]);
  expect(
    lexiconTerms(Array.from({ length: 250 }, (_, i) => `Term${i}`).join("\n")),
  ).toHaveLength(200);
});
