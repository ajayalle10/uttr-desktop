/**
 * Uttr — text chunking (shared)
 *
 * The same algorithm as the browser extension's content.js: split text into
 * sentence-sized chunks so long passages are read smoothly, with natural
 * pauses. In the desktop app, chunks also make Pause/Resume and the progress
 * line possible.
 *
 * Keep this in sync with ../../content.js if the algorithm changes.
 *
 * Works in two places:
 *  - in a window (loaded with <script>), where it creates window.UttrChunker
 *  - in Node.js (require), which is how the tests use it
 */
(function () {
  // Longest chunk at 1x speed. Slower speech takes longer per character,
  // so maxChunkLength() shrinks the limit at slower speeds.
  const BASE_MAX_CHUNK_LENGTH = 150;

  const sentenceSegmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });

  /** e.g. 1x -> 150, 0.75x -> 113, 0.5x -> 75. Faster than 1x keeps 150. */
  function maxChunkLength(rate) {
    return Math.round(BASE_MAX_CHUNK_LENGTH * Math.min(rate, 1));
  }

  /** Split text into chunks of at most maxLength characters. */
  function splitIntoChunks(text, maxLength) {
    // Collapse spaces/newlines/tabs: copied text is full of layout line breaks.
    const cleanText = text.replace(/\s+/g, " ").trim();

    // 1. Sentences, using the browser's language-aware rules.
    const sentences = Array.from(sentenceSegmenter.segment(cleanText), (s) => s.segment.trim()).filter(Boolean);

    // 2. Break up any sentence that's still too long.
    const pieces = sentences.flatMap((sentence) => breakLongSentence(sentence, maxLength));

    // 3. Glue short pieces back together, up to the limit.
    return packPieces(pieces, maxLength);
  }

  /** Split an over-long sentence after , ; : and then at spaces. */
  function breakLongSentence(sentence, maxLength) {
    if (sentence.length <= maxLength) return [sentence];
    const clauses = sentence.split(/(?<=[,;:])\s+/);
    return clauses.flatMap((clause) => {
      if (clause.length <= maxLength) return [clause];
      return clause.split(" ").flatMap((word) => hardSplitWord(word, maxLength));
    });
  }

  /** Last resort for a single "word" longer than the limit (e.g. a URL). */
  function hardSplitWord(word, maxLength) {
    if (word.length <= maxLength) return [word];
    const slices = [];
    for (let i = 0; i < word.length; i += maxLength) slices.push(word.slice(i, i + maxLength));
    return slices;
  }

  /** Greedily combine pieces into chunks no longer than maxLength. */
  function packPieces(pieces, maxLength) {
    const chunks = [];
    let current = "";
    for (const piece of pieces) {
      const candidate = current ? current + " " + piece : piece;
      if (candidate.length <= maxLength) {
        current = candidate;
      } else {
        chunks.push(current);
        current = piece;
      }
    }
    if (current) chunks.push(current);
    return chunks;
  }

  const api = { splitIntoChunks, maxChunkLength };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else window.UttrChunker = api;
})();
