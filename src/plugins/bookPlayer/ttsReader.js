const TTS_WS_URL = `ws://${window.location.hostname}:7878`;

const SENTENCE_RE = /[^.!?]+[.!?]["""'''"]?\s*|[^.!?]+$/g;
const NUMERIC_DATE_RE = /\b(\d{1,2})\.(\d{1,2})\.(\d{2,4})\b/g;
const SECTION_BREAK_RE = /(^|\s)(?:(?:\*\s*){3,}|(?:[-–—]\s*){3,})(?=\s|$)/g;
const DATE_RANGE_SEPARATOR_RE = /(\b\d{1,2}\/\d{1,2}\/\d{2,4})\s*[|–—-]\s*(\d{1,2}\/\d{1,2}\/\d{2,4}\b)/g;
const LEADING_DATE_MARKER_RE = /(^|\s)\*\s+(?=\d{1,2}\/\d{1,2}\/\d{2,4}\b)/g;
const DATE_SPEECH_RE = /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/g;
const SENTENCE_TERMINATOR_RE = /[.!?]["”'’)]*$/;
const NEXT_PAGE_LOOKAHEAD_SENTENCE_COUNT = 2;
const MONTH_NAMES = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December'
];

function splitSentences(text) {
    return (text.match(SENTENCE_RE) || []).map(s => s.trim()).filter(Boolean);
}

export function prepareTextForSentenceSplit(text) {
    return text.replace(NUMERIC_DATE_RE, '$1/$2/$3');
}

export function normalizeSpeechText(text) {
    return text
        .replace(SECTION_BREAK_RE, '$1... ...Next Chapter Section... ...')
        .replace(LEADING_DATE_MARKER_RE, '$1')
        .replace(DATE_RANGE_SEPARATOR_RE, '$1 to $2. ')
        .replace(DATE_SPEECH_RE, (_match, day, month, year) => {
            const monthName = MONTH_NAMES[Number(month) - 1];
            return monthName ? `${monthName} ${Number(day)}, ${year}` : `${day}/${month}/${year}`;
        })
        .replace(/\s+/g, ' ')
        .trim();
}

class BrowserAudioQueue {
    constructor(onHighlight, onAllDone) {
        this._ctx = null;
        this._buffers = new Map(); // absIndex → AudioBuffer
        this._nextIndex = 0;
        this._playing = false;
        this._currentSource = null;
        this._doneReceived = false;
        this._stopped = false;
        this._onHighlight = onHighlight;
        this._onAllDone = onAllDone;
    }

    reset(startIndex) {
        this._stopped = false;
        this._doneReceived = false;
        this._buffers.clear();
        this._nextIndex = startIndex;
        if (this._currentSource) {
            try { this._currentSource.stop(); } catch (_) {}
            this._currentSource = null;
        }
        this._playing = false;
    }

    add(absIndex, audioB64) {
        if (this._stopped) return;
        const ctx = this._ensureCtx();
        const bytes = Uint8Array.from(atob(audioB64), c => c.charCodeAt(0));
        ctx.decodeAudioData(bytes.buffer.slice(0)).then(buffer => {
            this._buffers.set(absIndex, buffer);
            if (!this._playing) this._playNext();
        }).catch(err => console.error('[TTS] decode error:', err));
    }

    _playNext() {
        if (this._stopped) return;
        const buffer = this._buffers.get(this._nextIndex);
        if (!buffer) {
            this._playing = false;
            if (this._doneReceived) this._onAllDone?.();
            return;
        }
        this._buffers.delete(this._nextIndex);
        this._playing = true;

        const ctx = this._ensureCtx();
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        this._currentSource = source;

        this._onHighlight(this._nextIndex);
        this._nextIndex++;
        source.start();
        source.onended = () => {
            this._currentSource = null;
            this._playNext();
        };
    }

    markDone() {
        this._doneReceived = true;
        if (!this._playing && this._buffers.size === 0) {
            this._onAllDone?.();
        }
    }

    stop() {
        this._stopped = true;
        this._doneReceived = false;
        this._buffers.clear();
        this._nextIndex = 0;
        if (this._currentSource) {
            try { this._currentSource.stop(); } catch (_) {}
            this._currentSource = null;
        }
        this._playing = false;
        if (this._ctx) {
            this._ctx.close().catch(() => {});
            this._ctx = null;
        }
    }

    pause() { this._ctx?.suspend(); }
    resume() { this._ctx?.resume(); }

    _ensureCtx() {
        if (!this._ctx || this._ctx.state === 'closed') {
            this._ctx = new AudioContext();
        }
        return this._ctx;
    }
}

/**
 * Manages real-time TTS reading for an epub.js rendition.
 *
 * Lifecycle:
 *   const reader = new TtsReader(rendition);
 *   reader.start();     // connects and begins reading current page
 *   reader.pause();
 *   reader.resume();
 *   reader.jumpBack(3);
 *   reader.jumpForward(3);
 *   reader.stop();      // cleans up everything
 */
class TtsReader {
    constructor(rendition) {
        this.rendition = rendition;
        this.ws = null;

        this.allSentences = [];
        this.currentIndex = 0;
        this._sentStartIndex = 0;

        this.isPaused = false;
        this.isActive = false;

        this._carryOverText = '';
        this._carryOverNodes = [];
        this._emptyRetried = false;
        this._awaitingNextPage = false;
        this._startAtPageEnd = false;
        this._skipSentencesOnNextPageTexts = [];

        // 'rendered' fires only when a new section/chapter view is created — NOT on
        // column turns within a section. Use it for per-section setup (CSS injection)
        // and stale-node refresh on re-render; page-advance continuation lives in
        // _relocatedHandler below, since 'relocated' fires on every page turn.
        this._renderedHandler = () => {
            this._injectHighlightCss();
            // Skip while a page turn is in flight — the continuation runs on 'relocated'
            // and the old page's sentences must not be processed against the new DOM.
            if (!this.isActive || this._awaitingNextPage || this.isPaused) return;

            if (!this.allSentences.length) return;
            const fresh = this._extractPageSentences();
            const byText = new Map(fresh.map(s => [s.text, s.ranges]));
            for (const s of this.allSentences) {
                const freshRanges = byText.get(s.text);
                if (freshRanges) s.ranges = freshRanges;
            }
            if (this.currentIndex < this.allSentences.length) {
                this._highlightSentence(this.currentIndex);
            }
        };

        // 'relocated' fires on every location change, including column turns within a
        // chapter — so it reliably resumes reading after _onPageDone()/jumpBack/jumpForward
        // navigate, whether the turn crosses a chapter boundary or not. By this point
        // epub.js has updated scrollLeft, so _extractPageSentences sees the new page.
        this._relocatedHandler = () => {
            if (!this.isActive || !this._awaitingNextPage) return;
            this._awaitingNextPage = false;
            this._sendCurrentPage(!this.isPaused);
            if (this.allSentences.length > 0) {
                this._highlightSentence(this.currentIndex);
            }
        };

        this._audioQueue = new BrowserAudioQueue(
            (absIndex) => {
                this.currentIndex = absIndex;
                this._highlightSentence(absIndex);
            },
            () => {
                if (this.isActive && !this.isPaused && !this._awaitingNextPage) this._onPageDone();
            }
        );
    }

    // ─── Public API ────────────────────────────────────────────────────────────

    start(startIndex = 0) {
        this._initialStartIndex = startIndex;
        this.isActive = true;

        this.ws = new WebSocket(TTS_WS_URL);
        this.ws.onopen = () => this._sendCurrentPage();
        this.ws.onmessage = (e) => this._onMessage(e);
        this.ws.onerror = () => {
            console.error('[TTS] Could not connect — is tts_server.py running?');
        };
        this.ws.onclose = () => {
            if (this.isActive) console.warn('[TTS] WebSocket closed unexpectedly');
        };

        this.rendition.on('rendered', this._renderedHandler);
        this.rendition.on('relocated', this._relocatedHandler);
    }

    stop() {
        this.isActive = false;
        this.isPaused = false;
        this._carryOverText = '';
        this._carryOverNodes = [];
        this._startAtPageEnd = false;
        this._skipSentencesOnNextPageTexts = [];

        this._audioQueue.stop();
        this.rendition.off('rendered', this._renderedHandler);
        this.rendition.off('relocated', this._relocatedHandler);

        if (this.ws) {
            if (this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ type: 'stop' }));
                this.ws.close();
            }
            this.ws = null;
        }

        this._clearHighlights();
    }

    pause() {
        if (!this.isActive || this.isPaused) return;
        this.isPaused = true;
        this._wsSend({ type: 'stop' });
        this._audioQueue.pause();
    }

    resume() {
        if (!this.isActive || !this.isPaused) return;
        this.isPaused = false;
        this.refreshHighlight();
        this._audioQueue.resume();
        // If queue exhausted during pause, re-request from server
        if (!this._audioQueue._playing && this._audioQueue._buffers.size === 0) {
            this._sendSentences(this.allSentences, this.currentIndex);
        }
    }

    jumpBack(n = 1) {
        if (!this.isActive) return Promise.resolve();
        const idx = this.currentIndex - n;
        if (idx < 0) {
            if (this._awaitingNextPage) return Promise.resolve();
            this._wsSend({ type: 'stop' });
            this._audioQueue.reset(0);
            this._clearHighlights();
            this._awaitingNextPage = true;
            // Resume at the LAST sentence of the previous page, not its first, so
            // jump-back steps sentence by sentence across the boundary.
            this._startAtPageEnd = true;
            return this.rendition.prev().catch(() => {
                this.isActive = false;
                this._awaitingNextPage = false;
                this._startAtPageEnd = false;
            });
        } else {
            this._wsSend({ type: 'stop' });
            this._clearHighlights();
            this._highlightSentence(idx);
            this._audioQueue.reset(idx);
            this.currentIndex = idx;
            if (!this.isPaused) {
                this._sendSentences(this.allSentences, idx);
            }
        }
        return Promise.resolve();
    }

    jumpForward(n = 1) {
        if (!this.isActive) return Promise.resolve();
        const target = this.currentIndex + n;
        if (target >= this.allSentences.length) {
            if (this._awaitingNextPage) return Promise.resolve();
            this._wsSend({ type: 'stop' });
            this._audioQueue.reset(this.allSentences.length);
            return this._onPageDone();
        } else {
            this._wsSend({ type: 'stop' });
            this._clearHighlights();
            this._highlightSentence(target);
            this._audioQueue.reset(target);
            this.currentIndex = target;
            if (!this.isPaused) {
                this._sendSentences(this.allSentences, target);
            }
        }
        return Promise.resolve();
    }

    refreshHighlight() {
        if (!this.isActive || !this.allSentences.length) return;

        const fresh = this._extractPageSentences();
        const byText = new Map(fresh.map(s => [s.text, s.ranges]));
        for (const sentence of this.allSentences) {
            const freshRanges = byText.get(sentence.text);
            if (freshRanges) sentence.ranges = freshRanges;
        }

        this._injectHighlightCss();
        if (this.currentIndex < this.allSentences.length) {
            this._highlightSentence(this.currentIndex);
        }
    }

    // ─── Internal ──────────────────────────────────────────────────────────────

    _sendCurrentPage(speak = true) {
        let sentences = this._extractPageSentences();
        if (this._skipSentencesOnNextPageTexts.length > 0 && sentences.length > 0) {
            sentences = this._dropSpokenLookAheadSentences(sentences);
            if (sentences.length === 0 && this.isActive && !this.isPaused && speak) {
                setTimeout(() => {
                    if (this.isActive && !this.isPaused && !this._awaitingNextPage) {
                        this._onPageDone();
                    }
                }, 0);
                return;
            }
        }

        // Start from the text visible on the current page. Page breaks in ebooks
        // often split a sentence or end a line with punctuation other than .!?;
        // keeping those fragments prevents TTS from skipping visible page text.
        this._carryOverText = '';
        this._carryOverNodes = [];

        this.allSentences = sentences;

        let idx;
        const allowLookAhead = !this._startAtPageEnd;
        if (this._startAtPageEnd && sentences.length > 0) {
            // Resumed via a backward jump — start at the LAST sentence of this
            // (previous) page so jump-back steps sentence by sentence, not page by page.
            idx = sentences.length - 1;
            this._startAtPageEnd = false;
        } else {
            idx = this._initialStartIndex ?? 0;
        }
        this._initialStartIndex = 0; // only applies to the first page
        this.currentIndex = idx;
        this._audioQueue.reset(idx);

        if (sentences.length === 0) {
            if (this.isActive && !this.isPaused && !this._emptyRetried) {
                this._emptyRetried = true;
                setTimeout(() => {
                    if (this.isActive && !this.isPaused) this._sendCurrentPage();
                }, 200);
            } else {
                this._emptyRetried = false;
                this.isActive = false;
            }
            return;
        }
        this._emptyRetried = false;
        this._injectHighlightCss();

        if (!speak || this.isPaused) {
            if (sentences.length > 0) {
                this._highlightSentence(idx);
            }
            return;
        }

        const speakSentences = allowLookAhead ?
            this._mergeNextPageLookAhead(sentences) :
            sentences;
        this.allSentences = speakSentences;
        const serverStartIndex = idx;
        this._sentStartIndex = serverStartIndex;

        // Reconnect if the WebSocket was closed (e.g. by a prior 'stop' message)
        if (!this.ws || this.ws.readyState !== 1) {
            this._reconnectAndSpeak(speakSentences, serverStartIndex);
            return;
        }

        this._wsSend({
            type: 'speak',
            sentences: speakSentences.map(s => s.text),
            startIndex: serverStartIndex
        });
    }

    _reconnectAndSpeak(sentences, startIndex) {
        if (this.ws) {
            this.ws.onopen = null;
            this.ws.onmessage = null;
            this.ws.onerror = null;
            this.ws.onclose = null;
            this.ws.close();
            this.ws = null;
        }
        this.ws = new WebSocket(TTS_WS_URL);
        this.ws.onopen = () => {
            if (!this.isActive) return;
            this._wsSend({ type: 'speak', sentences: sentences.map(s => s.text), startIndex });
            this._injectHighlightCss();
        };
        this.ws.onmessage = (e) => this._onMessage(e);
        this.ws.onerror = () => {
            console.error('[TTS] Could not connect — is tts_server.py running?');
        };
        this.ws.onclose = () => {
            if (this.isActive) console.warn('[TTS] WebSocket closed unexpectedly');
        };
    }

    _sendSentences(sentences, startIndex) {
        this._audioQueue.reset(startIndex);
        this._sentStartIndex = startIndex;
        this.currentIndex = startIndex;
        this.allSentences = sentences;
        this._wsSend({
            type: 'speak',
            sentences: sentences.map(s => s.text),
            startIndex
        });
    }

    _dropSpokenLookAheadSentences(sentences) {
        const skippedTexts = this._skipSentencesOnNextPageTexts;
        this._skipSentencesOnNextPageTexts = [];

        let nextSentences = sentences;
        for (const skippedText of skippedTexts) {
            if (nextSentences[0]?.text !== skippedText) break;
            nextSentences = nextSentences.slice(1);
        }

        return nextSentences;
    }

    _mergeNextPageLookAhead(sentences) {
        if (!sentences.length) return sentences;

        const lastCurrent = sentences[sentences.length - 1];
        if (!lastCurrent || SENTENCE_TERMINATOR_RE.test(lastCurrent.text)) {
            return sentences;
        }

        const lookAheadSentences = this._extractPageSentences(1)
            .slice(0, NEXT_PAGE_LOOKAHEAD_SENTENCE_COUNT);
        const firstNext = lookAheadSentences[0];
        if (!firstNext) return sentences;

        this._skipSentencesOnNextPageTexts = lookAheadSentences.map(s => s.text);
        const merged = {
            text: `${lastCurrent.text} ${firstNext.text}`,
            ranges: lastCurrent.ranges.concat(firstNext.ranges)
        };

        return sentences.slice(0, -1).concat(merged, lookAheadSentences.slice(1));
    }

    _extractPageSentences(pageOffset = 0) {
        const contents = this.rendition.getContents();
        if (!contents?.length) return [];

        const currentLoc = this.rendition.currentLocation()?.start;
        const currentHref = currentLoc?.href;
        const content = currentHref ?
            (contents.find(c => {
                const h = c.section?.href ?? c.href ?? '';
                return h === currentHref
                    || h.endsWith('/' + currentHref)
                    || currentHref.endsWith('/' + h);
            }) ?? contents[0]) :
            contents[0];

        const doc = content?.document;
        if (!doc) return [];

        // epub.js navigates columns by setting epubContainer.scrollLeft (confirmed from source).
        // Reading scrollLeft directly gives the exact column offset without any arithmetic on
        // displayed.page * containerWidth, which breaks when containerWidth is wrong.
        const epubContainer = document.querySelector('.epub-container');
        const containerWidth = epubContainer ? epubContainer.clientWidth : window.innerWidth;
        const containerHeight = epubContainer ? epubContainer.clientHeight : window.innerHeight;
        const scrollX = (epubContainer?.scrollLeft ?? 0) + (containerWidth * pageOffset);

        const visibleNodes = this._getVisibleTextNodes(doc, containerWidth, containerHeight, scrollX);

        let fullText = '';
        const textMap = [];
        for (const node of visibleNodes) {
            const result = this._appendMappedText(fullText, textMap, node, doc, containerWidth, containerHeight, scrollX);
            fullText = result.fullText;
        }

        while (fullText.endsWith(' ')) {
            fullText = fullText.slice(0, -1);
            textMap.pop();
        }

        fullText = prepareTextForSentenceSplit(fullText);

        const rawSentences = [];
        let match;
        const re = new RegExp(SENTENCE_RE.source, 'g');
        while ((match = re.exec(fullText)) !== null) {
            const text = normalizeSpeechText(match[0]);
            if (!text) continue;
            const sentStart = match.index;
            const sentEnd = sentStart + match[0].length;
            rawSentences.push({ text, sentStart, sentEnd });
        }

        const result = rawSentences.map(s => ({
            text: s.text,
            ranges: this._getMappedRanges(textMap, s.sentStart, s.sentEnd)
        }));

        // Drop leading cross-page fragment: if the first sentence's first node starts before
        // the current page's left edge, it's a continuation from the previous page.
        if (result.length > 0 && result[0].ranges.length > 0) {
            try {
                const range = this._createDomRange(doc, result[0].ranges[0]);
                if (range?.getBoundingClientRect().left < scrollX) {
                    result.shift();
                }
            } catch {}
        }

        return result;
    }

    _appendMappedText(fullText, textMap, node, doc, containerWidth, containerHeight, scrollX) {
        const sourceText = node.textContent;
        let hasText = false;

        for (let offset = 0; offset < sourceText.length; offset++) {
            if (!this._isTextOffsetVisible(doc, node, offset, containerWidth, containerHeight, scrollX)) {
                continue;
            }

            const char = sourceText[offset];
            const isWhiteSpace = /\s/.test(char);

            if (isWhiteSpace) {
                if (hasText && !fullText.endsWith(' ')) {
                    fullText += ' ';
                    textMap.push({ node, offset });
                }
                continue;
            }

            if (!hasText && fullText && !fullText.endsWith(' ')) {
                fullText += ' ';
                textMap.push({ node, offset });
            }

            fullText += char;
            textMap.push({ node, offset });
            hasText = true;
        }

        return { fullText };
    }

    _isTextOffsetVisible(doc, node, offset, containerWidth, containerHeight, scrollX) {
        try {
            const range = doc.createRange();
            range.setStart(node, offset);
            range.setEnd(node, offset + 1);

            return Array.from(range.getClientRects()).some(rect => (
                rect.width >= 0
                && rect.height > 0
                && rect.right > scrollX
                && rect.left < scrollX + containerWidth
                && rect.bottom > 0
                && rect.top < containerHeight
            ));
        } catch {
            return false;
        }
    }

    _getMappedRanges(textMap, start, end) {
        const ranges = [];
        let current = null;

        while (start < end && /\s/.test(textMap[start]?.node?.textContent?.[textMap[start].offset] ?? '')) {
            start++;
        }

        while (end > start && /\s/.test(textMap[end - 1]?.node?.textContent?.[textMap[end - 1].offset] ?? '')) {
            end--;
        }

        for (let i = start; i < end; i++) {
            const mapped = textMap[i];
            if (!mapped) continue;

            if (
                current
                && current.node === mapped.node
                && current.endOffset === mapped.offset
            ) {
                current.endOffset = mapped.offset + 1;
            } else {
                current = {
                    node: mapped.node,
                    startOffset: mapped.offset,
                    endOffset: mapped.offset + 1
                };
                ranges.push(current);
            }
        }

        return ranges;
    }

    _getVisibleTextNodes(doc, containerWidth, containerHeight, scrollX = 0) {
        const nodes = [];
        const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, null);

        let node;
        while ((node = walker.nextNode())) {
            if (!node.textContent.trim()) continue;

            const parentTag = node.parentElement?.tagName?.toLowerCase();
            if (parentTag === 'script' || parentTag === 'style') continue;

            try {
                const range = doc.createRange();
                range.selectNode(node);
                const rect = range.getBoundingClientRect();

                if (
                    rect.width > 0
                    && rect.height > 0
                    && rect.right > scrollX
                    && rect.left < scrollX + containerWidth
                    && rect.bottom > 0
                    && rect.top < containerHeight
                ) {
                    nodes.push(node);
                }
            } catch {
                // getBoundingClientRect can fail on detached nodes; skip
            }
        }

        return nodes;
    }

    _injectHighlightCss() {
        const contents = this.rendition.getContents();
        if (!contents?.length) return;

        for (const content of contents) {
            const doc = content?.document;
            if (!doc || doc.getElementById('tts-highlight-style')) continue;

            const style = doc.createElement('style');
            style.id = 'tts-highlight-style';
            style.textContent = [
                '.tts-highlight-overlay-root {',
                '  position: absolute;',
                '  left: 0;',
                '  top: 0;',
                '  width: 0;',
                '  height: 0;',
                '  pointer-events: none;',
                '  z-index: 2147483647;',
                '}',
                '.tts-highlight-rect {',
                '  position: absolute;',
                '  border-radius: 2px;',
                '  transition: background-color 0.15s ease;',
                '}',
                '.tts-highlight-rect.tts-highlight {',
                '  background-color: rgba(255, 220, 0, 0.45);',
                '}',
                '.tts-highlight-rect.tts-highlight-next {',
                '  background-color: rgba(204, 176, 0, 0.35);',
                '}'
            ].join('\n');
            doc.head.appendChild(style);
        }
    }

    _highlightSentence(absoluteIndex) {
        this._clearHighlights();
        this._paintRangeHighlights(absoluteIndex, 'tts-highlight');
        this._paintRangeHighlights(absoluteIndex + 1, 'tts-highlight-next');
    }

    _paintRangeHighlights(absoluteIndex, className) {
        const sentence = this.allSentences[absoluteIndex];
        if (!sentence?.ranges?.length) return;

        const contents = this.rendition.getContents();
        if (!contents?.length) return;
        const doc = sentence.ranges[0].node?.ownerDocument;
        if (!doc?.body) return;

        const overlayRoot = this._getHighlightOverlayRoot(doc);
        const win = doc.defaultView ?? window;

        for (const rangeInfo of sentence.ranges) {
            const range = this._createDomRange(doc, rangeInfo);
            if (!range) continue;

            for (const rect of range.getClientRects()) {
                if (rect.width <= 0 || rect.height <= 0) continue;

                const highlight = doc.createElement('span');
                highlight.className = `tts-highlight-rect ${className}`;
                highlight.style.left = `${rect.left + win.scrollX}px`;
                highlight.style.top = `${rect.top + win.scrollY}px`;
                highlight.style.width = `${rect.width}px`;
                highlight.style.height = `${rect.height}px`;
                overlayRoot.appendChild(highlight);
            }
        }
    }

    _getHighlightOverlayRoot(doc) {
        let overlayRoot = doc.getElementById('tts-highlight-overlay-root');
        if (!overlayRoot) {
            overlayRoot = doc.createElement('div');
            overlayRoot.id = 'tts-highlight-overlay-root';
            overlayRoot.className = 'tts-highlight-overlay-root';
            doc.body.appendChild(overlayRoot);
        }

        return overlayRoot;
    }

    _createDomRange(doc, rangeInfo) {
        const { node, startOffset, endOffset } = rangeInfo;
        if (!node || !doc.contains(node) || !node.parentNode) return null;
        if (startOffset < 0 || endOffset > node.textContent.length || startOffset >= endOffset) return null;

        try {
            const range = doc.createRange();
            range.setStart(node, startOffset);
            range.setEnd(node, endOffset);
            return range;
        } catch {
            return null;
        }
    }

    _clearHighlights() {
        const contents = this.rendition.getContents();
        if (!contents) return;

        for (const content of contents) {
            const doc = content?.document;
            if (!doc) continue;

            doc.getElementById('tts-highlight-overlay-root')?.remove();

            const spans = doc.querySelectorAll('.tts-highlight, .tts-highlight-next');
            for (const span of spans) {
                const parent = span.parentNode;
                if (!parent) continue;
                while (span.firstChild) {
                    parent.insertBefore(span.firstChild, span);
                }
                parent.removeChild(span);
            }
        }
    }

    _onMessage(event) {
        let msg;
        try {
            msg = JSON.parse(event.data);
        } catch {
            return;
        }

        if (msg.type === 'sentence_start') {
            const absIndex = this._sentStartIndex + msg.index;
            if (msg.audio) {
                this._audioQueue.add(absIndex, msg.audio);
            } else {
                // fallback: server sent no audio (direct-playback path) — just highlight
                this.currentIndex = absIndex;
                this._highlightSentence(absIndex);
            }
        } else if (msg.type === 'done') {
            this._audioQueue.markDone();
        }
    }

    async _onPageDone() {
        this._clearHighlights();
        this._awaitingNextPage = true;
        try {
            await this.rendition.next();
            // _sendCurrentPage() is called from _renderedHandler once epub.js fires
            // 'rendered' — at that point scrollLeft is guaranteed to be updated.
        } catch {
            this.isActive = false;
            this._awaitingNextPage = false;
        }
    }

    _wsSend(msg) {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(msg));
        }
    }
}

export default TtsReader;
