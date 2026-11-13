# Search helpers

`fuzzySearch.ts` owns generic substring/fuzzy scoring. `fileMentionSearch.ts` owns `@` mention path ranking: query intent (`.ext` → files, `foo/` → directories), source-over-test, and dropping unmatched candidates. Chat autocomplete merges server hits and recent files through `rankFileMentionSearch`. Agent and skill `@` rows are jointly name-ranked by `composer-autocomplete/rows.ts` using OpenCode TUI's fuzzysort rules; skill descriptions provide lower-priority recall after name matches.

`commandPaletteRank.ts` ranks already-recalled global-search rows across categories
with the shared `scoreMentionTitle` tiers and fuzzysort scores. Detail fields score
below title matches. It never filters authoritative matches, scores each field
once before sorting, preserves source ordering on ties, and leaves empty-query
ordering unchanged. Retrieval limits and category previews remain caller-owned.
