const TTS_WS_URL = `ws://${window.location.hostname}:7878`;

const SENTENCE_RE = /[^.!?]+[.!?]["""'''"]?\s*|[^.!?]+$/g;

function splitSentences(text) {
    return (text.match(SENTENCE_RE) || []).map(s => s.trim()).filter(Boolean);
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
        this.reset(0);
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

        // 'rendered' fires only when a new section/chapter view is created — NOT on
        // column turns within a section. Use it for per-section setup (CSS injection)
        // and stale-node refresh on re-render; page-advance continuation lives in
        // _relocatedHandler below, since 'relocated' fires on every page turn.
        this._renderedHandler = () => {
            this._injectHighlightCss();
            // Skip while a page turn is in flight — the continuation runs on 'relocated'
            // and the old page's sentences must not be processed against the new DOM.
            if (!this.isActive || this._awaitingNextPage) return;

            if (!this.allSentences.length) return;
            const fresh = this._extractPageSentences();
            const byText = new Map(fresh.map(s => [s.text, s.nodes]));
            for (const s of this.allSentences) {
                const freshNodes = byText.get(s.text);
                if (freshNodes) s.nodes = freshNodes;
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
            if (!this.isPaused) {
                this._sendCurrentPage();
                if (this.allSentences.length > 0) {
                    this._highlightSentence(this.currentIndex);
                }
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
        this._audioQueue.resume();
        // If queue exhausted during pause, re-request from server
        if (!this._audioQueue._playing && this._audioQueue._buffers.size === 0) {
            this._sendSentences(this.allSentences, this.currentIndex);
        }
    }

    jumpBack(n = 1) {
        if (!this.isActive) return;
        const idx = this.currentIndex - n;
        if (idx < 0) {
            if (this._awaitingNextPage) return;
            this._wsSend({ type: 'stop' });
            this._audioQueue.reset(0);
            this._clearHighlights();
            this._awaitingNextPage = true;
            // Resume at the LAST sentence of the previous page, not its first, so
            // jump-back steps sentence by sentence across the boundary.
            this._startAtPageEnd = true;
            this.rendition.prev().catch(() => {
                this.isActive = false;
                this._awaitingNextPage = false;
                this._startAtPageEnd = false;
            });
        } else {
            this.isPaused = false;
            this._clearHighlights();
            this._highlightSentence(idx);
            this._audioQueue.reset(idx);
            this._sendSentences(this.allSentences, idx);
        }
    }

    jumpForward(n = 1) {
        if (!this.isActive) return;
        const target = this.currentIndex + n;
        if (target >= this.allSentences.length) {
            if (this._awaitingNextPage) return;
            this._wsSend({ type: 'stop' });
            this._audioQueue.reset(this.allSentences.length);
            this._onPageDone();
        } else {
            this.isPaused = false;
            this._clearHighlights();
            this._highlightSentence(target);
            this._audioQueue.reset(target);
            this._sendSentences(this.allSentences, target);
        }
    }

    // ─── Internal ──────────────────────────────────────────────────────────────

    _sendCurrentPage() {
        const sentences = this._extractPageSentences();

        // Discard carry-over — start at the first complete sentence on the current page
        this._carryOverText = '';
        this._carryOverNodes = [];

        // Drop trailing incomplete sentence (continues onto next page)
        if (sentences.length > 0) {
            const last = sentences[sentences.length - 1];
            if (!/[.!?]$/.test(last.text.trim())) {
                sentences.pop();
            }
        }

        this.allSentences = sentences;

        let idx;
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
        this._sentStartIndex = idx;
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

        // Reconnect if the WebSocket was closed (e.g. by a prior 'stop' message)
        if (!this.ws || this.ws.readyState !== 1) {
            this._reconnectAndSpeak(sentences, idx);
            return;
        }

        this._wsSend({
            type: 'speak',
            sentences: sentences.map(s => s.text),
            startIndex: idx
        });

        this._injectHighlightCss();
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

    _extractPageSentences() {
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
        const scrollX = epubContainer?.scrollLeft ?? 0;

        const visibleNodes = this._getVisibleTextNodes(doc, containerWidth, containerHeight, scrollX);

        const nodeRanges = [];
        let fullText = '';
        for (const node of visibleNodes) {
            const start = fullText.length;
            const chunk = node.textContent.replace(/\s+/g, ' ').trim();
            if (!chunk) continue;
            fullText += chunk + ' ';
            const leadingWhiteSpace = node.textContent.length - node.textContent.trimStart().length;
            nodeRanges.push({ node, start, end: fullText.length, chunkLength: chunk.length, leadingWhiteSpace });
        }

        fullText = fullText.trim();

        const rawSentences = [];
        let match;
        const re = new RegExp(SENTENCE_RE.source, 'g');
        while ((match = re.exec(fullText)) !== null) {
            const text = match[0].trim();
            if (!text) continue;
            const sentStart = match.index;
            const sentEnd = sentStart + match[0].length;
            rawSentences.push({ text, sentStart, sentEnd });
        }

        const sentenceNodes = rawSentences.map(() => []);

        for (const nr of nodeRanges) {
            const overlapping = rawSentences
                .map((s, i) => ({ ...s, sentIndex: i }))
                .filter(s => s.sentStart < nr.end && s.sentEnd > nr.start);

            if (overlapping.length === 0) continue;

            if (overlapping.length === 1) {
                sentenceNodes[overlapping[0].sentIndex].push(nr.node);
                continue;
            }

            // Node spans multiple sentences — split at each sentence boundary
            let currentNode = nr.node;
            let currentOffset = 0;

            for (let si = 0; si < overlapping.length; si++) {
                const s = overlapping[si];
                const isLast = si === overlapping.length - 1;

                if (isLast) {
                    sentenceNodes[s.sentIndex].push(currentNode);
                } else {
                    const sentEndInOriginal = nr.leadingWhiteSpace + Math.min(s.sentEnd - nr.start, nr.chunkLength);
                    const splitAt = sentEndInOriginal - currentOffset;

                    if (splitAt > 0 && splitAt < currentNode.textContent.length) {
                        const nextNode = currentNode.splitText(splitAt);
                        sentenceNodes[s.sentIndex].push(currentNode);
                        currentNode = nextNode;
                        currentOffset = sentEndInOriginal;
                    } else {
                        sentenceNodes[s.sentIndex].push(currentNode);
                        break;
                    }
                }
            }
        }

        const result = rawSentences.map((s, i) => ({ text: s.text, nodes: sentenceNodes[i] }));

        // Drop leading cross-page fragment: if the first sentence's first node starts before
        // the current page's left edge, it's a continuation from the previous page.
        if (result.length > 0 && result[0].nodes.length > 0) {
            try {
                const r = doc.createRange();
                r.selectNode(result[0].nodes[0]);
                if (r.getBoundingClientRect().left < scrollX) {
                    result.shift();
                }
            } catch {}
        }

        return result;
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
                '.tts-highlight {',
                '  background-color: rgba(255, 220, 0, 0.45);',
                '  border-radius: 2px;',
                '  transition: background-color 0.15s ease;',
                '}',
                '.tts-highlight-next {',
                '  background-color: rgba(204, 176, 0, 0.35);',
                '  border-radius: 2px;',
                '}'
            ].join('\n');
            doc.head.appendChild(style);
        }
    }

    _highlightSentence(absoluteIndex) {
        this._clearHighlights();
        this._wrapNodes(absoluteIndex, 'tts-highlight');
        this._wrapNodes(absoluteIndex + 1, 'tts-highlight-next');
    }

    _wrapNodes(absoluteIndex, className) {
        const sentence = this.allSentences[absoluteIndex];
        if (!sentence?.nodes?.length) return;

        const contents = this.rendition.getContents();
        if (!contents?.length) return;
        const doc = contents[0]?.document;
        if (!doc) return;

        for (const node of sentence.nodes) {
            if (!doc.contains(node) || !node.parentNode) continue;
            const span = doc.createElement('span');
            span.className = className;
            node.parentNode.insertBefore(span, node);
            span.appendChild(node);
        }
    }

    _clearHighlights() {
        const contents = this.rendition.getContents();
        if (!contents) return;

        for (const content of contents) {
            const doc = content?.document;
            if (!doc) continue;

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
