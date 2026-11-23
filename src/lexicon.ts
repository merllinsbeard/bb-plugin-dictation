const MAX_TERMS = 200;
const MAX_TERM_CHARS = 100;

// Each line is a term list, optionally followed by a colon and the distortions
// the recognizer produces: "OpenViking: опен викинг, Open Viking". Only the
// terms go to the recognizer; the editing model reads the whole text.
export function lexiconTerms(lexicon: string): string[] {
  const terms = new Set<string>();
  for (const line of lexicon.split("\n")) {
    if (line.trim().startsWith("#")) continue;
    const head = line.split(":")[0].replace(/\([^)]*\)/g, "");
    for (const entry of head.split(",")) {
      // OpenAI rejects the whole request when a keyword contains <, > or a line break.
      const term = entry.replace(/[<>\r\n]/g, "").trim();
      if (term && term.length <= MAX_TERM_CHARS) terms.add(term);
    }
  }
  return [...terms].slice(0, MAX_TERMS);
}
