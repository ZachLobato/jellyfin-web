import { describe, expect, it } from 'vitest';

import { normalizeSpeechText, prepareTextForSentenceSplit } from './ttsReader';

describe('prepareTextForSentenceSplit', () => {
    it('protects dotted numeric dates from sentence splitting', () => {
        const text = '* 1.5.1735 | 22.5.1819 The admiral';

        expect(prepareTextForSentenceSplit(text))
            .toBe('* 1/5/1735 | 22/5/1819 The admiral');
    });
});

describe('normalizeSpeechText', () => {
    it('reads asterism section separators as a section boundary', () => {
        const text = '* * * I have seen the Black Sea from all sides,';

        expect(normalizeSpeechText(text))
            .toBe('Next section. I have seen the Black Sea from all sides,');
    });

    it('reads dashed section separators as a section boundary', () => {
        const text = '--- I have seen the Black Sea from all sides,';

        expect(normalizeSpeechText(text))
            .toBe('Next section. I have seen the Black Sea from all sides,');
    });

    it('adds a readable pause to numeric date ranges', () => {
        const text = '* 1/5/1735 | 22/5/1819 The admiral';

        expect(normalizeSpeechText(text))
            .toBe('May 1, 1735 to May 22, 1819. The admiral');
    });
});
