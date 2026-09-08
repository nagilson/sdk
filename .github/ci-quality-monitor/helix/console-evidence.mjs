import {
  MAX_CONSOLE_CHARACTERS, MAX_LOG_CHARACTERS, MAX_RELATED_MECHANISM_CHARACTERS, MAX_TEST_FAILURES
} from "../constants.mjs";
import {normalizeEvidenceText} from "../evidence-utils.mjs";

const HANG_WATCHDOG_PATTERN = /Hang (?:dump )?timeout\b/i;

export function hasHangWatchdog(value)
{
  return HANG_WATCHDOG_PATTERN.test(`${value ?? ""}`);
}

const EVENT_PATTERNS = [
  ["hang-timeout", HANG_WATCHDOG_PATTERN],
  ["active-test", /active test|currently running|has been running/i],
  ["active-test-list", /tests were still running when dump was taken/i],
  ["dump-failure", /(?:failed[^\r\n]*dump|dump[^\r\n]*(?:fail|error)|permission denied|diagnostics IPC)/i],
  ["process-exit", /exit code(?: is)?\s*['"]?-?\d+|exit(?:ed)? with (?:80|143)/i],
  ["process-crash", /test host crashed|segmentation fault|stack overflow|core dump(?:ed)?|assert failed|app_crash|created crash dump/i],
  ["timeout", /workload timed out|run timed out|timed_out|timed out/i],
  ["test-result-recovery", /recovered \d+ test result/i],
  ["test-run-completed", /test run completed|detected test end tag/i],
  ["infrastructure-error", /device_not_found|infrastructure error|agent connection|machine is not available/i],
  ["operating-system", /(?:operating system|OS version|OS platform|OS):\s*\S+/i],
  ["process-tree", /process tree|process id\s*:/i],
  ["dump-context", /dump/i],
  ["diagnostic-context", /\b(?:error|exception|failed|MSB\d{4}|NETSDK\d{4}|CS\d{4})\b/i]
];

function readLines(text)
{
  const lines = [];
  let start = 0;
  while (start < text.length)
  {
    const newline = text.indexOf("\n", start);
    const end = newline < 0 ? text.length : newline + 1;
    lines.push({start, end, text: text.slice(start, end).replace(/\r?\n$/, "")});
    start = end;
  }
  return lines;
}

function findEvents(lines)
{
  const events = [];
  let readingActiveTests = false;
  for (const [index, line] of lines.entries())
  {
    const markedActiveTest = readingActiveTests && /^\s*\[[\d:.]+\]\s+\S/.test(line.text);
    if (line.text.trim()) readingActiveTests = markedActiveTest;
    const matches = markedActiveTest ? [["active-test", {index: 0}]]
      : EVENT_PATTERNS.flatMap(([kind, pattern]) =>
      {
        const match = pattern.exec(line.text);
        return match ? [[kind, match]] : [];
      });
    if (/tests were still running when dump was taken/i.test(line.text)) readingActiveTests = true;
    // A single line can contain several events, including a PID immediately followed by Hang.
    for (const [kind, match] of matches)
    {
      if (kind === "diagnostic-context" && matches.some(([other]) => other !== kind)) continue;
      if (kind === "dump-context"
        && matches.some(([other]) => ["hang-timeout", "dump-failure", "active-test-list"].includes(other))) continue;
      const startOffset = line.start + match.index;
      const rawText = line.text.slice(match.index);
      const normalized = normalizeEvidenceText(rawText, Number.POSITIVE_INFINITY);
      events.push({
        kind,
        role: kind === "diagnostic-context" ? "context-not-assertion" : "diagnostic",
        line: index + 1,
        startColumn: match.index + 1,
        startOffset,
        endOffset: line.start + line.text.length,
        text: normalized.slice(0, MAX_RELATED_MECHANISM_CHARACTERS),
        omittedCharacters: Math.max(0, normalized.length - MAX_RELATED_MECHANISM_CHARACTERS),
        truncated: normalized.length > MAX_RELATED_MECHANISM_CHARACTERS
      });
    }
  }
  return events;
}

function selectEvents(events)
{
  const priority = kind => EVENT_PATTERNS.findIndex(([name]) => name === kind);
  const ranked = [...events].sort((a, b) => priority(a.kind) - priority(b.kind) || b.startOffset - a.startOffset);
  // Keep each diagnostic kind before filling the remaining slots with recent occurrences.
  const representatives = [...new Map([...ranked].reverse().map(event => [event.kind, event])).values()]
    .sort((a, b) => priority(a.kind) - priority(b.kind));
  const selected = representatives.slice(0, MAX_TEST_FAILURES);
  for (const event of ranked)
  {
    if (selected.length >= MAX_TEST_FAILURES) break;
    if (!selected.includes(event)) selected.push(event);
  }
  return selected.sort((a, b) => a.startOffset - b.startOffset || priority(a.kind) - priority(b.kind));
}

function mergeRanges(ranges)
{
  const merged = [];
  for (const range of ranges.sort((a, b) => a.start - b.start))
  {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({...range});
  }
  return merged;
}

export function collectConsoleEvidence(value, maxCharacters = MAX_CONSOLE_CHARACTERS)
{
  const raw = `${value ?? ""}`;
  const lines = readLines(raw);
  const allEvents = findEvents(lines);
  const events = selectEvents(allEvents);
  const budget = Math.max(0, Math.floor(maxCharacters));
  const windowCount = events.length + 1;
  const windowSize = Math.min(MAX_LOG_CHARACTERS, Math.max(0, Math.floor((budget - windowCount + 1) / windowCount)));
  const ranges = events.map(event =>
  {
    const lineIndex = event.line - 1;
    const contextStart = lines[Math.max(0, lineIndex - 1)].start;
    const contextEnd = lines[Math.min(lines.length - 1, lineIndex + 1)].end;
    const start = Math.max(contextStart, event.startOffset - Math.floor(windowSize / 4));
    return {start, end: Math.min(contextEnd, start + windowSize)};
  });
  const tailSize = events.length === 0 ? budget : windowSize;
  ranges.push({start: Math.max(0, raw.length - tailSize), end: raw.length});
  const retainedRanges = (raw.length <= budget ? [{start: 0, end: raw.length}] : mergeRanges(ranges))
    .map(range =>
    {
      // Keep UTF-8 byte counts meaningful when a window boundary intersects a surrogate pair.
      if (range.start > 0 && /[\uDC00-\uDFFF]/.test(raw[range.start] ?? "")) range.start++;
      if (range.end < raw.length && /[\uD800-\uDBFF]/.test(raw[range.end - 1] ?? "")) range.end--;
      return range;
    })
    .filter(range => range.end > range.start);
  const excerpts = retainedRanges.map(range =>
  {
    const startLine = lines.findIndex(line => line.end > range.start);
    const endLine = lines.findLastIndex(line => line.start < range.end);
    return {
      startLine: startLine + 1,
      endLine: endLine + 1,
      startOffset: range.start,
      endOffset: range.end,
      partialStartLine: range.start > lines[startLine].start,
      partialEndLine: range.end < lines[endLine].end,
      text: raw.slice(range.start, range.end)
    };
  });
  const coveredLines = new Set(excerpts.flatMap(excerpt =>
    Array.from({length: excerpt.endLine - excerpt.startLine + 1}, (_, index) => excerpt.startLine + index)));
  const retainedRawCharacters = excerpts.reduce((sum, excerpt) => sum + excerpt.text.length, 0);
  const retainedBytes = excerpts.reduce((sum, excerpt) => sum + Buffer.byteLength(excerpt.text, "utf8"), 0);
  const excerpt = excerpts.map(range => range.text).join("\n");
  return {
    schemaVersion: 1,
    selection: "full-console-diagnostic-context-and-tail",
    offsetUnit: "utf16-code-units",
    lineNumbers: "1-based",
    endOffsets: "exclusive",
    excerptFormat: "raw-console",
    eventTextFormat: "normalized-diagnostic",
    excerpt,
    excerpts,
    events,
    rawTotalCharacters: raw.length,
    rawTotalBytes: Buffer.byteLength(raw, "utf8"),
    rawTotalLines: lines.length,
    retainedCharacters: excerpt.length,
    retainedRawCharacters,
    retainedBytes,
    retainedLines: coveredLines.size,
    omittedCharacters: raw.length - retainedRawCharacters,
    omittedBytes: Buffer.byteLength(raw, "utf8") - retainedBytes,
    omittedLines: lines.length - coveredLines.size,
    totalEvents: allEvents.length,
    omittedEvents: allEvents.length - events.length,
    truncated: retainedRawCharacters < raw.length || events.length < allEvents.length || events.some(event => event.truncated)
  };
}
